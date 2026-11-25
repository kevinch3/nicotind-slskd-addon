import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { DownloadRetryService } from './download-retry.service.js';
import { MAX_REST_MS, type RetryPolicy } from './retry-policy.js';
import { restUntil } from './peer-rest.js';
import type { Slskd } from '@nicotind/slskd-client';

interface MockFile {
  id: string;
  filename: string;
  size: number;
  state: string;
  exception?: string;
  nextAttemptAt?: string;
  attempts?: number;
}

interface OtherPeer {
  username: string;
  directory: string;
  files: MockFile[];
}

/**
 * A re-enqueue replaces the dead transfer with a new one, under a new id — as
 * slskd does. `fail(name, exception)` / `succeed(name)` script what the new
 * transfer does next.
 */
function makeSlskdMock(files: MockFile[], username = 'peer', others: OtherPeer[] = []) {
  let generation = 0;
  const byName = (name: string) => files.find((f) => f.filename === name)!;
  const cancel = mock(async (_u: string, _id: string) => undefined);
  const enqueue = mock(async (_u: string, req: Array<{ filename: string; size: number }>) => {
    for (const { filename } of req) {
      const f = byName(filename);
      f.id = `${f.id.split('#')[0]}#${++generation}`;
      f.state = 'Queued, Remotely';
      delete f.exception;
    }
  });
  const getDownloads = mock(async () => [
    {
      username,
      directories: [{ directory: 'Album', fileCount: files.length, files }],
    },
    ...others.map((o) => ({
      username: o.username,
      directories: [{ directory: o.directory, fileCount: o.files.length, files: o.files }],
    })),
  ]);
  const slskd = { transfers: { getDownloads, cancel, enqueue } } as unknown as Slskd;
  const fail = (name: string, exception?: string, state = 'Completed, Errored') =>
    Object.assign(byName(name), { state, exception });
  const succeed = (name: string) => Object.assign(byName(name), { state: 'Completed, Succeeded' });
  return { slskd, cancel, enqueue, getDownloads, fail, succeed };
}

function makeDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function retryRow(db: Database, key: string) {
  return db
    .query('SELECT attempts, gave_up FROM transfer_retries WHERE transfer_key = ?')
    .get(key) as { attempts: number; gave_up: number } | undefined;
}

function attemptRows(db: Database, key: string) {
  return db
    .query(
      `SELECT exception, failure_class, retries_before, source_offline, decision, delay_ms,
              retried_at IS NOT NULL AS retried, outcome
       FROM transfer_attempts WHERE transfer_key = ? ORDER BY id`,
    )
    .all(key) as Array<{
    exception: string | null;
    failure_class: string;
    retries_before: number;
    source_offline: number;
    decision: string;
    delay_ms: number | null;
    retried: number;
    outcome: string | null;
  }>;
}

/** A protocol job whose item points at this peer's file — "somebody still wants it". */
function wantedBy(db: Database, jobState: string, username: string, filename: string) {
  db.run(
    `INSERT INTO addon_jobs (id, intent, state, created_at, updated_at) VALUES ('j1', 'album', ?, 0, 0)`,
    [jobState],
  );
  db.run(
    `INSERT INTO addon_job_items (job_id, item_id, username, filename, updated_at)
     VALUES ('j1', 'i1', ?, ?, 0)`,
    [username, filename],
  );
}

/** Today's reason-blind rule, parameterized — what the old options expressed. */
const blind =
  (max: number, delayMs = 0): RetryPolicy =>
  (_reason, retriesSoFar) =>
    retriesSoFar < max ? { action: 'retry', delayMs } : { action: 'give-up' };

