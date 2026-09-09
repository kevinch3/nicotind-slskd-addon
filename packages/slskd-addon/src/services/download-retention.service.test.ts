import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Slskd } from '@nicotind/slskd-client';
import { applySchema } from '../db.js';
import { DownloadRetentionService } from './download-retention.service.js';

const DAY = 86_400_000;
const dirs: string[] = [];

afterEach(() => {
  // Deletion tests write real files; leaving them behind while fixing a disk
  // leak would be its own small joke.
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'addon-retention-'));
  dirs.push(d);
  return d;
}

/** slskd with no live transfers unless told otherwise. */
function makeSlskd(files: Array<{ username: string; filename: string; state: string }> = []): Slskd {
  return {
    transfers: {
      getDownloads: mock(async () =>
        files.map((f) => ({
          username: f.username,
          directories: [{ directory: 'd', fileCount: 1, files: [{ ...f, id: 'x', size: 1 }] }],
        })),
      ),
    },
  } as unknown as Slskd;
}

function land(
  db: Database,
  root: string,
  opts: { relPath: string; ageDays: number; username?: string; filename?: string },
): string {
  const abs = join(root, opts.relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, 'audio-bytes');
  const when = new Date(Date.now() - opts.ageDays * DAY);
  utimesSync(abs, when, when);
  const username = opts.username ?? 'peer';
  const filename = opts.filename ?? opts.relPath;
  db.run(
    `INSERT INTO completed_downloads
       (transfer_key, username, directory, filename, relative_path, basename, completed_at)
     VALUES (?, ?, 'd', ?, ?, ?, ?)`,
    [
      `${username}:${filename}`,
      username,
      filename,
      opts.relPath,
      opts.relPath.toLowerCase(),
      Date.now() - opts.ageDays * DAY,
    ],
  );
  return abs;
}

function makeDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function service(db: Database, root: string, over: Record<string, unknown> = {}, slskd = makeSlskd()) {
  return new DownloadRetentionService(slskd, {
    db,
    downloadsDir: () => root,
    retentionDays: () => 7,
    ...over,
  });
}

