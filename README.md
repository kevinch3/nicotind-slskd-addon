# nicotind-slskd-addon

The **Soulseek (slskd) acquisition addon** for [NicotinD](https://github.com/kevinch3/NicotinD) —
an out-of-process, Torrentio-style HTTP addon that speaks the NicotinD **acquisition addon protocol
v1**. NicotinD core carries zero slskd code; you register this addon by URL + token and it lights up
the blended search, album-hunt, and download lanes with no core changes.

It owns the whole hunt/retry/fallback engine (skewed queries, per-track fallback across peers,
auto-retry) and delivers finished files to core over HTTP; core organizes and scans them.

## Layout

A self-contained [Bun](https://bun.com) workspace:

| Package | Purpose |
| --- | --- |
| `packages/slskd-addon` | The HTTP addon: protocol routes, hunt engine, own SQLite job ledger, slskd supervisor |
| `packages/slskd-client` | Typed client for slskd's REST API (`/api/v0/*`) |
| `packages/addon-sdk` | The published protocol SDK — v1 DTOs/schemas, hunt-query helpers, logger |

> **Transitional note:** `@nicotind/addon-sdk` is vendored here as a workspace member so the repo
> builds standalone today. Once it is published to npm, `slskd-addon`/`slskd-client` can depend on
> the published `@nicotind/addon-sdk` and drop the vendored copy — a two-line change to their
> `package.json` deps plus removing `packages/addon-sdk`.

The published protocol contract lives in [`docs/addon-protocol/v1.md`](docs/addon-protocol/v1.md)
(+ generated `docs/addon-protocol/v1/schema.json`, regenerate with `bun run gen:schema`).

## Run

### Docker (recommended)

```bash
docker run -d --name slskd-addon \
  -p 8585:8585 \
  -v /srv/slskd-addon:/data \
  -e SLSKD_ADDON_TOKEN=<a-long-random-secret> \
  -e SLSKD_ADDON_SLSKD_URL=http://slskd:5030 \
  -e SLSKD_ADDON_SLSKD_USERNAME=<slskd-user> \
  -e SLSKD_ADDON_SLSKD_PASSWORD=<slskd-pass> \
  ghcr.io/kevinch3/nicotind-slskd-addon:latest
```

Then in NicotinD → **Extensions → Add addon**, register `http://<host>:8585` with the same token.

### Local dev

```bash
bun install
SLSKD_ADDON_TOKEN=dev SLSKD_ADDON_SLSKD_URL=http://127.0.0.1:5030 bun start
```

## Configuration

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SLSKD_ADDON_TOKEN` | **yes** | — | Bearer token core authenticates with; the addon refuses to start without it |
| `SLSKD_ADDON_SLSKD_URL` | yes | — | Base URL of the slskd instance to drive |
| `SLSKD_ADDON_SLSKD_USERNAME` / `_PASSWORD` | if slskd auth is on | — | slskd API credentials |
| `SLSKD_ADDON_SOULSEEK_USERNAME` / `_PASSWORD` | — | — | Soulseek network credentials pushed to slskd |
| `SLSKD_ADDON_PORT` | — | `8585` | HTTP listen port |
| `SLSKD_ADDON_DB` | — | `/data/slskd-addon.sqlite` | Job-ledger SQLite path |
| `SLSKD_ADDON_DOWNLOADS_DIR` | — | `/data/downloads` | Where slskd lands transfers before HTTP delivery |
| `SLSKD_ADDON_MUSIC_DIR` | — | — | Read-only music dir to share back to Soulseek peers |

Only `GET /addon/v1/manifest` and `GET /addon/v1/health` are unauthenticated; every other route
requires the bearer token.

## Develop

```bash
bun run typecheck   # tsc --build across the workspace
bun run test        # bun test (hunt engine, replay fixtures, protocol routes)
bun run gen:schema  # regenerate the published JSON Schema from the Zod DTOs
```

CI (`.github/workflows/ci.yml`) runs typecheck + test and builds the image, publishing
`ghcr.io/kevinch3/nicotind-slskd-addon` on pushes to `main` and version tags.

## License

AGPL-3.0-only, matching NicotinD.
