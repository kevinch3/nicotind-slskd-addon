import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Slskd } from '@nicotind/slskd-client';
import { applySchema } from '../db.js';
import { addJobItems, createAddonJob, markItemsCompletedByTransfer } from './job-store.js';
import { TransferPoller } from './transfer-poller.js';

const FILENAME = 'Shared\\Music\\Album\\01 Song.flac';

function makeSlskd(state: string) {
  return {
    transfers: {
      getDownloads: async () => [
        {
          username: 'peer',
          directories: [
            {
              directory: 'Shared\\Music\\Album',
              fileCount: 1,
              files: [{ id: 'tx1', filename: FILENAME, size: 3, state, endedAt: null }],
            },
          ],
        },
      ],
    },
  } as unknown as Slskd;
}

function item(db: Database) {
  return db
    .query<{ file_ready: number; state: string }, []>(
      `SELECT file_ready, state FROM addon_job_items WHERE job_id = 'j1'`,
    )
    .get()!;
}

describe('TransferPoller — a completion polled before the file lands (#17)', () => {
  it('resolves the file on a later tick and flips the item ready', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    createAddonJob(db, { id: 'j1', intent: 'album', artist: 'A', album: 'B' });
    addJobItems(db, 'j1', [
      { itemId: 't:song', title: 'Song', username: 'peer', filename: FILENAME, size: 3 },
    ]);
    const rootDir = mkdtempSync(join(tmpdir(), 'slskd-dl-'));
    const poller = new TransferPoller(makeSlskd('Completed, Succeeded'), {
      db,
      rootDir,
      // What main.ts does with a completion.
      onCompleted: (files) =>
        markItemsCompletedByTransfer(
          db,
          files.map((f) => ({
            username: f.username,
            filename: f.filename,
            fileReady: f.relativePath !== null,
          })),
        ),
    });

    // slskd says succeeded, but the file is still being moved out of incomplete/.
    await poller.check();
    expect(item(db)).toEqual({ state: 'completed', file_ready: 0 });
    const before = db
      .query<{ updated_at: number }, []>(`SELECT updated_at FROM addon_jobs WHERE id = 'j1'`)
      .get()!.updated_at;

    // The move finishes; the next tick must notice without slskd changing anything.
    mkdirSync(join(rootDir, 'Album'), { recursive: true });
    writeFileSync(join(rootDir, 'Album', '01 Song.flac'), 'abc');
    await new Promise((r) => setTimeout(r, 2));
    await poller.check();

    expect(item(db)).toEqual({ state: 'completed', file_ready: 1 });
    expect(
      db
        .query<{ relative_path: string | null }, []>(
          `SELECT relative_path FROM completed_downloads WHERE username = 'peer'`,
        )
        .get()!.relative_path,
    ).toBe('Album/01 Song.flac');
    // The host polls jobs by updated_at: a ready flag nobody announces is invisible.
    const after = db
      .query<{ updated_at: number }, []>(`SELECT updated_at FROM addon_jobs WHERE id = 'j1'`)
      .get()!.updated_at;
    expect(after).toBeGreaterThan(before);
  });
});

describe('TransferPoller — the late-arrival backlog is swept, not re-read every tick (NicotinD#1137)', () => {
  const DAY = 24 * 3_600_000;
  function setup() {
    const db = new Database(':memory:');
    applySchema(db);
    const rootDir = mkdtempSync(join(tmpdir(), 'slskd-dl-'));
    let clock = 10 * DAY;
    const resolved: string[] = [];
    const poller = new TransferPoller(
      { transfers: { getDownloads: async () => [] } } as unknown as Slskd,
      {
        db,
        rootDir,
        now: () => clock,
        onCompleted: (files) => {
          for (const f of files) resolved.push(f.filename);
        },
      },
    );
    const unresolved = (key: string, filename: string, completedAt: number) =>
      db.run(
        `INSERT INTO completed_downloads (transfer_key, username, directory, filename, relative_path, basename, completed_at)
         VALUES (?, 'peer', 'Shared\\Music\\Album', ?, NULL, ?, ?)`,
        [key, filename, filename.split('\\').pop()!, completedAt],
      );
    const land = (name: string) => {
      mkdirSync(join(rootDir, 'Album'), { recursive: true });
      writeFileSync(join(rootDir, 'Album', name), 'abc');
    };
    return { poller, unresolved, land, resolved, tick: (ms: number) => (clock += ms), now: () => clock };
  }

  it('looks for a young completion on every tick', async () => {
    const h = setup();
    await h.poller.check(); // the start-up sweep
    h.unresolved('k1', 'Shared\\Music\\Album\\01 Young.flac', h.now() - 60_000);
    h.land('01 Young.flac');
    h.tick(5_000);
    await h.poller.check();
    expect(h.resolved).toEqual(['Shared\\Music\\Album\\01 Young.flac']);
  });

  it('looks for an old one only when the sweep comes round', async () => {
    const h = setup();
    h.unresolved('k2', 'Shared\\Music\\Album\\02 Old.flac', h.now() - 2 * DAY);
    await h.poller.check(); // the start-up sweep: not on disk yet
    h.land('02 Old.flac');

    h.tick(5_000);
    await h.poller.check(); // a normal tick does not re-read the backlog
    expect(h.resolved).toEqual([]);

    h.tick(30 * 60_000);
    await h.poller.check(); // the sweep finds it
    expect(h.resolved).toEqual(['Shared\\Music\\Album\\02 Old.flac']);
  });
});