describe('DownloadRetryService', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('re-enqueues an errored transfer and records the attempt', async () => {
    const { slskd, cancel, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'Album/01.flac', size: 100, state: 'Completed, Errored' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, policy: blind(3) });

    await svc.sweep();

    // slskd 0.25.1 supersedes a finished record on enqueue; cancelling first
    // only strands the file as Cancelled when the enqueue is then refused.
    expect(cancel).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('peer', [{ filename: 'Album/01.flac', size: 100 }]);
    expect(retryRow(db, 'peer::Album/01.flac')?.attempts).toBe(1);
  });

  it('retries TimedOut and Rejected but never Cancelled', async () => {
    const { slskd, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, TimedOut' },
      { id: 't2', filename: 'b.flac', size: 1, state: 'Completed, Rejected' },
      { id: 't3', filename: 'c.flac', size: 1, state: 'Completed, Cancelled' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, policy: blind(3) });

    await svc.sweep();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(retryRow(db, 'peer::c.flac')).toBeNull();
  });

  it('gives up when the policy says so and stops retrying', async () => {
    const { slskd, enqueue, fail } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, policy: blind(2) });

    await svc.sweep(); // retry 1
    fail('a.flac');
    await svc.sweep(); // retry 2
    fail('a.flac');
    await svc.sweep(); // 2 spent -> give up, no enqueue
    await svc.sweep(); // gave_up -> skip

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(retryRow(db, 'peer::a.flac')?.gave_up).toBe(1);
  });

  it('waits the decided delay, counted from when the failure was seen', async () => {
    let now = 0;
    const { slskd, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, policy: blind(3, 60_000), now: () => now });

    await svc.sweep();
    now = 59_999;
    await svc.sweep();
    expect(enqueue).toHaveBeenCalledTimes(0);
    now = 60_000;
    await svc.sweep();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('skips hidden transfers', async () => {
    const { slskd, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
    ]);
    db.run('INSERT INTO hidden_transfers (id) VALUES (?)', ['t1']);
    const svc = new DownloadRetryService(slskd, { db, policy: blind(3) });

    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('clears the retry record once a transfer succeeds', async () => {
    db.run(
      'INSERT INTO transfer_retries (transfer_key, username, filename, attempts) VALUES (?, ?, ?, ?)',
      ['peer::a.flac', 'peer', 'a.flac', 2],
    );
    const { slskd } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Succeeded' },
    ]);
    const svc = new DownloadRetryService(slskd, { db, policy: blind(3) });

    await svc.sweep();

    expect(retryRow(db, 'peer::a.flac')).toBeNull();
  });

  describe('by reason (#26)', () => {
    it('asks the policy with the failure class and the retries already spent', async () => {
      const asked: Array<[string, number]> = [];
      const policy: RetryPolicy = (reason, retriesSoFar) => {
        asked.push([reason, retriesSoFar]);
        return { action: 'retry', delayMs: 0 };
      };
      const { slskd, fail } = makeSlskdMock([
        {
          id: 't1',
          filename: 'a.flac',
          size: 1,
          state: 'Completed, Errored',
          exception: 'Overwhelmed with requests; try again later',
        },
      ]);
      const svc = new DownloadRetryService(slskd, { db, policy });

      await svc.sweep();
      fail('a.flac', 'The wait timed out', 'Completed, TimedOut');
      await svc.sweep();

      expect(asked).toEqual([
        ['peer-busy', 0],
        ['timeout', 1],
      ]);
    });

    // The fallback moves a track to an alternate only once the retry layer has
    // given up on it — so a give-up on the FIRST failure must still leave a
    // gave_up row, not update a row that does not exist yet.
    it('a give-up on the first failure is visible to the fallback at once', async () => {
      const { slskd, enqueue } = makeSlskdMock([
        {
          id: 't1',
          filename: 'a.flac',
          size: 1,
          state: 'Completed, Rejected',
          exception: 'Transfer rejected: File not shared.',
        },
      ]);
      const policy: RetryPolicy = (reason) =>
        reason === 'not-shared' ? { action: 'give-up' } : { action: 'retry', delayMs: 0 };
      const svc = new DownloadRetryService(slskd, { db, policy });

      await svc.sweep();

      expect(enqueue).not.toHaveBeenCalled();
      expect(retryRow(db, 'peer::a.flac')?.gave_up).toBe(1);
    });

    // One decision per failure: a randomized policy drawing a fresh delay on
    // every 15 s sweep would bias the experiment toward its shortest arm.
    it('decides once per failure, however many sweeps see it', async () => {
      let calls = 0;
      const policy: RetryPolicy = () => (calls++, { action: 'retry', delayMs: 3_600_000 });
      const { slskd } = makeSlskdMock([
        { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
      ]);
      const svc = new DownloadRetryService(slskd, { db, policy });

      for (let i = 0; i < 5; i++) await svc.sweep();

      expect(calls).toBe(1);
    });
  });

  describe('transfer_attempts ledger (#26)', () => {
    it('keeps every failure with its reason, decision and outcome, success included', async () => {
      const { slskd, fail, succeed } = makeSlskdMock([
        {
          id: 't1',
          filename: 'a.flac',
          size: 1,
          state: 'Completed, Errored',
          exception: 'Too many files',
        },
      ]);
      const svc = new DownloadRetryService(slskd, { db, policy: blind(3, 0) });

      await svc.sweep(); // failure 1 -> retried
      fail('a.flac', 'The wait timed out', 'Completed, TimedOut');
      await svc.sweep(); // failure 1 failed again; failure 2 -> retried
      succeed('a.flac');
      await svc.sweep(); // failure 2's retry succeeded

      expect(attemptRows(db, 'peer::a.flac')).toEqual([
        {
          exception: 'Too many files',
          failure_class: 'peer-busy',
          retries_before: 0,
          source_offline: 0,
          decision: 'retry',
          delay_ms: 0,
          retried: 1,
          outcome: 'failed',
        },
        {
          exception: 'The wait timed out',
          failure_class: 'timeout',
          retries_before: 1,
          source_offline: 0,
          decision: 'retry',
          delay_ms: 0,
          retried: 1,
          outcome: 'succeeded',
        },
      ]);
    });

    // slskd 0.26 retries transient failures itself before one ever turns
    // `Completed, …`; its count says how much patience a failure has had.
    it('records how many attempts slskd itself made before the failure', async () => {
      const { slskd } = makeSlskdMock([
        { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, TimedOut', attempts: 3 },
        { id: 't2', filename: 'b.flac', size: 1, state: 'Completed, Rejected' },
      ]);
      const svc = new DownloadRetryService(slskd, { db, policy: blind(3) });

      await svc.sweep();

      const sourceAttempts = (key: string) =>
        (
          db.query('SELECT source_attempts AS n FROM transfer_attempts WHERE transfer_key = ?').get(
            key,
          ) as { n: number | null }
        ).n;
      expect(sourceAttempts('peer::a.flac')).toBe(3);
      expect(sourceAttempts('peer::b.flac')).toBeNull();
    });

    it('records a give-up as its own outcome', async () => {
      const { slskd } = makeSlskdMock([
        { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
      ]);
      const svc = new DownloadRetryService(slskd, { db, policy: () => ({ action: 'give-up' }) });

      await svc.sweep();

      expect(attemptRows(db, 'peer::a.flac')).toMatchObject([
        { decision: 'give-up', delay_ms: null, retried: 0, outcome: 'gave-up' },
      ]);
    });

    it('forgets failures older than the retention window', async () => {
      let now = 0;
      const { slskd, getDownloads } = makeSlskdMock([
        { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
      ]);
      const svc = new DownloadRetryService(slskd, {
        db,
        policy: () => ({ action: 'give-up' }),
        now: () => now,
        attemptRetentionMs: 1_000,
      });
      await svc.sweep();
      getDownloads.mockImplementation(async () => []);
      now = 3_600_001;
      await svc.sweep();

      expect(attemptRows(db, 'peer::a.flac')).toEqual([]);
    });
  });

  describe('defer: another peer first, then come back (#26)', () => {
    const KEY = 'peer::Album/01 Song.flac';
    const busy = (): MockFile => ({
      id: 't1',
      filename: 'Album/01 Song.flac',
      size: 1,
      state: 'Completed, Rejected',
      exception: 'Too many files',
    });
    const deferFive: RetryPolicy = () => ({ action: 'defer', restMs: 300_000 });

    it('hands the track to the fallback at once and rests the peer', async () => {
      const now = 1_000;
      const { slskd, enqueue } = makeSlskdMock([busy()]);
      const svc = new DownloadRetryService(slskd, { db, policy: deferFive, now: () => now });

      await svc.sweep();

      expect(enqueue).not.toHaveBeenCalled();
      expect(retryRow(db, KEY)?.gave_up).toBe(1);
      expect(restUntil(db, 'peer')).toBe(301_000);
    });

    it('comes back to the same peer after the rest when nobody delivered the file', async () => {
      let now = 1_000;
      wantedBy(db, 'active', 'peer', 'Album/01 Song.flac');
      const { slskd, enqueue } = makeSlskdMock([busy()]);
      const svc = new DownloadRetryService(slskd, { db, policy: deferFive, now: () => now });

      await svc.sweep();
      now = 300_999;
      await svc.sweep();
      expect(enqueue).not.toHaveBeenCalled();
      now = 301_000;
      await svc.sweep();

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(retryRow(db, KEY)).toMatchObject({ gave_up: 0, attempts: 1 });
      expect(attemptRows(db, KEY)).toMatchObject([{ decision: 'defer', retried: 1 }]);
    });

    it('does not come back once another peer delivered the file', async () => {
      let now = 1_000;
      wantedBy(db, 'active', 'peer', 'Album/01 Song.flac');
      const { slskd, enqueue } = makeSlskdMock([busy()], 'peer', [
        {
          username: 'alt',
          directory: 'AltAlbum',
          files: [
            { id: 'a1', filename: 'AltAlbum/01 Song.flac', size: 1, state: 'Completed, Succeeded' },
          ],
        },
      ]);
      const svc = new DownloadRetryService(slskd, { db, policy: deferFive, now: () => now });

      await svc.sweep();
      now = 301_000;
      await svc.sweep();

      expect(enqueue).not.toHaveBeenCalled();
      expect(attemptRows(db, KEY)).toMatchObject([{ decision: 'defer', outcome: 'covered' }]);
    });

    // slskd 0.25.1 keeps every transfer until something removes it (8,080 listed
    // on kpc), so "still listed" says nothing. The job ledger says who wants the
    // file: a released job is deleted, a cancelled or finished one is closed, and
    // a fallback repoint moves the item to the alternate's file.
    it.each([
      ['its job was cancelled', 'cancelled'],
      ['its job finished', 'done'],
      ['its job was released, or its item repointed to another peer', null],
    ])('does not come back when %s', async (_why, jobState) => {
      let now = 1_000;
      if (jobState) wantedBy(db, jobState, 'peer', 'Album/01 Song.flac');
      const { slskd, enqueue } = makeSlskdMock([busy()]);
      const svc = new DownloadRetryService(slskd, { db, policy: deferFive, now: () => now });

      await svc.sweep();
      now = 301_000;
      await svc.sweep();

      expect(enqueue).not.toHaveBeenCalled();
      expect(attemptRows(db, KEY)).toMatchObject([{ outcome: 'not-needed' }]);
    });

    it('caps a rest', async () => {
      const now = 1_000;
      const { slskd } = makeSlskdMock([busy()]);
      const svc = new DownloadRetryService(slskd, {
        db,
        policy: () => ({ action: 'defer', restMs: 10 * 3_600_000 }),
        now: () => now,
      });

      await svc.sweep();

      expect(restUntil(db, 'peer')).toBe(1_000 + MAX_REST_MS);
      expect(attemptRows(db, KEY)).toMatchObject([{ delay_ms: MAX_REST_MS }]);
    });

    it('a same-peer retry waits out the peer\'s rest', async () => {
      let now = 1_000;
      wantedBy(db, 'active', 'peer', 'Album/01 Song.flac');
      const { slskd, enqueue } = makeSlskdMock([
        busy(),
        {
          id: 't2',
          filename: 'Album/02 Other.flac',
          size: 1,
          state: 'Completed, TimedOut',
          exception: 'The wait timed out',
        },
      ]);
      const policy: RetryPolicy = (reason) =>
        reason === 'peer-busy'
          ? { action: 'defer', restMs: 300_000 }
          : { action: 'retry', delayMs: 0 };
      const svc = new DownloadRetryService(slskd, { db, policy, now: () => now });

      await svc.sweep();
      expect(enqueue).not.toHaveBeenCalled();
      now = 301_000;
      await svc.sweep();
      expect(enqueue).toHaveBeenCalledTimes(2);
    });
  });

  // slskd 0.25.1 (pinned in NicotinD's compose) has no download retry of its
  // own; newer releases do (`transfers.download.retry`). Two layers retrying
  // one transfer would double the attempts and race each other's enqueue.
  it('leaves a transfer slskd will retry itself alone until that retry is due', async () => {
    let now = Date.parse('2026-11-06T00:00:00Z');
    const { slskd, enqueue } = makeSlskdMock([
      {
        id: 't1',
        filename: 'a.flac',
        size: 1,
        state: 'Completed, Errored',
        nextAttemptAt: '2026-11-06T00:01:00Z',
      },
    ]);
    const svc = new DownloadRetryService(slskd, { db, policy: blind(3), now: () => now });

    await svc.sweep();
    expect(enqueue).not.toHaveBeenCalled();
    expect(attemptRows(db, 'peer::a.flac')).toEqual([]);
    now += 60_001;
    await svc.sweep();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a refused enqueue leaves the failure retryable, and the policy decides again', async () => {
    const asked: number[] = [];
    const policy: RetryPolicy = (_r, retriesSoFar) => (
      asked.push(retriesSoFar), { action: 'retry', delayMs: 0 }
    );
    const { slskd, enqueue } = makeSlskdMock([
      { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
    ]);
    enqueue.mockImplementationOnce(async () => {
      throw new Error('slskd request failed: 500');
    });
    const svc = new DownloadRetryService(slskd, { db, policy });

    await svc.sweep(); // refused
    await svc.sweep(); // decided again, enqueued

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(asked).toEqual([0, 1]);
    expect(attemptRows(db, 'peer::a.flac')).toMatchObject([
      { outcome: 'enqueue-failed' },
      { retries_before: 1, retried: 1, outcome: null },
    ]);
  });

  // 88 of the failures listed on kpc read "Application shut down": slskd was
  // restarted under them (a deploy), which says nothing about the peer.
  it('a failure from slskd shutting down gets a free retry, without asking the policy', async () => {
    let asked = 0;
    const { slskd, enqueue } = makeSlskdMock([
      {
        id: 't1',
        filename: 'a.flac',
        size: 1,
        state: 'Completed, Errored',
        exception: 'Application shut down',
      },
    ]);
    const svc = new DownloadRetryService(slskd, {
      db,
      policy: () => (asked++, { action: 'give-up' }),
    });

    await svc.sweep();

    expect(asked).toBe(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(retryRow(db, 'peer::a.flac')?.attempts).toBe(0);
  });

  describe('while Soulseek is offline (#26)', () => {
    it('re-enqueues nothing, so an outage spends no attempts', async () => {
      const { slskd, enqueue } = makeSlskdMock([
        { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
      ]);
      const svc = new DownloadRetryService(slskd, {
        db,
        policy: blind(3),
        isSourceReady: async () => false,
      });

      await svc.sweep();
      await svc.sweep();

      expect(enqueue).not.toHaveBeenCalled();
      expect(retryRow(db, 'peer::a.flac')).toBeNull();
    });

    it('a failure seen during the outage is retried for free once it is back', async () => {
      let ready = false;
      const { slskd, enqueue } = makeSlskdMock([
        { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
      ]);
      const svc = new DownloadRetryService(slskd, {
        db,
        policy: blind(3),
        isSourceReady: async () => ready,
      });

      await svc.sweep();
      ready = true;
      await svc.sweep();

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(retryRow(db, 'peer::a.flac')?.attempts).toBe(0);
      expect(attemptRows(db, 'peer::a.flac')).toMatchObject([{ source_offline: 1, retried: 1 }]);
    });

    it('an outage failure is not put to the policy, so it cannot be given up on', async () => {
      let ready = false;
      const { slskd, enqueue } = makeSlskdMock([
        { id: 't1', filename: 'a.flac', size: 1, state: 'Completed, Errored' },
      ]);
      const svc = new DownloadRetryService(slskd, {
        db,
        policy: () => ({ action: 'give-up' }),
        isSourceReady: async () => ready,
      });

      await svc.sweep();
      ready = true;
      await svc.sweep();

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(retryRow(db, 'peer::a.flac')?.gave_up).toBe(0);
    });
  });
});

describe('a size-mismatch abort (#28)', () => {
  const ABORT =
    'Transfer aborted: the remote size of 12124447 does not match expected size 12624200';

  it('is re-enqueued once on the same peer, at the size the peer now reports', async () => {
    const db = makeDb();
    const { slskd, enqueue, fail } = makeSlskdMock([
      { id: 'a', filename: 'Album/01.flac', size: 12_624_200, state: 'Completed, Succeeded' },
    ]);
    fail('Album/01.flac', ABORT, 'Completed, Aborted');
    const svc = new DownloadRetryService(slskd, { db });

    await svc.sweep();
    expect(enqueue).toHaveBeenCalledWith('peer', [{ filename: 'Album/01.flac', size: 12_124_447 }]);
    expect(attemptRows(db, 'peer::Album/01.flac')[0]).toMatchObject({
      failure_class: 'size-mismatch',
      decision: 'retry',
    });

    // It aborts again: the fallback gets it.
    fail('Album/01.flac', ABORT, 'Completed, Aborted');
    await svc.sweep();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(retryRow(db, 'peer::Album/01.flac')?.gave_up).toBe(1);
  });

  it('any other abort is left alone', async () => {
    const db = makeDb();
    const { slskd, enqueue } = makeSlskdMock([
      {
        id: 'a',
        filename: 'Album/01.flac',
        size: 100,
        state: 'Completed, Aborted',
        exception: 'Transfer aborted',
      },
    ]);
    await new DownloadRetryService(slskd, { db }).sweep();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
