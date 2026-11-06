import { createLogger } from '@nicotind/addon-sdk';
import type { Slskd, SlskdTransfer } from '@nicotind/slskd-client';
import type { Database } from 'bun:sqlite';
import { getDatabase } from '../db.js';
import {
  classifyFailure,
  retryPolicyFor,
  type RetryDecision,
  type RetryPolicy,
} from './retry-policy.js';

const log = createLogger('download-retry');

// slskd transfer states that mean the transfer died mid-flight or was rejected.
// We do NOT retry 'Completed, Cancelled' — that's a deliberate user action.
const RETRYABLE_SUFFIXES = ['Errored', 'TimedOut', 'Rejected'];

function isRetryable(state: string): boolean {
  return RETRYABLE_SUFFIXES.some((s) => state === `Completed, ${s}`);
}

const PRUNE_EVERY_MS = 3_600_000;

interface RetryRow {
  attempts: number;
  last_attempt: number | null;
  gave_up: number;
}

interface AttemptRow {
  id: number;
  decision: RetryDecision['action'];
  delay_ms: number | null;
  failed_at: number;
  retried_at: number | null;
  source_offline: number;
}

export interface DownloadRetryOptions {
  db?: Database;
  intervalMs?: number;
  /** What to do with a failure, by its reason. Defaults to `retryPolicyFor`. */
  policy?: RetryPolicy;
  /**
   * Is Soulseek logged in? While it is not, nothing is re-enqueued, and a
   * failure first seen then gets a free retry once it is back.
   */
  isSourceReady?: () => Promise<boolean>;
  /** How long `transfer_attempts` keeps a failure. */
  attemptRetentionMs?: number;
  now?: () => number;
  /** Called once per tick after the retry sweep — lets the fallback layer act on given-up transfers. */
  onSweep?: () => Promise<void> | void;
}

/**
 * Self-healing reconciler. Polls slskd for failed transfers and, per the retry
 * policy for the failure's reason, re-enqueues them on the same peer — slskd
 * keeps the partial `.incomplete` file and resumes it — or gives up, which
 * leaves the transfer in Error for cross-peer fallback (AlbumFallbackService)
 * to move to an alternate. Every failure is kept in `transfer_attempts`.
 * See docs/download-retries.md.
 */
export class DownloadRetryService {
  private slskd: Slskd;
  private db: Database;
  private intervalMs: number;
  private policy: RetryPolicy;
  private isSourceReady: (() => Promise<boolean>) | null;
  private attemptRetentionMs: number;
  private now: () => number;
  private onSweep?: () => Promise<void> | void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private lastPruneAt = -Infinity;

