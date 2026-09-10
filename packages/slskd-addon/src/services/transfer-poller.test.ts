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
