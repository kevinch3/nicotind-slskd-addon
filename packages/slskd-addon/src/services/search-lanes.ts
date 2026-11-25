/**
 * One search session at a time (NicotinD#1049).
 *
 * slskd's embedded Soulseek.NET client runs at most **two** searches concurrently
 * (`maximumConcurrentSearches = 2`, which slskd does not expose); every further
 * search sits in `Queued` until a lane frees, and a lane is held for the whole
 * per-search timeout. Measured on prod: a second hunt started while another hunt
 * or a fallback wave held both lanes got zero responses inside its own deadline
 * and was reported as "no confident match".
 *
 * So sessions are serialized here instead of interleaved there. A session is
 * the unit that plans its own lane use (an album hunt's two-query wave, a
 * track's single search). `user` sessions go ahead of `background` ones: a
 * curator waiting on a modal outranks the fallback sweep, which has all night.
 */
export type LanePriority = 'user' | 'background';

export class SearchLanes {
  private readonly waiting: Record<LanePriority, Array<() => void>> = { user: [], background: [] };
  private busy = false;

  /** Sessions waiting for the lanes, all priorities. */
  get pending(): number {
    return this.waiting.user.length + this.waiting.background.length;
  }

  get active(): boolean {
    return this.busy;
  }

  /**
   * `signal` is the caller's: once it aborts, a session still waiting leaves the
   * queue and never takes the lanes. A host that timed out a hunt has already
   * discarded its answer, so running it would only delay every session behind
   * it (#24).
   */
  async run<T>(priority: LanePriority, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.busy) {
      await new Promise<void>((resolve, reject) => {
        const queue = this.waiting[priority];
        const onAbort = () => {
          const at = queue.indexOf(take);
          if (at >= 0) queue.splice(at, 1);
          reject(signal!.reason);
        };
        const take = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        queue.push(take);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.busy = true;
    try {
      return await fn();
    } finally {
      // Hand the lanes straight to the next waiter; `busy` only drops when there
      // is nobody, so a session that starts between two microtasks cannot slip in.
      const next = this.waiting.user.shift() ?? this.waiting.background.shift();
      if (next) next();
      else this.busy = false;
    }
  }
}
