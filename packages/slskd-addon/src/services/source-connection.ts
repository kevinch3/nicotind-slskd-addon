import { createLogger } from '@nicotind/addon-sdk';
import type { Slskd } from '@nicotind/slskd-client';

const log = createLogger('source-connection');

/**
 * Minimum gap between two watchdog kicks. A hunt fires ~10 queries at once and
 * every one of them fails while the source is down; without a throttle each
 * would restart slskd's connection watchdog, which is both pointless and a way
 * to keep resetting a handshake that is already in flight.
 */
export const KICK_THROTTLE_MS = 15_000;

/**
 * Is slskd able to reach the Soulseek network *right now*?
 *
 * This is the bit the addon used to fetch and throw away. slskd's HTTP API stays
 * healthy while its Soulseek session is down, so "the addon answered" says
 * nothing about whether a hunt can succeed: in that state `POST /searches`
 * returns 409 and `POST /transfers/downloads/<peer>` returns 500, and an empty
 * hunt is indistinguishable from a genuine miss.
 *
 * Readiness is `isLoggedIn`, **not** `isConnected` — the TCP connect succeeds
 * routinely and then the login handshake times out after 5s, so `Connected,
 * LoggingIn` is a state in which every search still fails.
 *
 * Detecting the outage is only half of it. slskd's own `ConnectionWatchdog`
 * backs off 1 → 2 → 4 … → 300s between login attempts, so a fault that clears
 * in seconds still costs up to five minutes of dead air — that backoff ladder,
 * not the network, is what sets the ~25-minute outages measured on prod (#1040).
 * `PUT /api/v0/server` restarts the watchdog and collapses the remaining wait,
 * so asking whether the source is ready also nudges it to become ready.
 */
export class SourceConnection {
  private lastKickAt = -Infinity;

  /**
   * Takes the same live `slskdRef` the rest of the addon holds rather than a
   * client instance: an admin can rewrite the slskd URL mid-session, and the
   * throttle state has to outlive that swap.
   */
  constructor(
    private readonly slskdRef: { current: Slskd },
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * True when slskd is logged in to Soulseek. A false answer kicks the reconnect
   * watchdog on the way out (throttled, best-effort) so the *next* caller has a
   * chance of getting a true one instead of waiting out the backoff.
   */
  async isReady(): Promise<boolean> {
    let state;
    try {
      state = await this.slskdRef.current.server.getState();
    } catch (err) {
      // slskd itself is unreachable — a different failure, and not one a
      // watchdog kick can help with.
      log.warn({ err }, 'slskd state unreadable');
      return false;
    }

    if (state.isLoggedIn) return true;

    log.warn({ state: state.state }, 'Soulseek source offline');
    this.kick();
    return false;
  }

  /** Restart slskd's reconnect watchdog. Throttled, best-effort, never throws. */
  private kick(): void {
    const at = this.now();
    if (at - this.lastKickAt < KICK_THROTTLE_MS) return;
    this.lastKickAt = at;
    void this.slskdRef.current.server
      .connect()
      .catch((err: unknown) => log.warn({ err }, 'Reconnect kick failed'));
  }
}
