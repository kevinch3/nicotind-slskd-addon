/**
 * What to do with a failed transfer, by why it failed (#26).
 *
 * `classifyFailure` turns slskd's `exception` text into a class; the policy
 * turns a class into a decision. `DownloadRetryService` asks once per failure
 * and stores the answer in `transfer_attempts`, so a randomized policy draws
 * one delay per failure, not one per sweep. See docs/download-retries.md.
 */
export type FailureClass = 'not-shared' | 'peer-busy' | 'timeout' | 'connection' | 'other';

export type RetryDecision =
  /** Re-enqueue on the same peer once `delayMs` has passed since the failure was seen. */
  | { action: 'retry'; delayMs: number }
  /** Stop retrying this peer; the album fallback moves the track to an alternate. */
  | { action: 'give-up' };

/**
 * @param reason        the failure's class
 * @param retriesSoFar  same-peer retries already spent on this file (a retry of a
 *                      failure seen while Soulseek was offline costs none)
 */
export type RetryPolicy = (reason: FailureClass, retriesSoFar: number) => RetryDecision;

const PATTERNS: Array<[FailureClass, RegExp]> = [
  ['not-shared', /not shared/i],
  ['peer-busy', /too many (files|megabytes)|overwhelmed|try again later/i],
  ['timeout', /timed out|timeout/i],
  ['connection', /connection|connect|refused|unreachable/i],
];

export function classifyFailure(state: string, exception: string | null | undefined): FailureClass {
  if (exception) {
    for (const [cls, re] of PATTERNS) if (re.test(exception)) return cls;
    return 'other';
  }
  return state === 'Completed, TimedOut' ? 'timeout' : 'other';
}

/**
 * TODO(owner, #26): the retry table. Measured on kpc, 48 h to 2026-11-05:
 *   not-shared 564 · timeout 118 · peer-busy 130 (Overwhelmed 66 + Too many 64)
 *   and of 122 transfers retried on the same peer, 8 recovered (7%).
 *
 * The trade-off is peer patience against moving on: a give-up hands the track
 * to the album fallback, which searches for another peer (a search costs lane
 * time, and an alternate may be lower quality); a retry keeps the slot this
 * peer already gave us, but every minute it waits is a minute the album is
 * incomplete.
 *
 * Until this is written it keeps today's reason-blind rule: 3 retries, 60 s.
 */
export const retryPolicyFor: RetryPolicy = (_reason, retriesSoFar) =>
  retriesSoFar < 3 ? { action: 'retry', delayMs: 60_000 } : { action: 'give-up' };
