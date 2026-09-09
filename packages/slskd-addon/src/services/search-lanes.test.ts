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

  it('a session that throws releases the lanes', async () => {
    const lanes = new SearchLanes();
    await expect(lanes.run('user', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lanes.active).toBe(false);
    await expect(lanes.run('user', async () => 'ok')).resolves.toBe('ok');
  });
});
