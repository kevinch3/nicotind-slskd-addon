import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/addon-sdk';
import type { Slskd } from '@nicotind/slskd-client';
import { referencedByLiveJob, removeDownload, type DownloadFileRef } from './download-files.js';

const log = createLogger('download-retention');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;

export interface DownloadRetentionOptions {
  db: Database;
  downloadsDir: () => string;
  /** Days a downloaded file may sit unreferenced before it is reclaimed. `0` disables the sweep. */
  retentionDays?: () => number;
  intervalMs?: number;
  /**
   * Report what would be deleted without deleting it. The first production
   * cycle runs this way on purpose: once a file is unlinked it is gone, so the
   * safety margin lives in reading a log, not in review.
   */
  dryRun?: boolean;
}

/**
 * Reclaim downloaded files the host will never ask for again (NicotinD#1052).
 *
 * The primary mechanism is the host releasing a job (`DELETE /jobs/:id`), which
 * frees that job's files immediately. This is the backstop for everything that
 * release never covers: a job the host abandoned, one deleted before this
 * addon learned to free files at all, and files whose ledger row was lost.
 *
 * It deliberately does **not** key on job state. The host deletes a job the
 * moment it ingests, so by the time a file is garbage its job is usually gone —
 * measured on kpc, 7 job rows against 2,216 completed downloads. Age plus
 * "nothing live still names it" is the only predicate that survives that.
 */
export class DownloadRetentionService {
  private readonly db: Database;
  private readonly downloadsDir: () => string;
  private readonly retentionDays: () => number;
  private readonly intervalMs: number;
  private readonly dryRun: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(
    private slskd: Slskd,
    options: DownloadRetentionOptions,
  ) {
    this.db = options.db;
    this.downloadsDir = options.downloadsDir;
    this.retentionDays = options.retentionDays ?? (() => DEFAULT_RETENTION_DAYS);
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.dryRun = options.dryRun ?? false;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    void this.sweep();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Public so tests can drive it deterministically. */
  async sweep(): Promise<{ removed: number; bytes: number }> {
    const empty = { removed: 0, bytes: 0 };
    if (this.sweeping) return empty;
    const days = this.retentionDays();
    if (!Number.isFinite(days) || days <= 0) return empty;

    this.sweeping = true;
    try {
      const cutoff = Date.now() - days * 86_400_000;
      const root = this.downloadsDir();

      // A file slskd is still working on must never be touched, however old it
      // looks: a stalled transfer keeps an old mtime while the connection is
      // alive, so mtime alone would delete bytes out from under a live download.
      const active = await this.activeTransferPaths();
      if (active === null) {
        log.debug('skipping the retention sweep — slskd transfers unreadable');
        return empty;
      }

      let removed = 0;
      let bytes = 0;

      // 1. Ledger-backed files: old enough, and nothing live names them.
      const rows = this.db
        .query<
          { username: string; filename: string; relative_path: string; completed_at: number },
          [number]
        >(
          `SELECT username, filename, relative_path, completed_at FROM completed_downloads
           WHERE relative_path IS NOT NULL AND completed_at < ?`,
        )
        .all(cutoff);
      for (const row of rows) {
        if (referencedByLiveJob(this.db, row.username, row.filename)) continue;
        const file: DownloadFileRef = {
          username: row.username,
          filename: row.filename,
          relativePath: row.relative_path,
          absPath: join(root, row.relative_path),
        };
        if (active.has(leafOf(row.relative_path))) continue;
        const age = Math.round((Date.now() - row.completed_at) / 86_400_000);
        // A row whose file is already gone is bookkeeping, not a reclaim. Saying
        // "would release" for it inflates the dry-run report that is supposed to
        // be the safety check, so account for it separately.
        if (!existsSync(file.absPath)) {
          if (!this.dryRun) removeDownload(this.db, root, file, 'ledger row outlived its file');
          continue;
        }
        if (this.dryRun) {
          log.info({ path: row.relative_path, ageDays: age }, 'retention (dry run): would release');
          removed += 1;
          try {
            bytes += statSync(file.absPath).size;
          } catch {
            /* raced with something else; the count is a report, not a ledger */
          }
          continue;
        }
        bytes += removeDownload(this.db, root, file, `unreferenced for ${age}d`);
        removed += 1;
      }

      // 2. Files no ledger row points at. The byte route resolves a path only
      // through `completed_downloads`, so these can never be served — they are
      // unreachable by construction, not merely unused.
      const known = new Set(
        this.db
          .query<{ relative_path: string }, []>(
            `SELECT relative_path FROM completed_downloads WHERE relative_path IS NOT NULL`,
          )
          .all()
          .map((r) => normalizePath(r.relative_path)),
      );
      for (const abs of walkFiles(root)) {
        const rel = normalizePath(relative(root, abs));
        if (known.has(rel) || active.has(leafOf(rel))) continue;
        let mtime: number;
        let size: number;
        try {
          const st = statSync(abs);
          mtime = st.mtimeMs;
          size = st.size;
        } catch {
          continue;
        }
        if (mtime >= cutoff) continue;
        if (this.dryRun) {
          log.info({ path: rel, bytes: size }, 'retention (dry run): would release (no ledger row)');
          removed += 1;
          bytes += size;
          continue;
        }
        bytes += removeDownload(
          this.db,
          root,
          { username: '', filename: '', relativePath: rel, absPath: abs },
          'no ledger row',
        );
        removed += 1;
      }

      // 3. Ledger rows whose path never resolved. These hold no bytes, so they
      // are never an unlink — just dead rows that would otherwise accumulate.
      // Skipped under dryRun: a dry run that writes is not a dry run.
      if (!this.dryRun) {
        this.db.run(
          `DELETE FROM completed_downloads WHERE relative_path IS NULL AND completed_at < ?`,
          [cutoff],
        );
      }

      // Always summarise: a dry run whose only output is per-file logging is not
      // a usable safety check, because a buffered logger can drop those lines at
      // exit. The returned counts are the reliable answer.
      if (removed > 0) {
        log.info(
          { removed, bytes, days, dryRun: this.dryRun },
          this.dryRun ? 'retention sweep (dry run) would reclaim' : 'retention sweep reclaimed downloaded files',
        );
      }
      return { removed, bytes };
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Paths slskd currently has in flight, relative to the downloads dir. `null`
   * means we could not ask — in which case the sweep does nothing at all,
   * because "no live transfers" and "could not check" must not look alike.
   */
  private async activeTransferPaths(): Promise<Set<string> | null> {
    let downloads;
    try {
      downloads = await this.slskd.transfers.getDownloads();
    } catch (err) {
      log.debug({ err }, 'getDownloads failed during retention sweep');
      return null;
    }
    const out = new Set<string>();
    for (const group of downloads) {
      for (const dir of group.directories) {
        for (const file of dir.files) {
          if (String(file.state).startsWith('Completed')) continue;
          // slskd names a transfer by its remote path; the local file keeps the
          // leaf, so match on that rather than on a path we cannot reconstruct.
          const leaf = leafOf(file.filename);
          if (leaf) out.add(leaf);
        }
      }
    }
    return out;
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * The leaf filename, which is the only part a slskd transfer and its landed
 * file reliably share: slskd names a transfer by its *remote* path, and the
 * local file keeps just the leaf under a folder of slskd's choosing.
 */
function leafOf(p: string): string {
  return normalizePath(p).split('/').pop() ?? '';
}

/** Every file under `dir`, recursively. Missing/unreadable folders yield nothing. */
function walkFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) =>
    e.isDirectory() ? walkFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}
