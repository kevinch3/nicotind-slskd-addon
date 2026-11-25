import type { Database } from 'bun:sqlite';

/**
 * Peers resting after telling us to back off (#26). The retry layer writes a
 * rest when the policy defers a failure; the same-peer retry and the album
 * fallback both wait one out rather than reaching for the peer again. Kept in
 * the addon's own database so a restart does not cut a rest short.
 */
export function restPeer(db: Database, username: string, until: number, reason: string): void {
  db.run(
    `INSERT INTO peer_rest (username, until, reason) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET until = MAX(until, excluded.until), reason = excluded.reason`,
    [username, until, reason],
  );
}

/** When this peer's rest ends, or 0 if it is not resting. */
export function restUntil(db: Database, username: string): number {
  const row = db.query('SELECT until FROM peer_rest WHERE username = ?').get(username) as {
    until: number;
  } | null;
  return row?.until ?? 0;
}

export function restingPeers(db: Database, now: number): Set<string> {
  const rows = db.query('SELECT username FROM peer_rest WHERE until > ?').all(now) as Array<{
    username: string;
  }>;
  return new Set(rows.map((r) => r.username));
}

export function pruneRests(db: Database, now: number): void {
  db.run('DELETE FROM peer_rest WHERE until <= ?', [now]);
}
