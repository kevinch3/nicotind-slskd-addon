# The slskd acquisition addon — NicotinD acquisition addon protocol v1.
# Build from the repo root: docker build -t nicotind-slskd-addon .
FROM oven/bun:1.3.14

WORKDIR /app

# Manifests + lockfile first so the install layer caches across source edits.
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages/addon-sdk/package.json packages/addon-sdk/
COPY packages/slskd-client/package.json packages/slskd-client/
COPY packages/slskd-addon/package.json packages/slskd-addon/
RUN bun install --production --ignore-scripts

COPY packages/addon-sdk/src ./packages/addon-sdk/src
COPY packages/slskd-client/src ./packages/slskd-client/src
COPY packages/slskd-addon/src ./packages/slskd-addon/src

ENV SLSKD_ADDON_DB=/data/slskd-addon.sqlite \
    SLSKD_ADDON_DOWNLOADS_DIR=/data/downloads \
    SLSKD_ADDON_PORT=8585

EXPOSE 8585

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.SLSKD_ADDON_PORT ?? 8585) + '/addon/v1/health'); if (!r.ok) process.exit(1); const b = await r.json(); if (b.ok !== true) process.exit(1);"

CMD ["bun", "run", "packages/slskd-addon/src/main.ts"]
