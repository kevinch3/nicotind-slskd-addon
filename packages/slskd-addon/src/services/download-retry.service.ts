import { createLogger } from '@nicotind/addon-sdk';
import type { Slskd, SlskdTransfer } from '@nicotind/slskd-client';
import type { Database } from 'bun:sqlite';
import { getDatabase } from '../db.js';
import { ACTIVE_STATES } from './album-fallback.service.js';
import { normalizeBasename } from './track-pick.js';
import { pruneRests, restPeer, restingPeers } from './peer-rest.js';
import {
  classifyFailure,
  MAX_REST_MS,
  isRetryableTransfer as isRetryable,
  remoteSizeFrom,
  retryPolicyFor,
  type RetryDecision,
  type RetryPolicy,
} from './retry-policy.js';

const log = createLogger('download-retry');

const PRUNE_EVERY_MS = 3_600_000;

interface RetryRow {
  attempts: number;
  last_attempt: number | null;
  gave_up: number;
}

interface AttemptRow {
  id: number;
  failure_class: string;
  decision: RetryDecision['action'];
  delay_ms: number | null;
  failed_at: number;
  retried_at: number | null;
  source_offline: number;
  outcome: string | null;
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
 * 0.26+ resumes the partial file (0.25.1 restarted at byte 0) — gives up, which leaves
 * the transfer in Error for cross-peer fallback (AlbumFallbackService) to move
 * to an alternate, or defers: the fallback may move it now, the peer rests, and
 * the file comes back here if nobody delivered it. Every failure is kept in
 * `transfer_attempts`.
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
      const resting = restingPeers(this.db, now);
      // slskd keeps every transfer until removed (8,080 listed on kpc): touch
      // the database only for the files it has rows for, and build the
      // delivered set only if a come-back is due.
      const retryKeys = this.keys('SELECT transfer_key FROM transfer_retries');
      const openRetried = this.keys(
        'SELECT transfer_key FROM transfer_attempts WHERE outcome IS NULL AND retried_at IS NOT NULL',
      );
      let delivered: Set<string> | null = null;
      const deliveredNow = () => (delivered ??= deliveredBasenames(downloads));

