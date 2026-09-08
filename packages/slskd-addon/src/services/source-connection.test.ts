import { describe, expect, it, mock } from 'bun:test';
import type { Slskd } from '@nicotind/slskd-client';
import { SourceConnection, KICK_THROTTLE_MS } from './source-connection.js';

function stub(states: Array<Record<string, unknown>>) {
  let i = 0;
  const getState = mock(async () => states[Math.min(i++, states.length - 1)]);
  const connect = mock(async () => undefined);
  const slskd = { server: { getState, connect } } as unknown as Slskd;
  return { slskd, getState, connect };
}

const LOGGED_IN = { state: 'Connected, LoggedIn', isConnected: true, isLoggedIn: true };
const OFFLINE = { state: 'Disconnected', isConnected: false, isLoggedIn: false };

describe('SourceConnection', () => {
  it('is ready only when slskd is logged in to Soulseek, not merely reachable', async () => {
    // The whole defect: slskd's HTTP API answers happily while Soulseek is down.
    expect(await new SourceConnection({ current: stub([LOGGED_IN]).slskd }).isReady()).toBe(true);
    expect(await new SourceConnection({ current: stub([OFFLINE]).slskd }).isReady()).toBe(false);
  });

  it('treats a mid-handshake state as not ready', async () => {
    const connecting = { state: 'Connected, LoggingIn', isConnected: true, isLoggedIn: false };
    expect(await new SourceConnection({ current: stub([connecting]).slskd }).isReady()).toBe(false);
  });

  it('is not ready when slskd itself is unreachable', async () => {
    const slskd = { server: { getState: async () => { throw new Error('ECONNREFUSED'); } } } as unknown as Slskd;
    expect(await new SourceConnection({ current: slskd }).isReady()).toBe(false);
  });

  it('kicks slskd out of its reconnect backoff when offline', async () => {
    // slskd backs off 1→2→…→300s; PUT /server restarts the watchdog, collapsing
    // a ~25 min hole into seconds. Without this we just wait it out.
    const { slskd, connect } = stub([OFFLINE]);
    await new SourceConnection({ current: slskd }).isReady();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('never kicks while logged in', async () => {
    const { slskd, connect } = stub([LOGGED_IN]);
    await new SourceConnection({ current: slskd }).isReady();
    expect(connect).not.toHaveBeenCalled();
  });

  it('throttles the kick so a burst of failing queries cannot spam slskd', async () => {
    let now = 0;
    const { slskd, connect } = stub([OFFLINE]);
    const conn = new SourceConnection({ current: slskd }, () => now);
    await conn.isReady();
    await conn.isReady();
    await conn.isReady();
    expect(connect).toHaveBeenCalledTimes(1);
    now += KICK_THROTTLE_MS + 1;
    await conn.isReady();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('a failing kick never throws — it is best-effort', async () => {
    const { slskd } = stub([OFFLINE]);
    (slskd.server as { connect: unknown }).connect = async () => { throw new Error('nope'); };
    expect(await new SourceConnection({ current: slskd }).isReady()).toBe(false);
  });
});
