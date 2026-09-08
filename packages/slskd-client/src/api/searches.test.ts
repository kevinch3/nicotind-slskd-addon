import { describe, expect, it } from 'bun:test';
import { SearchesApi, DEFAULT_SEARCH_MIN_INTERVAL_MS } from './searches.js';
import type { SlskdClient } from '../client.js';

/** A client that reports the peak number of overlapping requests it saw. */
function trackingClient() {
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    request: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { id: 's', state: 'Completed' };
    },
  } as unknown as SlskdClient;
  return { client, peak: () => maxInFlight };
}

describe('SearchesApi', () => {
  // slskd guards POST /searches with SemaphoreSlim(1,1) and 429s anything
  // concurrent: measured on prod, concurrency 3 got 74% of creates refused.
  it('serializes creates by default, so slskd never sees a concurrent one', async () => {
    const { client, peak } = trackingClient();
    const api = new SearchesApi(client);
    await Promise.all(['a', 'b', 'c', 'd'].map((q) => api.create(q)));
    expect(peak()).toBe(1);
  });

  // The disconnect hypothesis was tested and rejected (#1046, p = 0.66), so
  // spacing is off: it would cost ~12s per hunt to buy nothing.
  it('adds no delay by default', async () => {
    expect(DEFAULT_SEARCH_MIN_INTERVAL_MS).toBe(0);
    const { client } = trackingClient();
    const api = new SearchesApi(client);
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 4 }, (_, i) => api.create(`q${i}`)));
    // 4 x 5ms of serialized work, with no pacing added on top.
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('still paces when an interval is configured, so the dial stays usable', async () => {
    const { client } = trackingClient();
    const api = new SearchesApi(client, 40);
    const t0 = Date.now();
    await Promise.all([api.create('a'), api.create('b'), api.create('c')]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });
});
