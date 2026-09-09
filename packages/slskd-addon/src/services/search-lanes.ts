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

  async run<T>(priority: LanePriority, fn: () => Promise<T>): Promise<T> {
    if (this.busy) {
      await new Promise<void>((resolve) => this.waiting[priority].push(resolve));
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
