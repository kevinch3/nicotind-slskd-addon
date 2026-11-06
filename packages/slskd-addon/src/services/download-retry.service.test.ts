import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { DownloadRetryService } from './download-retry.service.js';
import type { RetryPolicy } from './retry-policy.js';
import type { Slskd } from '@nicotind/slskd-client';

interface MockFile {
  id: string;
  filename: string;
  size: number;
  state: string;
  exception?: string;
}

/**
 * A re-enqueue replaces the dead transfer with a new one, under a new id — as
 * slskd does. `fail(name, exception)` / `succeed(name)` script what the new
 * transfer does next.
 */
function makeSlskdMock(files: MockFile[], username = 'peer') {
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

    expect(cancel).toHaveBeenCalledTimes(1);
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
