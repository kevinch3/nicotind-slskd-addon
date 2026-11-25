import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  addJobItems,
  addonJobIdForAlbumJob,
  createAddonJob,
  deleteAddonJob,
  getAddonJob,
  itemIdForFile,
  itemIdForTitle,
  listAddonJobs,
  markItemsCompletedByTransfer,
  recomputeJobState,
  repointJobItem,
  setItemState,
  syncItemStatesFromTransfers,
} from './job-store.js';

describe('addon job store', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  function seedAlbumJob(id = 'job-1'): string {
    createAddonJob(db, {
      id,
      intent: 'album',
      artist: 'Artist',
      album: 'Album',
      canonicalTracks: [{ title: 'Song One' }, { title: 'Song Two' }],
      albumJobId: 7,
    });
    addJobItems(db, id, [
      {
        itemId: itemIdForTitle('Song One'),
        title: 'Song One',
        username: 'peer',
        filename: 'dir\\01 Song One.mp3',
        size: 100,
        bitRateKbps: 320,
      },
      {
        itemId: itemIdForTitle('Song Two'),
        title: 'Song Two',
        username: 'peer',
        filename: 'dir\\02 Song Two.mp3',
        size: 200,
      },
    ]);
    return id;
  }

  it('round-trips a job with items', () => {
    const id = seedAlbumJob();
    const job = getAddonJob(db, id)!;
    expect(job.state).toBe('active');
    expect(job.items).toHaveLength(2);
    expect(job.items[0]!.itemId).toBe('t:song one');
    expect(job.items[0]!.fileReady).toBe(false);
  });

  it('links album_job_id for the fallback host', () => {
    const id = seedAlbumJob();
    expect(addonJobIdForAlbumJob(db, 7)).toBe(id);
    expect(addonJobIdForAlbumJob(db, 99)).toBeNull();
  });

  it('repoints an item keeping its id stable', () => {
    const id = seedAlbumJob();
    setItemState(db, id, 't:song one', 'failed');
    repointJobItem(db, id, 't:song one', {
      username: 'alt',
      filename: 'altdir\\Song One.flac',
      bitRateKbps: 900,
      audioFormat: 'FLAC',
    });
    const item = getAddonJob(db, id)!.items.find((i) => i.itemId === 't:song one')!;
    expect(item.username).toBe('alt');
    expect(item.state).toBe('queued');
    expect(item.audioFormat).toBe('FLAC');
  });

  // #2: El salmón (5 CDs, 103 files) repeats two titles on other discs, and
  // the second file of each overwrote the first's ledger row.
  function seedRepeatedTitle(id = 'job-r'): string {
    createAddonJob(db, { id, intent: 'album', artist: 'A', album: 'B', albumJobId: 8 });
    addJobItems(
      db,
      id,
      ['CD1\\05 Revolución Turra.flac', 'CD1\\06 Other.flac', 'CD4\\02 Revolucion turra.flac'].map(
        (filename, i) => ({
          itemId: itemIdForTitle(i === 1 ? 'Other' : 'Revolución turra'),
          title: i === 1 ? 'Other' : 'Revolución turra',
          username: 'peer',
          filename,
          size: 1,
        }),
      ),
    );
    return id;
  }

  it('a title the release repeats gets one ledger item per file', () => {
    const items = getAddonJob(db, seedRepeatedTitle())!.items;
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.itemId).sort()).toEqual([
      't:other',
      't:revolucion turra',
      't:revolucion turra#2',
    ]);
    expect(items.find((i) => i.itemId === 't:revolucion turra#2')!.filename).toBe(
      'CD4\\02 Revolucion turra.flac',
    );
  });

  it('a re-pull of a repeated title repoints its first sibling not yet completed', () => {
    const id = seedRepeatedTitle();
    markItemsCompletedByTransfer(db, [
      { username: 'peer', filename: 'CD1\\05 Revolución Turra.flac', fileReady: true },
    ]);
    expect(
      repointJobItem(db, id, 't:revolucion turra', { username: 'alt', filename: 'x\\Revolución Turra.flac' }),
    ).toBe(true);
    const items = getAddonJob(db, id)!.items;
    expect(items).toHaveLength(3);
    expect(items.find((i) => i.itemId === 't:revolucion turra')!.username).toBe('peer');
    expect(items.find((i) => i.itemId === 't:revolucion turra#2')!.username).toBe('alt');
  });

  it('completion sync flips matching items and recomputes job state', () => {
    const id = seedAlbumJob();
    markItemsCompletedByTransfer(db, [
      { username: 'peer', filename: 'dir\\01 Song One.mp3', fileReady: true },
    ]);
    let job = getAddonJob(db, id)!;
    expect(job.items.find((i) => i.itemId === 't:song one')!.state).toBe('completed');
    expect(job.state).toBe('active'); // song two still queued

    setItemState(db, id, 't:song two', 'unavailable');
    recomputeJobState(db, id);
    job = getAddonJob(db, id)!;
    expect(job.state).toBe('partial');
  });

  it('lists jobs incrementally by updated_at', async () => {
    const id = seedAlbumJob();
    const stamp = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 3));
    expect(listAddonJobs(db, stamp)).toHaveLength(0);
    setItemState(db, id, 't:song one', 'downloading', { bytesTransferred: 50 });
    expect(listAddonJobs(db, stamp)).toHaveLength(1);
  });

  it('deletes a job with its items', () => {
    const id = seedAlbumJob();
    deleteAddonJob(db, id);
    expect(getAddonJob(db, id)).toBeNull();
    expect(listAddonJobs(db)).toHaveLength(0);
  });

  it('derives file item ids from basenames', () => {
    expect(itemIdForFile('a\\b\\Track.MP3')).toBe('f:track.mp3');
  });
});

