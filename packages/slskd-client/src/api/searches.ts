import type { SlskdSearch, SlskdSearchResponse } from '../types.js';
import type { SlskdClient } from '../client.js';
import { MinIntervalGate } from '../min-interval-gate.js';

/** Default gap between search submissions. See `create` for the reasoning. */
export const DEFAULT_SEARCH_MIN_INTERVAL_MS = 1000;

export class SearchesApi {
  private readonly gate: MinIntervalGate;

  constructor(
    private client: SlskdClient,
    searchMinIntervalMs: number = DEFAULT_SEARCH_MIN_INTERVAL_MS,
  ) {
    this.gate = new MinIntervalGate(searchMinIntervalMs);
  }

  /**
   * Submit a search, paced so we never exceed one submission per
   * `searchMinIntervalMs`.
   *
   * The pacing lives **here**, at the single choke point, rather than in the
   * album hunter — the rate the Soulseek server sees is the sum of every caller
   * (album hunt, skew phase, track hunter, cross-peer fallback, the raw search
   * route), and a limit any one of them can sidestep is not a limit. Putting it
   * on the client makes exceeding the rate structurally impossible.
   *
   * Why pace at all: NicotinD#1046 measured that 10 of 13 Soulseek outages begin
   * within 2.2s of a completed search and are all server-initiated closes, at a
   * measured peak of 2.43 submissions/sec. That association is strong (baseline
   * 0.20%) but it does **not** prove the rate is the cause — this pacing is the
   * intervention in a controlled experiment, and the metric that settles it is
   * outages per 100 searches, not outages per week.
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
