import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SlskdRequestError, type Slskd } from '@nicotind/slskd-client';
import { applySchema } from '../db.js';
import {
  AlbumFallbackService,
  NOOP_FALLBACK_HOST,
  type AlternateCandidate,
} from './album-fallback.service.js';

const MIN = 60_000;

/**
 * The prod shape (#38): the primary delivered track one, then froze — track two
 * mid-transfer at the same byte count, track three queued on the peer's side.
 */
function stuckPrimary(bytesTwo: () => number) {
  const enqueue = mock(async (_u: string, _f: Array<{ filename: string }>) => undefined);
  const cancel = mock(async (_u: string, _id: string) => undefined);
  const searchCreate = mock(async () => ({ id: 's1', state: 'Completed' }));
  const getDownloads = mock(async () => [
    {
      username: 'primary',
      directories: [
        {
          directory: 'Album',
          fileCount: 3,
          files: [
            { id: 'p1', filename: 'Album/01 Song One.flac', size: 100, state: 'Completed, Succeeded' },
            {
              id: 'p2',
              filename: 'Album/02 Song Two.flac',
              size: 100,
              state: 'InProgress',
              bytesTransferred: bytesTwo(),
            },
            {
              id: 'p3',
              filename: 'Album/03 Song Three.flac',
              size: 100,
              state: 'Queued, Remotely',
              bytesTransferred: 0,
            },
          ],
        },
      ],
    },
  ]);
  const slskd = {
    transfers: { getDownloads, enqueue, cancel },
    searches: {
      create: searchCreate,
      get: async () => ({ state: 'Completed' }),
      getResponses: async () => [],
      delete: async () => undefined,
    },
  } as unknown as Slskd;
  return { slskd, enqueue, cancel, searchCreate };
}

const ALT: AlternateCandidate = {
  username: 'alt',
  directory: 'AltAlbum',
  files: [
    { filename: 'AltAlbum/02 Song Two.flac', size: 100 },
    { filename: 'AltAlbum/03 Song Three.flac', size: 100 },
  ],
};

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function recordJob(alternates: AlternateCandidate[]) {
  AlbumFallbackService.recordJob(db, {
    lidarrAlbumId: 1,
    username: 'primary',
    directory: 'Album',
    artistName: 'Artist',
    canonicalTracks: ['Song One', 'Song Two', 'Song Three'],
    alternates,
  });
}

const row = () =>
  db.query('SELECT state, fallback_attempts AS a FROM album_jobs WHERE id = 1').get() as {
    state: string;
    a: number;
  };

function service(slskd: Slskd, clock: { t: number }, maxFallbackAttempts = 5) {
  return new AlbumFallbackService(slskd, {
    db,
    host: NOOP_FALLBACK_HOST,
    now: () => clock.t,
    maxFallbackAttempts,
  });
}

describe('a stalled primary peer (#38)', () => {
  it('hands its tracks to a recorded alternate once frozen past the threshold, and cancels the frozen transfers', async () => {
    const { slskd, enqueue, cancel } = stuckPrimary(() => 50);
    recordJob([ALT]);
    const clock = { t: 1_000 };
    const svc = service(slskd, clock);

    await svc.sweep(); // first sighting starts the clocks
    clock.t += 5 * MIN + 1_000;
    await svc.sweep();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toBe('alt');
    expect(enqueue.mock.calls[0]![1].map((f) => f.filename).sort()).toEqual([
      'AltAlbum/02 Song Two.flac',
      'AltAlbum/03 Song Three.flac',
    ]);
    // Neither frozen transfer can wake up later and deliver a second copy.
    expect(cancel.mock.calls.map(([u, id]) => `${u}:${id}`).sort()).toEqual([
      'primary:p2',
      'primary:p3',
    ]);
    expect(row()).toEqual({ state: 'active', a: 1 });
  });

  it('waits out an honest queue: no overtake before the primary threshold', async () => {
    const { slskd, enqueue, cancel } = stuckPrimary(() => 50);
    recordJob([ALT]);
    const clock = { t: 1_000 };
    const svc = service(slskd, clock);

    await svc.sweep();
    // Past the 2-minute alternate threshold, short of the primary's 5.
    clock.t += 3 * MIN;
    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps a primary whose bytes still move', async () => {
    let bytes = 50;
    const { slskd, enqueue } = stuckPrimary(() => (bytes += 10));
    recordJob([ALT]);
    const clock = { t: 1_000 };
    const svc = service(slskd, clock);

    // Track three sits queued, but track two keeps moving: the peer is working.
    for (let i = 0; i < 4; i++) {
      await svc.sweep();
      clock.t += 2 * MIN;
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('with no recorded alternate: no fresh search, no attempt spent, never exhausted', async () => {
    const { slskd, enqueue, cancel, searchCreate } = stuckPrimary(() => 50);
    recordJob([]);
    // Even a spent budget does not close a job whose peer may still deliver.
    db.run('UPDATE album_jobs SET fallback_attempts = 5 WHERE id = 1');
    const clock = { t: 1_000 };
    const svc = service(slskd, clock);

    await svc.sweep();
    clock.t += 30 * MIN;
    await svc.sweep();

    expect(searchCreate).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(row()).toEqual({ state: 'active', a: 5 });
  });

  it('keeps the frozen primary when the alternate refuses the enqueue', async () => {
    const { slskd, enqueue, cancel } = stuckPrimary(() => 50);
    enqueue.mockImplementation(async () => {
      throw new SlskdRequestError('slskd request failed: 500', 500, '/transfers/downloads/alt');
    });
    recordJob([ALT]);
    const clock = { t: 1_000 };
    const svc = service(slskd, clock);

    await svc.sweep();
    clock.t += 6 * MIN;
    await svc.sweep();

    // The refusal spends the attempt and consumes the dead alternate (#15),
    // but nothing replaced the primary, so its transfers stay.
    expect(cancel).not.toHaveBeenCalled();
    expect(row().a).toBe(1);
  });
});
