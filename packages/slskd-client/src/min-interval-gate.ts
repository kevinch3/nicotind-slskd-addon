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
    // Chain onto the tail so callers are released in arrival order. The chain
    // must not inherit a rejection, or one failed call would poison the queue —
    // hence the caller's own error is re-thrown separately, below.
    const mine = this.tail.then(() => this.waitTurn());
    this.tail = mine.catch(() => {});
    await mine;
    return fn();
  }

  private async waitTurn(): Promise<void> {
    const due = this.lastStart + this.minIntervalMs;
    const now = this.clock.now();
    if (now < due) await this.clock.sleep(due - now);
    this.lastStart = this.clock.now();
  }
}