describe('DownloadRetentionService (#1052)', () => {
  it('reclaims an unreferenced file past the window', async () => {
    const db = makeDb();
    const root = makeRoot();
    const abs = land(db, root, { relPath: 'Album/01 One.flac', ageDays: 9 });

    const res = await service(db, root).sweep();

    expect(res.removed).toBe(1);
    expect(existsSync(abs)).toBe(false);
    // The ledger row goes with the bytes — its only job was to find them.
    expect(db.query(`SELECT * FROM completed_downloads`).all()).toHaveLength(0);
  });

  it('keeps a file that is still inside the window', async () => {
    const db = makeDb();
    const root = makeRoot();
    const abs = land(db, root, { relPath: 'Album/01 One.flac', ageDays: 3 });

    expect((await service(db, root).sweep()).removed).toBe(0);
    expect(existsSync(abs)).toBe(true);
  });

  it('keeps a file a live job item still names, however old', async () => {
    const db = makeDb();
    const root = makeRoot();
    const abs = land(db, root, { relPath: 'Album/01 One.flac', ageDays: 40 });
    db.run(`INSERT INTO addon_jobs (id, intent, state, created_at, updated_at) VALUES ('j1','album','active',1,1)`);
    db.run(
      `INSERT INTO addon_job_items (job_id, item_id, username, filename, state, file_ready, updated_at)
       VALUES ('j1','t:one','peer','Album/01 One.flac','completed',1,1)`,
    );

    expect((await service(db, root).sweep()).removed).toBe(0);
    expect(existsSync(abs)).toBe(true);
  });

  /**
   * The hazard mtime alone cannot see: a stalled transfer keeps an old mtime
   * while the connection is still alive, so deleting on age would pull bytes
   * out from under a download slskd is still running.
   */
  it('never touches a file slskd still has in flight', async () => {
    const db = makeDb();
    const root = makeRoot();
    const abs = land(db, root, { relPath: 'Album/01 One.flac', ageDays: 40 });
    const slskd = makeSlskd([
      { username: 'peer', filename: 'remote\\Album\\01 One.flac', state: 'InProgress' },
    ]);

    expect((await service(db, root, {}, slskd).sweep()).removed).toBe(0);
    expect(existsSync(abs)).toBe(true);
  });

  it('does nothing at all when slskd cannot be asked', async () => {
    const db = makeDb();
    const root = makeRoot();
    const abs = land(db, root, { relPath: 'Album/01 One.flac', ageDays: 40 });
    const slskd = {
      transfers: { getDownloads: mock(async () => { throw new Error('unreachable'); }) },
    } as unknown as Slskd;

    expect((await service(db, root, {}, slskd).sweep()).removed).toBe(0);
    expect(existsSync(abs)).toBe(true);
  });

  it('reclaims a file no ledger row points at — nothing can ever serve it', async () => {
    const db = makeDb();
    const root = makeRoot();
    const abs = join(root, 'Stray/02 Two.flac');
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'audio-bytes');
    const when = new Date(Date.now() - 30 * DAY);
    utimesSync(abs, when, when);

    expect((await service(db, root).sweep()).removed).toBe(1);
    expect(existsSync(abs)).toBe(false);
  });

  it('prunes the folder a removal empties', async () => {
    const db = makeDb();
    const root = makeRoot();
    land(db, root, { relPath: 'Album/01 One.flac', ageDays: 9 });

    await service(db, root).sweep();

    expect(existsSync(join(root, 'Album'))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('is disabled at 0 days', async () => {
    const db = makeDb();
    const root = makeRoot();
    const abs = land(db, root, { relPath: 'Album/01 One.flac', ageDays: 90 });

    expect((await service(db, root, { retentionDays: () => 0 }).sweep()).removed).toBe(0);
    expect(existsSync(abs)).toBe(true);
  });

  it('a dry run reports without deleting', async () => {
    const db = makeDb();
    const root = makeRoot();
    const abs = land(db, root, { relPath: 'Album/01 One.flac', ageDays: 9 });

    expect((await service(db, root, { dryRun: true }).sweep()).removed).toBe(0);
    expect(existsSync(abs)).toBe(true);
    expect(db.query(`SELECT * FROM completed_downloads`).all()).toHaveLength(1);
  });

  it('a dry run writes nothing at all, not even the dead-row cleanup', async () => {
    const db = makeDb();
    const root = makeRoot();
    db.run(
      `INSERT INTO completed_downloads
         (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES ('k','peer','d','f.flac', NULL, 'f.flac', ?)`,
      [Date.now() - 30 * DAY],
    );

    await service(db, root, { dryRun: true }).sweep();

    // A dry run that writes is not a dry run.
    expect(db.query(`SELECT * FROM completed_downloads`).all()).toHaveLength(1);
  });

  it('does not report a reclaim for a ledger row whose file is already gone', async () => {
    const db = makeDb();
    const root = makeRoot();
    // A row pointing at a path that does not exist: bookkeeping, not bytes.
    db.run(
      `INSERT INTO completed_downloads
         (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES ('k','peer','d','gone.flac','Album/gone.flac','gone.flac', ?)`,
      [Date.now() - 30 * DAY],
    );

    const dry = await service(db, root, { dryRun: true }).sweep();
    expect(dry.removed).toBe(0);
    expect(db.query(`SELECT * FROM completed_downloads`).all()).toHaveLength(1);

    // Applying still reaps the row — it just was never a byte reclaim.
    const res = await service(db, root).sweep();
    expect(res.removed).toBe(0);
    expect(res.bytes).toBe(0);
    expect(db.query(`SELECT * FROM completed_downloads`).all()).toHaveLength(0);
  });

  it('drops a dead ledger row that never resolved a path, without unlinking anything', async () => {
    const db = makeDb();
    const root = makeRoot();
    db.run(
      `INSERT INTO completed_downloads
         (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES ('k','peer','d','f.flac', NULL, 'f.flac', ?)`,
      [Date.now() - 30 * DAY],
    );

    const res = await service(db, root).sweep();

    expect(res.removed).toBe(0);
    expect(db.query(`SELECT * FROM completed_downloads`).all()).toHaveLength(0);
  });
});
