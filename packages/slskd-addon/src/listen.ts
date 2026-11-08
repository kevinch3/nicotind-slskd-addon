/**
 * Where the addon listens (NicotinD #1741). Every interface by default, which a
 * Docker port mapping needs; set SLSKD_ADDON_HOST=127.0.0.1 when core runs on
 * the same host, so the addon is not reachable from the LAN at all.
 */
export function listenAddress(env: Record<string, string | undefined>): {
  hostname: string;
  port: number;
} {
  return {
    hostname: env.SLSKD_ADDON_HOST || '0.0.0.0',
    port: Number(env.SLSKD_ADDON_PORT ?? 8585),
  };
}