  constructor(slskd: Slskd, options: DownloadRetryOptions = {}) {
    this.slskd = slskd;
    this.db = options.db ?? getDatabase();
    this.intervalMs = options.intervalMs ?? 15_000;
    this.policy = options.policy ?? retryPolicyFor;
    this.isSourceReady = options.isSourceReady ?? null;
    this.attemptRetentionMs = options.attemptRetentionMs ?? 90 * 86_400_000;
    this.now = options.now ?? Date.now;
    this.onSweep = options.onSweep;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs }, 'Starting download retry reconciler');
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    void this.sweep();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One reconciliation pass. Public so tests can drive it deterministically. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      let downloads;
      try {
        downloads = await this.slskd.transfers.getDownloads();
      } catch (err) {
        log.debug({ err }, 'getDownloads failed during retry sweep');
        return;
      }

      const ready = this.isSourceReady ? await this.isSourceReady() : true;
      const hiddenIds = this.hiddenIds();
      const now = this.now();

      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            const key = `${group.username}::${file.filename}`;

            if (file.state === 'Completed, Succeeded') {
              this.closeRetried(key, 'succeeded');
              this.db.run('DELETE FROM transfer_retries WHERE transfer_key = ?', [key]);
              continue;
            }

            if (!isRetryable(file.state)) continue;
            if (hiddenIds.has(file.id)) continue;

            const row = this.getRow(key);
            if (row?.gave_up) continue;
            const retriesSoFar = row?.attempts ?? 0;

            const attempt = this.observe(group.username, file, key, retriesSoFar, !ready, now);
            // Already re-enqueued; slskd has not swapped in the new transfer yet.
            if (attempt.retried_at !== null) continue;

            if (attempt.decision === 'give-up') {
              this.markGaveUp(key, group.username, file.filename);
              this.setOutcome(attempt.id, 'gave-up');
              log.warn({ key, retriesSoFar }, 'Giving up on this peer — leaving the transfer for fallback');
              continue;
            }

            if (!ready) continue;
            if (now - attempt.failed_at < (attempt.delay_ms ?? 0)) continue;

            const spent = retriesSoFar + (attempt.source_offline ? 0 : 1);
            await this.retry(group.username, file, key, spent, attempt.id, now);
          }
        }
      }

      this.prune(now);
    } finally {
      this.sweeping = false;
    }

    if (this.onSweep) {
      try {
        await this.onSweep();
      } catch (err) {
        log.warn({ err }, 'onSweep hook failed');
      }
    }
  }

  /**
   * The ledger row for this failure, deciding it on first sight. A failure seen
   * while Soulseek is offline is not put to the policy: it gets one free retry
   * once the source is back, because the outage, not the peer, is its likely
   * cause.
   */
  private observe(
    username: string,
    file: SlskdTransfer,
    key: string,
    retriesSoFar: number,
    offline: boolean,
    now: number,
  ): AttemptRow {
    const existing = this.attemptFor(key, file.id);
    if (existing) return existing;

    // A new failure for this file means the previous retry failed too.
    this.closeRetried(key, 'failed');

    const failureClass = classifyFailure(file.state, file.exception);
    const decision: RetryDecision = offline
      ? { action: 'retry', delayMs: 0 }
      : this.policy(failureClass, retriesSoFar);
    const delayMs = decision.action === 'retry' ? decision.delayMs : null;
    this.db.run(
      `INSERT INTO transfer_attempts (transfer_key, transfer_id, username, filename, state, exception,
         failure_class, retries_before, source_offline, decision, delay_ms, failed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key,
        file.id,
        username,
        file.filename,
        file.state,
        file.exception ?? null,
        failureClass,
        retriesSoFar,
        offline ? 1 : 0,
        decision.action,
        delayMs,
        now,
      ],
    );
    log.info(
      {
        key,
        state: file.state,
        exception: file.exception ?? null,
        failureClass,
        retriesSoFar,
        sourceOffline: offline,
        decision: decision.action,
        delayMs,
      },
      'Transfer failed',
    );
    return this.attemptFor(key, file.id)!;
  }

  private async retry(
    username: string,
    file: SlskdTransfer,
    key: string,
    spent: number,
    attemptId: number,
    now: number,
  ): Promise<void> {
    // Clear the dead transfer record first, then re-enqueue. slskd resumes the
    // partial `.incomplete` file rather than starting over.
    await this.slskd.transfers.cancel(username, file.id).catch(() => {});
    try {
      await this.slskd.transfers.enqueue(username, [{ filename: file.filename, size: file.size }]);
    } catch (err) {
      log.warn({ key, err }, 'Re-enqueue failed; will retry next sweep');
      // Still record the attempt so the cap applies.
    }
    this.recordAttempt(key, username, file.filename, spent, now);
    this.db.run('UPDATE transfer_attempts SET retried_at = ? WHERE id = ?', [now, attemptId]);
    log.info({ key, attempt: spent }, 'Re-enqueued failed transfer');
  }

  private attemptFor(key: string, transferId: string): AttemptRow | null {
    return this.db
      .query(
        `SELECT id, decision, delay_ms, failed_at, retried_at, source_offline
         FROM transfer_attempts WHERE transfer_key = ? AND transfer_id = ?`,
      )
      .get(key, transferId) as AttemptRow | null;
  }

  /** Settle the open, re-enqueued failure of this file, if there is one. */
  private closeRetried(key: string, outcome: 'succeeded' | 'failed'): void {
    this.db.run(
      `UPDATE transfer_attempts SET outcome = ?
       WHERE transfer_key = ? AND outcome IS NULL AND retried_at IS NOT NULL`,
      [outcome, key],
    );
  }

  private setOutcome(id: number, outcome: string): void {
    this.db.run('UPDATE transfer_attempts SET outcome = ? WHERE id = ?', [outcome, id]);
  }

  private prune(now: number): void {
    if (now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    this.db.run('DELETE FROM transfer_attempts WHERE failed_at < ?', [now - this.attemptRetentionMs]);
  }

  private hiddenIds(): Set<string> {
    const rows = this.db.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  private getRow(key: string): RetryRow | undefined {
    return this.db
      .query('SELECT attempts, last_attempt, gave_up FROM transfer_retries WHERE transfer_key = ?')
      .get(key) as RetryRow | undefined;
  }

  private recordAttempt(
    key: string,
    username: string,
    filename: string,
    attempts: number,
    now: number,
  ): void {
    this.db.run(
      `INSERT INTO transfer_retries (transfer_key, username, filename, attempts, last_attempt, gave_up)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(transfer_key) DO UPDATE SET attempts = excluded.attempts, last_attempt = excluded.last_attempt`,
      [key, username, filename, attempts, now],
    );
  }

  /** An upsert: a give-up on a file's first failure has no retry row to update yet. */
  private markGaveUp(key: string, username: string, filename: string): void {
    this.db.run(
      `INSERT INTO transfer_retries (transfer_key, username, filename, attempts, gave_up)
       VALUES (?, ?, ?, 0, 1)
       ON CONFLICT(transfer_key) DO UPDATE SET gave_up = 1`,
      [key, username, filename],
    );
  }
}