describe('byte progress crosses the poll cursor (#3)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  function seedDownloading(db: Database, id = 'job-b'): string {
    createAddonJob(db, {
      id,
      intent: 'album',
      artist: 'Artist',
      album: 'Album',
      canonicalTracks: [{ title: 'Song One' }],
    });
    addJobItems(db, id, [
      {
        itemId: itemIdForTitle('Song One'),
        title: 'Song One',
        username: 'peer',
        filename: 'dir\\01 Song One.mp3',
        size: 1000,
      },
    ]);
    db.run(`UPDATE addon_job_items SET state = 'downloading' WHERE job_id = ?`, [id]);
    db.run(`UPDATE addon_jobs SET updated_at = 1 WHERE id = ?`, [id]);
    return id;
  }

  const jobUpdatedAt = (db: Database, id: string): number =>
    (
      db
        .query<{ updated_at: number }, [string]>(
          `SELECT updated_at FROM addon_jobs WHERE id = ?`,
        )
        .get(id) ?? { updated_at: 0 }
    ).updated_at;

  const sync = (db: Database, bytes: number) =>
    syncItemStatesFromTransfers(db, [
      {
        username: 'peer',
        directories: [
          {
            files: [
              { filename: 'dir\\01 Song One.mp3', state: 'InProgress', bytesTransferred: bytes },
            ],
          },
        ],
      },
    ]);

  it('a visible byte advance bumps the job updated_at so the host cursor sees it', () => {
    const id = seedDownloading(db);
    sync(db, 400); // 40% of the file — well past the 1% throttle step
    expect(jobUpdatedAt(db, id)).toBeGreaterThan(1);
    const item = db
      .query<{ bytes_transferred: number | null }, [string]>(
        `SELECT bytes_transferred FROM addon_job_items WHERE job_id = ?`,
      )
      .get(id);
    expect(item?.bytes_transferred).toBe(400);
  });

  it('a sub-1% advance updates the item but does not spam the job cursor', () => {
    const id = seedDownloading(db);
    sync(db, 400);
    db.run(`UPDATE addon_jobs SET updated_at = 1 WHERE id = ?`, [id]);
    sync(db, 405); // +0.5% — item tracks it, job stays quiet
    expect(jobUpdatedAt(db, id)).toBe(1);
    const item = db
      .query<{ bytes_transferred: number | null }, [string]>(
        `SELECT bytes_transferred FROM addon_job_items WHERE job_id = ?`,
      )
      .get(id);
    expect(item?.bytes_transferred).toBe(405);
  });

  it('a queued→downloading state flip bumps the job regardless of bytes', () => {
    const id = seedDownloading(db);
    db.run(`UPDATE addon_job_items SET state = 'queued', bytes_transferred = NULL WHERE job_id = ?`, [id]);
    sync(db, 0);
    expect(jobUpdatedAt(db, id)).toBeGreaterThan(1);
  });
});
