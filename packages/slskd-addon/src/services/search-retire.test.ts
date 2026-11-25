import { describe, expect, it } from 'bun:test';
import type { Slskd } from '@nicotind/slskd-client';
import { retireSearch } from './search-retire.js';

function fakeSearches(states: string[]) {
  const calls: string[] = [];
  let i = 0;
  const searches = {
    get: async () => {
      calls.push('get');
      return { state: states[Math.min(i++, states.length - 1)] };
    },
    cancel: async () => {
      calls.push('cancel');
    },
    delete: async () => {
      calls.push('delete');
    },
  };
  return { slskd: { searches } as unknown as Pick<Slskd, 'searches'>, calls };
}

describe('retireSearch (#23)', () => {
  it('deletes a finished search straight away, without cancelling it', async () => {
    const { slskd, calls } = fakeSearches(['Completed, TimedOut']);
    await retireSearch(slskd, 's1', { pollMs: 1 });
    expect(calls).toEqual(['get', 'delete']);
  });

  it('cancels a running search and deletes it only once slskd finished it', async () => {
    const { slskd, calls } = fakeSearches(['InProgress', 'InProgress', 'Completed, Cancelled']);
    await retireSearch(slskd, 's1', { pollMs: 1 });
    expect(calls).toEqual(['get', 'cancel', 'get', 'get', 'delete']);
  });

  it('deletes anyway once the wait runs out', async () => {
    const { slskd, calls } = fakeSearches(['InProgress']);
    await retireSearch(slskd, 's1', { pollMs: 1, waitMs: 10 });
    expect(calls[1]).toBe('cancel');
    expect(calls.at(-1)).toBe('delete');
  });

  it('a failing cancel or delete never throws', async () => {
    const slskd = {
      searches: {
        get: async () => ({ state: 'InProgress' }),
        cancel: async () => {
          throw new Error('boom');
        },
        delete: async () => {
          throw new Error('boom');
        },
      },
    } as unknown as Pick<Slskd, 'searches'>;
    await expect(retireSearch(slskd, 's1', { pollMs: 1, waitMs: 5 })).resolves.toBeUndefined();
  });
});
