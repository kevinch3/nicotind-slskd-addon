/**
 * What to do with a failed transfer, by why it failed (#26).
 *
 * `classifyFailure` turns slskd's `exception` text into a class; the policy
 * turns a class into a decision. `DownloadRetryService` asks once per failure
 * and stores the answer in `transfer_attempts`, so a randomized policy draws
 * one delay per failure, not one per sweep. See docs/download-retries.md.
 */
export type FailureClass =
  | 'not-shared'
  | 'peer-busy'
  | 'timeout'
  | 'connection'
  /** slskd was restarted under the transfer. Never put to the policy: a free retry. */
  | 'shutdown'
  | 'other';

export type RetryDecision =
  /** Re-enqueue on the same peer once `delayMs` has passed since the failure was seen. */
  | { action: 'retry'; delayMs: number }
  /** Stop retrying this peer; the album fallback moves the track to an alternate. */
  | { action: 'give-up' }
  /**
   * Another peer first, then come back: the fallback may move the track now,
   * this peer rests for `restMs` (no retry or fallback reaches it meanwhile),
   * and if nobody has delivered the file when the rest ends it is retried here.
   */
  | { action: 'defer'; restMs: number };

/**
 * The longest rest a defer gets. A judgment bound, not slskd's: 0.25.1 keeps
 * every transfer until something removes it. It keeps a policy from parking a
 * peer — which every album's fallback then passes over — for days.
 */
export const MAX_REST_MS = 2 * 3_600_000;

/**
 * @param reason        the failure's class
 * @param retriesSoFar  same-peer retries already spent on this file (a retry of a
 *                      failure seen while Soulseek was offline costs none)
 */
export type RetryPolicy = (reason: FailureClass, retriesSoFar: number) => RetryDecision;

const PATTERNS: Array<[FailureClass, RegExp]> = [
  ['shutdown', /application shut down/i],
  ['not-shared', /not shared/i],
  ['peer-busy', /too many (files|megabytes)|overwhelmed|try again later/i],
  ['timeout', /timed out|timeout|time limit/i],
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
 * Three moves, by what they cost (docs/download-retries.md "Choosing a move"):
 * - retry: keeps this peer, but the album's fallback waits for the whole delay.
 * - give-up: the fallback moves the track now, to a recorded alternate first
 *   (no search) and a background search only when none has it.
 * - defer: the fallback moves the track now, this peer rests, and the track
 *   comes back here if nobody delivered it — the move for a peer that asked
 *   us to back off.
 *
 * Until this is written it keeps the pre-#26 rule: a first retry at once,
 * then 60 s apart, three in all.
 */
export const retryPolicyFor: RetryPolicy = (_reason, retriesSoFar) =>
  retriesSoFar < 3
    ? { action: 'retry', delayMs: retriesSoFar === 0 ? 0 : 60_000 }
    : { action: 'give-up' };
