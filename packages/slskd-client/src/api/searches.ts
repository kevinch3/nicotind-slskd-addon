import type { SlskdSearch, SlskdSearchResponse } from '../types.js';
import type { SlskdClient } from '../client.js';
import { MinIntervalGate } from '../min-interval-gate.js';

/**
 * Default gap between search submissions: **none**.
 *
 * A live A/B on prod (NicotinD#1046) tested whether submission rate provokes the
 * Soulseek server into closing the connection. It does not: 2/20 vs 3/19 trials
 * dropped, Fisher exact p = 0.66, at a combined 12.8% per burst that matches the
 * 13.5% seen in production — so the run reproduced the phenomenon and still
 * found no difference. Spacing would cost ~12s per hunt to buy nothing.
 *
 * The gate is kept for its serialization, which the same run *did* justify, and
 * the interval stays configurable so the question can be re-opened with data
 * rather than by re-editing code.
 */
export const DEFAULT_SEARCH_MIN_INTERVAL_MS = 0;

export class SearchesApi {
  private readonly gate: MinIntervalGate;

  constructor(
    private client: SlskdClient,
    searchMinIntervalMs: number = DEFAULT_SEARCH_MIN_INTERVAL_MS,
  ) {
    this.gate = new MinIntervalGate(searchMinIntervalMs);
  }

  /**
   * Submit a search, serialized against every other caller.
   *
   * slskd guards `POST /searches` with a `SemaphoreSlim(1, 1)` and returns 429
   * to anything concurrent, so overlapping creates were never doing useful work.
   * Measured on prod (NicotinD#1046): firing 12 queries at the album hunter's
   * concurrency of 3 got **74% of them refused** (178 of 240), while serialized
   * submission had 2 refusals in 228. The old shape relied on 429-retry to claw
   * those back — round trips that exist only to be rejected, and queries that
   * silently vanish once the retries run out.
   *
   * It lives **here**, at the single choke point, rather than in the album
   * hunter: what slskd serializes is the sum of every caller (album hunt, skew
   * phase, track hunter, cross-peer fallback, raw search route), so a limit any
   * one of them can sidestep is not a limit.
   *
   * This is explicitly **not** a fix for the Soulseek disconnects — that
   * hypothesis was tested and rejected (see `DEFAULT_SEARCH_MIN_INTERVAL_MS`).
   * It cannot be, either: because slskd serializes for us, our submissions to
   * the network were never concurrent in the first place.
   */
  async create(searchText: string): Promise<SlskdSearch> {
    return this.gate.run(() =>
      this.client.request<SlskdSearch>('/searches', {
        method: 'POST',
        body: JSON.stringify({ id: crypto.randomUUID(), searchText }),
      }),
    );
  }

  async get(id: string): Promise<SlskdSearch> {
    return this.client.request<SlskdSearch>(`/searches/${id}`);
  }

  async getResponses(id: string): Promise<SlskdSearchResponse[]> {
    const raw = await this.client.request<unknown>(`/searches/${id}/responses`);
    if (!Array.isArray(raw)) {
      throw new Error(`Unexpected search responses: expected array, got ${typeof raw}`);
    }
    return raw as SlskdSearchResponse[];
  }

  async list(): Promise<SlskdSearch[]> {
    return this.client.request<SlskdSearch[]>('/searches');
  }

  async cancel(id: string): Promise<void> {
    await this.client.request(`/searches/${id}`, { method: 'PUT' });
  }

  async delete(id: string): Promise<void> {
    await this.client.request(`/searches/${id}`, { method: 'DELETE' });
  }
}
