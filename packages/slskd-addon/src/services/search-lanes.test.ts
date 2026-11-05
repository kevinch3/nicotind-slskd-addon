import { describe, expect, it } from 'bun:test';
import { SearchLanes } from './search-lanes.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SearchLanes', () => {
  it('runs one session at a time, in arrival order within a priority', async () => {
    const lanes = new SearchLanes();
    const log: string[] = [];
    let release!: () => void;
    const first = lanes.run('user', async () => {
      log.push('a:start');
      await new Promise<void>((r) => (release = r));
      log.push('a:end');
    });
    const second = lanes.run('user', async () => {
      log.push('b');
    });
    await tick();
    expect(log).toEqual(['a:start']);
    expect(lanes.pending).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['a:start', 'a:end', 'b']);
    expect(lanes.active).toBe(false);
  });

  it('a user session queued later still goes before a waiting background one', async () => {
    const lanes = new SearchLanes();
    const log: string[] = [];
    let release!: () => void;
    const hold = lanes.run('background', () => new Promise<void>((r) => (release = r)));
    const bg = lanes.run('background', async () => {
      log.push('background');
    });
    const user = lanes.run('user', async () => {
      log.push('user');
    });
    await tick();
    release();
    await Promise.all([hold, bg, user]);
    expect(log).toEqual(['user', 'background']);
  });

  it('a waiter whose caller has gone leaves the queue without ever taking the lanes (#24)', async () => {
    const lanes = new SearchLanes();
    const log: string[] = [];
    let release!: () => void;
    const hold = lanes.run('user', () => new Promise<void>((r) => (release = r)));
    const ac = new AbortController();
    const abandoned = lanes.run('user', async () => {
      log.push('abandoned ran');
    }, ac.signal);
    const next = lanes.run('user', async () => {
      log.push('next');
    });
    await tick();
    expect(lanes.pending).toBe(2);
    ac.abort();
    await expect(abandoned).rejects.toThrow();
    expect(lanes.pending).toBe(1);
    release();
    await Promise.all([hold, next]);
    expect(log).toEqual(['next']);
    expect(lanes.active).toBe(false);
  });

  it('an already-aborted session never runs', async () => {
    const lanes = new SearchLanes();
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    await expect(lanes.run('user', async () => { ran = true; }, ac.signal)).rejects.toThrow();
    expect(ran).toBe(false);
    expect(lanes.active).toBe(false);
  });

  it('a session that throws releases the lanes', async () => {
    const lanes = new SearchLanes();
    await expect(lanes.run('user', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lanes.active).toBe(false);
    await expect(lanes.run('user', async () => 'ok')).resolves.toBe('ok');
  });
});
