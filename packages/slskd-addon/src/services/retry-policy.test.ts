import { describe, expect, it } from 'bun:test';
import {
  BACKOFF_MS,
  PEER_BUSY_REST_MS,
  classifyFailure,
  isRetryableTransfer,
  remoteSizeFrom,
  retryPolicyFor,
} from './retry-policy.js';

// The reason strings are slskd's own `exception` text, as counted on kpc over
// 48 h to 2026-11-05 (nicotind-slskd-addon#26).
describe('classifyFailure (#26)', () => {
  it.each([
    ['Completed, Rejected', 'Transfer rejected: File not shared.', 'not-shared'],
    ['Completed, Rejected', 'File not shared', 'not-shared'],
    ['Completed, Rejected', 'Too many files', 'peer-busy'],
    ['Completed, Rejected', 'Too many megabytes', 'peer-busy'],
    ['Completed, Errored', 'Overwhelmed with requests; try again later', 'peer-busy'],
    ['Completed, TimedOut', 'The wait timed out', 'timeout'],
    ['Completed, Errored', 'Operation timed out after 30000 milliseconds', 'timeout'],
    ['Completed, Errored', 'Failed to establish a direct or indirect message connection', 'connection'],
    ['Completed, Errored', 'Remote connection closed', 'connection'],
    ['Completed, Errored', 'Verification required', 'other'],
    // As listed by kpc's slskd 0.25.1 on 2026-11-06.
    ['Completed, Errored', 'Application shut down', 'shutdown'],
    ['Completed, TimedOut', 'The wait timed out after 15000 milliseconds', 'timeout'],
    ['Completed, TimedOut', 'Inactivity timeout of 60000 milliseconds was reached', 'timeout'],
    ['Completed, TimedOut', 'Download failed to enqueue remotely after hard time limit of 120 secs', 'timeout'],
    ['Completed, Rejected', 'Transfer rejected: Overwhelmed with requests; try again later.', 'peer-busy'],
    ['Completed, Errored', 'Transfer failed: Read error: Unable to read data from the transport connection: Connection reset by peer.', 'connection'],
    ['Completed, Errored', 'Failed to establish a direct or indirect transfer connection to peer (1.2.3.4:50300)', 'connection'],
    ['Completed, Rejected', 'File read error.', 'other'],
    ['Completed, Errored', 'Download reported as failed by remote client', 'other'],
    ['Completed, Rejected', 'Transfer rejected: Verification required: check private messages', 'other'],
    // kpc, slskd 0.26.2, 2026-11-06 (#28).
    ['Completed, Aborted', 'Transfer aborted: the remote size of 12124447 does not match expected size 12624200', 'size-mismatch'],
  ] as const)('%s / %s → %s', (state, exception, expected) => {
    expect(classifyFailure(state, exception)).toBe(expected);
  });

  it('a TimedOut state with no exception text is a timeout', () => {
    expect(classifyFailure('Completed, TimedOut', undefined)).toBe('timeout');
  });

  it('an errored transfer with no exception text is unclassified, not guessed', () => {
    expect(classifyFailure('Completed, Errored', undefined)).toBe('other');
    expect(classifyFailure('Completed, Errored', '')).toBe('other');
  });
});

describe('retryPolicyFor (#26)', () => {
  it('gives up on a file the peer does not share', () => {
    expect(retryPolicyFor('not-shared', 0)).toEqual({ action: 'give-up' });
  });

  it('rests a peer that asked us to back off', () => {
    expect(retryPolicyFor('peer-busy', 0)).toEqual({ action: 'defer', restMs: PEER_BUSY_REST_MS });
  });

  it('backs off a timeout or a dropped connection, then gives up', () => {
    for (const cls of ['timeout', 'connection'] as const) {
      BACKOFF_MS.forEach((delayMs, n) => expect(retryPolicyFor(cls, n)).toEqual({ action: 'retry', delayMs }));
      expect(retryPolicyFor(cls, BACKOFF_MS.length)).toEqual({ action: 'give-up' });
    }
  });

  it('retries a size mismatch once, at once (#28)', () => {
    expect(retryPolicyFor('size-mismatch', 0)).toEqual({ action: 'retry', delayMs: 0 });
    expect(retryPolicyFor('size-mismatch', 1)).toEqual({ action: 'give-up' });
  });

  it('keeps the old rule for anything unclassified', () => {
    expect(retryPolicyFor('other', 0)).toEqual({ action: 'retry', delayMs: 0 });
    expect(retryPolicyFor('other', 1)).toEqual({ action: 'retry', delayMs: 60_000 });
    expect(retryPolicyFor('other', 2)).toEqual({ action: 'retry', delayMs: 60_000 });
    expect(retryPolicyFor('other', 3)).toEqual({ action: 'give-up' });
  });
});

describe('size-mismatch aborts (#28)', () => {
  it('reads the peer\'s current size from the message', () => {
    expect(remoteSizeFrom('Transfer aborted: the remote size of 13893984 does not match expected size 13655792')).toBe(13_893_984);
    expect(remoteSizeFrom('Transfer aborted')).toBeNull();
    expect(remoteSizeFrom(undefined)).toBeNull();
  });

  it('only a size-mismatch abort is retryable', () => {
    expect(isRetryableTransfer('Completed, Aborted', 'the remote size of 1 does not match expected size 2')).toBe(true);
    expect(isRetryableTransfer('Completed, Aborted', 'Transfer aborted')).toBe(false);
    expect(isRetryableTransfer('Completed, Cancelled', null)).toBe(false);
    expect(isRetryableTransfer('Completed, Errored', null)).toBe(true);
  });
});
