import { describe, expect, it } from 'bun:test';
import { MinIntervalGate } from './min-interval-gate.js';

/** A gate driven by a virtual clock: `sleep` jumps time instead of waiting. */
function testGate(minIntervalMs: number) {
  let now = 0;
  const gate = new MinIntervalGate(minIntervalMs, {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  });
  return { gate, at: () => now, advance: (ms: number) => (now += ms) };
}

describe('MinIntervalGate', () => {
  it('lets the first call through immediately', async () => {
    const { gate, at } = testGate(1000);
    expect(await gate.run(async () => 'a')).toBe('a');
    expect(at()).toBe(0);
  });

  it('spaces successive calls by at least the minimum interval', async () => {
    const { gate, at } = testGate(1000);
    const starts: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        gate.run(async () => {
          starts.push(at());
        }),
      ),
    );
    expect(starts).toEqual([0, 1000, 2000, 3000]);
  });

  // The whole point: slskd serializes POST /searches behind a SemaphoreSlim(1,1)
  // and 429s anything concurrent, so overlapping creates were never useful.
  it('serializes — never two in flight at once', async () => {
    const { gate } = testGate(1000);
    let inFlight = 0;
    let maxInFlight = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        gate.run(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          inFlight--;
        }),
      ),
    );
    expect(maxInFlight).toBe(1);
  });

  it('does not delay a call that already arrived after the interval', async () => {
    const { gate, at, advance } = testGate(1000);
    await gate.run(async () => {});
    advance(5000);
    const before = at();
    await gate.run(async () => {});
    expect(at()).toBe(before);
  });

  it('keeps the queue moving when a call throws', async () => {
    const { gate, at } = testGate(1000);
    await expect(
      gate.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const seen: number[] = [];
    await gate.run(async () => {
      seen.push(at());
    });
    expect(seen).toEqual([1000]);
  });

  // A zero interval disables the experiment without removing the code path.
  it('is a pass-through (but still serialized) at interval 0', async () => {
    const { gate, at } = testGate(0);
    await Promise.all([1, 2, 3].map(() => gate.run(async () => {})));
    expect(at()).toBe(0);
  });

  it('paces by call START, so a slow call does not add its duration to the gap', async () => {
    // Spacing must track submission rate — the thing the server sees — not how
    // long our own await happened to take.
    const { gate, at, advance } = testGate(1000);
    const starts: number[] = [];
    const p1 = gate.run(async () => {
      starts.push(at());
      advance(2500);
    });
    const p2 = gate.run(async () => {
      starts.push(at());
    });
    await Promise.all([p1, p2]);
    expect(starts).toEqual([0, 2500]);
  });
});
