import { createLogger } from '@nicotind/addon-sdk';
import type { Slskd } from '@nicotind/slskd-client';

const log = createLogger('source-connection');

/**
 * Minimum gap between two watchdog kicks. A hunt fires ~10 queries at once and
 * every one of them fails while the source is down; without a throttle each
 * would restart slskd's connection watchdog, which is both pointless and a way
 * to keep resetting a handshake that is already in flight.
 *
 * Deliberately larger than slskd's own first few backoff steps (1s, 2s, 4s…).
 * See `KICK_GRACE_MS` for why kicking too eagerly is a hazard and not just waste.
 */
export const KICK_THROTTLE_MS = 60_000;

/**
 * How long the source must have been offline before we kick at all.
 *
 * The kick exists to collapse slskd's 1 → 2 → … → 300s reconnect ladder, which
 * is what stretches a fault that clears in seconds into a ~25-minute outage.
 * But #1046 measured that 10 of 13 outages *start* with the Soulseek server
 * closing our socket during a search, and through an outage every TCP connect
 * then succeeds while the login times out — the shape of a server-side penalty
 * box. Whether that penalty is duration-based (extra attempts harmless) or
 * attempt-based (extra attempts prolong it) is not answerable from logs.
 *
 * So the kick waits out the part of the ladder that is cheap anyway, and only
 * intervenes once slskd's own delay has grown past this. Under either theory
 * that is safe: we never reconnect more aggressively than slskd already would
 * in the first half-minute, and we still cut the long tail where the ladder is
 * sitting at its 300s cap doing nothing.
 */
export const KICK_GRACE_MS = 45_000;

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
  /** When we first saw the source offline in the current outage. */
  private offlineSince: number | null = null;

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

    if (state.isLoggedIn) {
      this.offlineSince = null;
      return true;
    }

    log.warn({ state: state.state }, 'Soulseek source offline');
    this.kick();
    return false;
  }

  /**
   * Restart slskd's reconnect watchdog. Throttled, best-effort, never throws,
   * and held off entirely for the first `KICK_GRACE_MS` of an outage so we can
   * never out-hammer slskd's own early backoff steps.
   */
  private kick(): void {
    const at = this.now();
    if (this.offlineSince === null) this.offlineSince = at;
    if (at - this.offlineSince < KICK_GRACE_MS) return;
    if (at - this.lastKickAt < KICK_THROTTLE_MS) return;
    this.lastKickAt = at;
    void this.slskdRef.current.server
      .connect()
      .catch((err: unknown) => log.warn({ err }, 'Reconnect kick failed'));
  }
}
