/** Injectable clock, so the gate's timing is testable without real waiting. */
export interface GateClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: GateClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Serializes calls and guarantees a minimum gap between the **starts** of two
 * consecutive ones.
 *
 * Pacing by start, not by completion, is deliberate: what a remote server rate-
 * limits is how fast requests *arrive*, and pacing by completion would add our
 * own latency to every gap — throttling hardest exactly when the server is
 * already slow.
 *
 * Serialization is free here rather than a cost: slskd guards `POST /searches`
 * with a `SemaphoreSlim(1, 1)` and returns 429 for anything concurrent, so
 * overlapping creates were never doing useful work.
 */
export class MinIntervalGate {
  /** Resolves when the previously queued call has been released. */
  private tail: Promise<void> = Promise.resolve();
  private lastStart = -Infinity;

  constructor(
    private readonly minIntervalMs: number,
    private readonly clock: GateClock = realClock,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // The queued work must include `fn` itself, not just the wait before it.
    // Chaining only the wait leaves every call free to overlap the moment its
    // turn arrives — which at interval 0 is immediately, so the gate would
    // serialize nothing at all.
    const result = this.tail.then(async () => {
      await this.waitTurn();
      return fn();
    });
    // The chain must not inherit a rejection, or one failed call would poison
    // the queue for every caller behind it; `result` still rejects for its own.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async waitTurn(): Promise<void> {
    const due = this.lastStart + this.minIntervalMs;
    const now = this.clock.now();
    if (now < due) await this.clock.sleep(due - now);
    this.lastStart = this.clock.now();
  }
}