      for (const group of downloads) {
        const username = group.username;
        for (const dir of group.directories) {
          for (const file of dir.files) {
            const key = `${username}::${file.filename}`;

            if (file.state === 'Completed, Succeeded') {
              if (openRetried.has(key)) this.closeRetried(key, 'succeeded');
              if (retryKeys.has(key)) {
                this.db.run('DELETE FROM transfer_retries WHERE transfer_key = ?', [key]);
              }
              continue;
            }

            if (!isRetryable(file.state, file.exception)) continue;
            if (hiddenIds.has(file.id)) continue;
            // A slskd that retries downloads itself has this one in hand.
            if (file.nextAttemptAt && Date.parse(file.nextAttemptAt) > now) continue;

            const row = this.getRow(key);
            const retriesSoFar = row?.attempts ?? 0;
            if (row?.gave_up) {
              await this.comeBack(username, file, key, retriesSoFar, { ready, now, deliveredNow });
              continue;
            }

            const attempt = this.observe(username, dir.directory, file, key, retriesSoFar, !ready, now);
            // Already re-enqueued; slskd has not swapped in the new transfer yet.
            if (attempt.retried_at !== null) continue;

            if (attempt.decision === 'give-up') {
              this.markGaveUp(key, username, file.filename);
              this.setOutcome(attempt.id, 'gave-up');
              log.warn({ key, retriesSoFar }, 'Giving up on this peer — leaving the transfer for fallback');
              continue;
            }

            if (attempt.decision === 'defer') {
              const restMs = attempt.delay_ms ?? 0;
              this.markGaveUp(key, username, file.filename);
              restPeer(this.db, username, now + restMs, 'deferred');
              resting.add(username);
              log.info({ key, restMs }, 'Resting this peer — the fallback may try another first');
              continue;
            }

            if (!ready) continue;
            if (resting.has(username)) continue;
            if (now - attempt.failed_at < (attempt.delay_ms ?? 0)) continue;

            const free = attempt.source_offline || attempt.failure_class === 'shutdown';
            const spent = retriesSoFar + (free ? 0 : 1);
            await this.retry(username, file, key, spent, attempt.id, now);
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
   * A deferred file whose rest is over comes back to its peer — unless another
   * peer has delivered it (or is delivering it), or no open job wants this file
   * any more. Checked only when the rest ends, so an alternate copy that fails
   * mid-rest does not cost the come-back.
   */
  private async comeBack(
    username: string,
    file: SlskdTransfer,
    key: string,
    retriesSoFar: number,
    at: { ready: boolean; now: number; deliveredNow: () => Set<string> },
  ): Promise<void> {
    const attempt = this.attemptFor(key, file.id);
    if (attempt?.decision !== 'defer' || attempt.retried_at !== null || attempt.outcome !== null) {
      return;
    }
    if (at.now - attempt.failed_at < (attempt.delay_ms ?? 0)) return;
    if (at.deliveredNow().has(normalizeBasename(file.filename))) {
      this.setOutcome(attempt.id, 'covered');
      return;
    }
    if (!this.wantedByOpenJob(username, file.filename)) {
      this.setOutcome(attempt.id, 'not-needed');
      return;
    }
    if (!at.ready) return;
    this.db.run('UPDATE transfer_retries SET gave_up = 0 WHERE transfer_key = ?', [key]);
    await this.retry(username, file, key, retriesSoFar + 1, attempt.id, at.now);
    log.info({ key }, 'Back to a rested peer — nobody else delivered the file');
  }

  /**
   * The ledger row for this failure, deciding it on first sight. A failure seen
   * while Soulseek is offline, or caused by slskd shutting down, is not put to
   * the policy: it gets one free retry (once the source is back), because the
   * outage, not the peer, is its likely cause. A refused enqueue leaves slskd's
   * record as it was, so the same failure is decided afresh.
   */
  private observe(
    username: string,
    directory: string,
    file: SlskdTransfer,
    key: string,
    retriesSoFar: number,
    offline: boolean,
    now: number,
  ): AttemptRow {
    const existing = this.attemptFor(key, file.id);
    if (existing && existing.outcome !== 'enqueue-failed') return existing;

    // A new failure for this file means the previous retry failed too.
    this.closeRetried(key, 'failed');

    const failureClass = classifyFailure(file.state, file.exception);
    const decision: RetryDecision =
      offline || failureClass === 'shutdown'
        ? { action: 'retry', delayMs: 0 }
        : this.policy(failureClass, retriesSoFar);
    const delayMs =
      decision.action === 'retry'
        ? decision.delayMs
        : decision.action === 'defer'
          ? Math.min(decision.restMs, MAX_REST_MS)
          : null;
    this.db.run(
      `INSERT INTO transfer_attempts (transfer_key, transfer_id, username, filename, directory, state,
         exception, failure_class, retries_before, source_attempts, source_offline, decision,
         delay_ms, failed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        key,
        file.id,
        username,
        file.filename,
        directory,
        file.state,
        file.exception ?? null,
        failureClass,
        retriesSoFar,
        file.attempts || null,
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
        sourceAttempts: file.attempts || null,
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
    // No cancel first: slskd 0.25.1 supersedes a finished record on enqueue,
    // and a cancel followed by a refused enqueue stranded the file as
    // Cancelled, which nothing retries.
    this.recordAttempt(key, username, file.filename, spent, now);
    this.db.run('UPDATE transfer_attempts SET retried_at = ? WHERE id = ?', [now, attemptId]);
    try {
      // A size-mismatch abort is re-asked at the size the peer now reports.
      const size = remoteSizeFrom(file.exception) ?? file.size;
      await this.slskd.transfers.enqueue(username, [{ filename: file.filename, size }]);
    } catch (err) {
      // The attempt still counts (the peer refused it), and the failure is
      // decided again next sweep.
      this.setOutcome(attemptId, 'enqueue-failed');
      log.warn({ key, attempt: spent, err }, 'Re-enqueue refused; deciding again next sweep');
      return;
    }
    log.info({ key, attempt: spent }, 'Re-enqueued failed transfer');
  }

  private attemptFor(key: string, transferId: string): AttemptRow | null {
    return this.db
      .query(
        `SELECT id, failure_class, decision, delay_ms, failed_at, retried_at, source_offline, outcome
         FROM transfer_attempts WHERE transfer_key = ? AND transfer_id = ?
         ORDER BY id DESC LIMIT 1`,
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
    pruneRests(this.db, now);
  }

  /**
   * Does an open protocol job still have an item pointing at this exact file?
   * A released job is deleted, a cancelled or finished one is closed, and a
   * fallback repoint moves the item to the alternate's file.
   */
  private wantedByOpenJob(username: string, filename: string): boolean {
    return !!this.db
      .query(
        `SELECT 1 FROM addon_job_items i JOIN addon_jobs j ON j.id = i.job_id
         WHERE i.username = ? AND i.filename = ? AND j.state = 'active' LIMIT 1`,
      )
      .get(username, filename);
  }

  private keys(sql: string): Set<string> {
    const rows = this.db.query(sql).all() as Array<{ transfer_key: string }>;
    return new Set(rows.map((r) => r.transfer_key));
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

/** Basenames delivered or on their way from any peer — the fallback's own rule. */
function deliveredBasenames(
  downloads: Awaited<ReturnType<Slskd['transfers']['getDownloads']>>,
): Set<string> {
  const out = new Set<string>();
  for (const group of downloads) {
    for (const dir of group.directories) {
      for (const file of dir.files) {
        if (file.state === 'Completed, Succeeded' || ACTIVE_STATES.has(file.state)) {
          out.add(normalizeBasename(file.filename));
        }
      }
    }
  }
  return out;
}
