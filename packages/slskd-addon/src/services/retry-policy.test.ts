import { describe, expect, it } from 'bun:test';
import { classifyFailure, retryPolicyFor } from './retry-policy.js';

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

// The stand-in until the owner writes the table: replace these expectations
// with the table's own when it lands.
describe('retryPolicyFor (stand-in)', () => {
  it('keeps the old rule: first retry at once, then 60 s apart, three in all', () => {
    expect(retryPolicyFor('other', 0)).toEqual({ action: 'retry', delayMs: 0 });
    expect(retryPolicyFor('other', 1)).toEqual({ action: 'retry', delayMs: 60_000 });
    expect(retryPolicyFor('other', 2)).toEqual({ action: 'retry', delayMs: 60_000 });
    expect(retryPolicyFor('other', 3)).toEqual({ action: 'give-up' });
  });
});
