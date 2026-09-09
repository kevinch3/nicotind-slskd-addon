import { SlskdRequestError, type Slskd } from '@nicotind/slskd-client';
import {
  createLogger,
  baseQueries,
  buildSkewedQueries,
  normalizeTitle,
  stripTitleQualifiers,
  titlesOverlap,
} from '@nicotind/addon-sdk';
import { SourceConnection } from './source-connection.js';
import { SearchLanes } from './search-lanes.js';

// Re-export the shared query builders so existing importers (track-pick, tests,
// callers) keep their `./album-hunter.service` import path — the canonical source
// is now @nicotind/core/hunt-queries.
export { buildSkewedQueries, stripTitleQualifiers, baseQueries } from '@nicotind/addon-sdk';
// Same shim for the title matchers, promoted to @nicotind/core `title-match.ts`
// (8 non-slskd api files import them from here).
export { normalizeTitle, titlesOverlap } from '@nicotind/addon-sdk';

/** The addon never sees Lidarr — a canonical track is just a titled ref
 *  (structurally satisfied by LidarrTrack, so api callers pass through). */
export interface CanonicalTrackRef {
  title: string;
}

const log = createLogger('album-hunter');

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
  '.m4a',
  '.aac',
  '.wav',
  '.aiff',
  '.wma',
  '.ape',
  '.wv',
]);

const POLL_INTERVAL_MS = 2_000;

// The source's search concurrency (NicotinD#1049). slskd's Soulseek.NET client
// runs `maximumConcurrentSearches = 2` and slskd never overrides it: every
// further search waits in `Queued`. A hunt therefore fires its queries in waves
// of exactly this many, so one hunt never queues behind itself.
export const SEARCH_LANES = 2;

// Per-search inactivity timeout handed to slskd. Soulseek.NET's default is 15 s
// after the last response, but responses plateau by ~10 s: measured on prod
// (three query pairs, both arms) 8 s returned the identical response counts
// while cutting the lane hold from up to 37.6 s to 12.0 s.
export const SEARCH_TIMEOUT_MS = 8_000;

// Ceiling for one wave: creation + the responses + the inactivity timeout, with
// headroom for slow peers. A wave normally ends well before this because slskd
// reports the searches complete.
export const WAVE_TIMEOUT_MS = 30_000;

// Skew variants are ranked most-precise first; the tail (title-only, broad) is
// the least likely to add a folder the earlier ones missed and would cost a
// whole extra lane cycle, so a hunt stops at this many.
export const MAX_SKEW_QUERIES = 4;

// 429 retry (#hunt-429): creates are serialized by the client, but a 429 can
// still surface when another process posts a search; only a query still 429ing
// after all retries counts as rate-limited ("still searching", vs a genuine miss).
const SEARCH_429_MAX_RETRIES = 3;
const SEARCH_429_BACKOFF_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Low server-side floor so we don't return hundreds of junk folders. All
// finer filtering (FLAC-only, live, higher match %) happens reactively on the
// client so the user can adjust without re-hitting the network.
const MIN_FLOOR_PCT = 10;

// When the best base-query candidate scores below this, fire the skew-search
// variants too (and merge the results). why: skew only used to run on a *totally
// empty* base, but MIN_FLOOR_PCT is so low that one junk partial folder keeps the
// base non-empty and suppressed skew entirely — exactly the "partial match" case
// (common for accented Latin titles) where the soft-banned exact phrase hides a
// complete folder that a skewed variant surfaces. A confidently-complete base
// (>= this) adds zero extra searches.
const SKEW_TRIGGER_PCT = 67;

// Match strength for a single (1-track hunt) whose Lidarr title carries a
// qualifier — "(feat …)"/"(Remix)" — that the peer omitted from the filename, so
// the full titles don't overlap but their qualifier-stripped cores do. We still
// surface it (above MIN_FLOOR_PCT) but rank it below an exact hit. why: a single
// is otherwise all-or-nothing (matched/1 → 0% or 100%), so any near miss is
// silently dropped — common for remixes/typos/featured-artist spellings.
const SINGLE_PARTIAL_PCT = 50;

export interface HuntFile {
  filename: string;
  size: number;
  bitRate?: number;
}

interface PeerHealth {
  freeUploadSlots: number;
  queueLength: number;
  uploadSpeed: number;
}

// Match% is bucketed (rounded to the nearest 20) before comparison so a
// marginally-higher match doesn't force us onto a dead peer — e.g. a healthy
// 90%-match peer with free slots out-ranks a dead 100%-match peer (both land in
// the same bucket). Auto-retry + cross-peer fallback backstop the missing
// tracks. Within a bucket we demote bloated folders, then prefer a peer with
// free upload slots, then a shorter queue, then FLAC, then faster upload speed,
// then a better per-track size.
const MATCH_BUCKET = 20;

// A folder holding more than this multiple of the album's track count is a
// dump (a whole discography, a genre pack) that merely happens to contain the
// album. why: `matchPct` is recall-only, so such a folder scores a perfect
// 100% — identical to a clean rip — and nothing downstream could tell them
// apart. Bloat is a property of the *match*, not of the peer, so it is judged
// immediately after the match bucket and ahead of peer health. Only audio
// files are counted, so cue/log/scans never trip it, and the ratio leaves
// deluxe editions and 2-CD sets alone. See docs/album-hunt.md.
const BLOAT_RATIO = 2;

export function isBloatedFolder(c: Pick<FolderCandidate, 'files' | 'totalTracks'>): boolean {
  return c.files.length > c.totalTracks * BLOAT_RATIO;
}

function compareCandidates(a: FolderCandidate, b: FolderCandidate): number {
  const aBucket = Math.round(a.matchPct / MATCH_BUCKET);
  const bBucket = Math.round(b.matchPct / MATCH_BUCKET);
  if (aBucket !== bBucket) return bBucket - aBucket;

  const aBloated = isBloatedFolder(a) ? 1 : 0;
  const bBloated = isBloatedFolder(b) ? 1 : 0;
  if (aBloated !== bBloated) return aBloated - bBloated;

  const aHasSlot = a.freeUploadSlots > 0 ? 1 : 0;
  const bHasSlot = b.freeUploadSlots > 0 ? 1 : 0;
  if (aHasSlot !== bHasSlot) return bHasSlot - aHasSlot;

  if (a.queueLength !== b.queueLength) return a.queueLength - b.queueLength;

  if (a.format === 'FLAC' && b.format !== 'FLAC') return -1;
  if (b.format === 'FLAC' && a.format !== 'FLAC') return 1;

  if (a.uploadSpeed !== b.uploadSpeed) return b.uploadSpeed - a.uploadSpeed;

  // Per-file rather than total size: the point of this tiebreaker is "the
  // better rip", and total size conflates that with "the folder has more files
  // in it" — which is how a dump used to win outright.
  return avgFileSizeMb(b) - avgFileSizeMb(a);
}

function avgFileSizeMb(c: FolderCandidate): number {
  return c.files.length ? c.estimatedSizeMb / c.files.length : 0;
}

export interface FolderCandidate {
  directory: string;
  username: string;
  files: HuntFile[];
  matchedTracks: number;
  totalTracks: number;
  matchPct: number;
  format: string; // dominant format: "FLAC", "MP3", "Mixed", etc.
  estimatedSizeMb: number;
  isLive: boolean;
  // Peer health (from the slskd search response). Used to rank candidates so
  // we don't commit a whole album to an overloaded/slow peer that truncates.
  freeUploadSlots: number;
  queueLength: number;
  uploadSpeed: number;
}

/**
 * The outcome of a hunt: the scored folder candidates plus the two reasons an
 * empty result might not mean "not on Soulseek".
 *
 * `rateLimited` — slskd throttled us (429s that survived retry): "still
 * searching, hang on".
 *
 * `sourceOffline` — slskd is not logged in to Soulseek, so the queries never
 * reached the network at all (#1040). Without this the host reads a structural
 * outage as a genuine miss and gives up on an album that is perfectly available;
 * with it the acquire path can hold the work until the source is back.
 *
 * Both exist so an empty `candidates` is never silently overloaded.
 */
export interface HuntResult {
  candidates: FolderCandidate[];
  /** No base candidate was confidently complete, so skew variants were (or would be) worth firing. */
  skewNeeded: boolean;
  /** The literal queries this hunt actually submitted, in order. */
  queries: string[];
  /**
   * Searches submitted vs searches that ran to completion inside the deadline.
   * `searchesAnswered < searchesFired` means the source was busy (#1049): its
   * two lanes were held by something else and our searches sat queued. An
   * empty result is then not evidence about the album.
   */
  searchesFired: number;
  searchesAnswered: number;
  rateLimited: boolean;
  sourceOffline: boolean;
}

// Minimal structural shape of a slskd search response the recognizer needs. A
// full `SlskdSearchResponse` (extra fileCount/lockedFileCount fields) satisfies
// it, so captured raw responses can be replayed through `scoreFolders` verbatim.
export interface ScoreResponse {
  username: string;
  freeUploadSlots?: number;
  queueLength?: number;
  uploadSpeed?: number;
  files: Array<{ filename: string; size: number; bitRate?: number }>;
}

// The pure, IO-free recognizer core: group raw slskd responses into folders,
// score each against the canonical tracklist, rank best-first, cap at 20. why:
// extracted out of the wave I/O (`wave`, which owns the network) so a captured
// feedback fixture — canonical tracklist + raw responses — can replay the exact
// ranking offline in a test and assert the human-correct folder ranks #1.
export function scoreFolders(
  canonicalTracks: Array<{ title: string }>,
  responses: ScoreResponse[],
): FolderCandidate[] {
  // Group files by directory+username (a unique "folder")
  const folderMap = new Map<string, { username: string; files: HuntFile[] }>();

  // Per-peer health, merged across responses. A peer's free-slot count
  // fluctuates between responses; keep the best-seen so a momentarily-busy
  // snapshot doesn't permanently sink an otherwise-good peer.
  const peerHealth = new Map<string, PeerHealth>();

  for (const response of responses) {
    const prev = peerHealth.get(response.username);
    peerHealth.set(response.username, {
      freeUploadSlots: Math.max(prev?.freeUploadSlots ?? 0, response.freeUploadSlots ?? 0),
      queueLength: Math.min(prev?.queueLength ?? Infinity, response.queueLength ?? 0),
      uploadSpeed: Math.max(prev?.uploadSpeed ?? 0, response.uploadSpeed ?? 0),
    });

    for (const file of response.files) {
      const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;

      const dir = extractDirectory(file.filename);
      const key = `${response.username}::${dir}`;

      if (!folderMap.has(key)) {
        folderMap.set(key, { username: response.username, files: [] });
      }
      const folder = folderMap.get(key)!;
      // Dedupe: parallel queries frequently surface the same file from one peer.
      if (folder.files.some((existing) => existing.filename === file.filename)) {
        continue;
      }
      folder.files.push({ filename: file.filename, size: file.size, bitRate: file.bitRate });
    }
  }

  // Score each folder against canonical tracklist
  const normalizedCanonical = canonicalTracks.map((t) => normalizeTitle(t.title));
  // A single (exactly 1 canonical track) is scored with the qualifier-aware
  // strength (see SINGLE_PARTIAL_PCT) instead of the all-or-nothing matched/1
  // formula, keeping both the full and the qualifier-stripped "core" form.
  const single =
    canonicalTracks.length === 1
      ? {
          full: normalizeTitle(canonicalTracks[0].title),
          core: normalizeTitle(stripTitleQualifiers(canonicalTracks[0].title)),
        }
      : null;

  const candidates: FolderCandidate[] = [];

  for (const [key, { username, files }] of folderMap) {
    const dir = key.slice(username.length + 2); // strip "username::"
    const baseNames = files.map((f) => {
      const basename = f.filename.replace(/\\/g, '/').split('/').pop() ?? f.filename;
      return basename.slice(0, basename.lastIndexOf('.') || basename.length);
    });

    let matched: number;
    let matchPct: number;
    if (single) {
      const strength = baseNames.reduce(
        (best, n) =>
          Math.max(
            best,
            singleMatchStrength(
              single.full,
              single.core,
              normalizeTitle(n),
              normalizeTitle(stripTitleQualifiers(n)),
            ),
          ),
        0,
      );
      matched = strength > 0 ? 1 : 0;
      matchPct = strength;
    } else {
      const normalizedFiles = baseNames.map(normalizeTitle);
      let m = 0;
      for (const canonicalTrack of normalizedCanonical) {
        if (normalizedFiles.some((fn) => titlesOverlap(canonicalTrack, fn))) {
          m++;
        }
      }
      matched = m;
      matchPct = Math.round((m / (canonicalTracks.length || 1)) * 100);
    }
    if (matchPct < MIN_FLOOR_PCT) continue;

    const totalTracks = canonicalTracks.length || 1;
    const format = detectFormat(files);
    const estimatedSizeMb = files.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024);
    const health = peerHealth.get(username);

    candidates.push({
      directory: dir,
      username,
      files,
      matchedTracks: matched,
      totalTracks,
      matchPct,
      format,
      estimatedSizeMb: Math.round(estimatedSizeMb * 10) / 10,
      isLive: isLiveFolder(dir),
      freeUploadSlots: health?.freeUploadSlots ?? 0,
      queueLength: Number.isFinite(health?.queueLength) ? health!.queueLength : 0,
      uploadSpeed: health?.uploadSpeed ?? 0,
    });
  }

  candidates.sort(compareCandidates);

  return candidates.slice(0, 20);
}

export class AlbumHunterService {
  private readonly source: SourceConnection;
  private readonly lanes: SearchLanes;
  private readonly waveTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private slskd: Slskd,
    source?: SourceConnection,
    lanes?: SearchLanes,
    timing: { waveTimeoutMs?: number; pollIntervalMs?: number } = {},
  ) {
    this.source = source ?? new SourceConnection({ current: slskd });
    this.lanes = lanes ?? new SearchLanes();
    this.waveTimeoutMs = timing.waveTimeoutMs ?? WAVE_TIMEOUT_MS;
    this.pollIntervalMs = timing.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  /**
   * One hunt = one lane session: the base pair first, then — only while no
   * candidate is confidently complete — the skew variants two at a time, most
   * precise first. Each wave fits the source's two lanes exactly, so a hunt never
   * queues behind itself, and a strong early wave adds no further searches.
   */
  async hunt(
    artistName: string,
    albumTitle: string,
    canonicalTracks: CanonicalTrackRef[],
    opts: { skewSearch?: boolean } = {},
  ): Promise<HuntResult> {
    return this.lanes.run('user', async () => {
      const baseQs = baseQueries(artistName, albumTitle);
      const base = await this.wave(baseQs);
      let candidates = scoreFolders(canonicalTracks, base.responses);
      const bestBasePct = candidates.length ? candidates[0].matchPct : 0;
      const skewNeeded = opts.skewSearch !== false && bestBasePct < SKEW_TRIGGER_PCT;
      const acc: HuntResult = {
        candidates,
        skewNeeded,
        queries: [...baseQs],
        searchesFired: base.fired,
        searchesAnswered: base.answered,
        rateLimited: base.rateLimited,
        sourceOffline: base.sourceOffline,
      };
      if (!opts.skewSearch || !skewNeeded) return acc;

      const skewed = buildSkewedQueries(artistName, albumTitle, baseQs).slice(0, MAX_SKEW_QUERIES);
      for (let i = 0; i < skewed.length; i += SEARCH_LANES) {
        // Stop once a wave found a confident folder, or the source is offline —
        // the remaining variants would only hold the lanes for nothing.
        const bestPct = candidates.length ? candidates[0].matchPct : 0;
        if (bestPct >= SKEW_TRIGGER_PCT || acc.sourceOffline) break;
        const chunk = skewed.slice(i, i + SEARCH_LANES);
        const w = await this.wave(chunk);
        candidates = mergeCandidates(candidates, scoreFolders(canonicalTracks, w.responses));
        acc.candidates = candidates;
        acc.queries.push(...chunk);
        acc.searchesFired += w.fired;
        acc.searchesAnswered += w.answered;
        acc.rateLimited = acc.rateLimited || w.rateLimited;
        acc.sourceOffline = acc.sourceOffline || w.sourceOffline;
      }
      return acc;
    });
  }

  // Phase-1 of a two-phase hunt: run base queries only and report whether skew
  // is needed (so the frontend can highlight the query list in real time).
  async huntBase(
    artistName: string,
    albumTitle: string,
    canonicalTracks: CanonicalTrackRef[],
    opts: { skewSearch?: boolean } = {},
  ): Promise<HuntResult & { responses: ScoreResponse[] }> {
    const baseQs = baseQueries(artistName, albumTitle);
    // Keep the raw responses (not just the scored candidates): feedback capture
    // snapshots them so a replay fixture can re-run scoreFolders offline —
    // including sub-floor folders the recognizer wrongly dropped.
    const w = await this.lanes.run('user', () => this.wave(baseQs));
    const candidates = scoreFolders(canonicalTracks, w.responses);
    const bestBasePct = candidates.length ? candidates[0].matchPct : 0;
    const skewNeeded = opts.skewSearch !== false && bestBasePct < SKEW_TRIGGER_PCT;
    return {
      candidates,
      skewNeeded,
      queries: baseQs,
      responses: w.responses,
      searchesFired: w.fired,
      searchesAnswered: w.answered,
      rateLimited: w.rateLimited,
      sourceOffline: w.sourceOffline,
    };
  }

  // Phase-2 of a two-phase hunt: run skew-variant queries (in lane-sized waves,
  // stopping at the first confident folder) and return their candidates
  // independently. The caller (frontend) merges with base results.
  async huntSkew(
    artistName: string,
    albumTitle: string,
    canonicalTracks: CanonicalTrackRef[],
  ): Promise<HuntResult> {
    const baseQs = baseQueries(artistName, albumTitle);
    const skewed = buildSkewedQueries(artistName, albumTitle, baseQs).slice(0, MAX_SKEW_QUERIES);
    const acc: HuntResult = {
      candidates: [],
      skewNeeded: false,
      queries: [],
      searchesFired: 0,
      searchesAnswered: 0,
      rateLimited: false,
      sourceOffline: false,
    };
    if (!skewed.length) return acc;
    return this.lanes.run('user', async () => {
      for (let i = 0; i < skewed.length; i += SEARCH_LANES) {
        const bestPct = acc.candidates.length ? acc.candidates[0].matchPct : 0;
        if (bestPct >= SKEW_TRIGGER_PCT || acc.sourceOffline) break;
        const chunk = skewed.slice(i, i + SEARCH_LANES);
        const w = await this.wave(chunk);
        acc.candidates = mergeCandidates(acc.candidates, scoreFolders(canonicalTracks, w.responses));
        acc.queries.push(...chunk);
        acc.searchesFired += w.fired;
        acc.searchesAnswered += w.answered;
        acc.rateLimited = acc.rateLimited || w.rateLimited;
        acc.sourceOffline = acc.sourceOffline || w.sourceOffline;
      }
      return acc;
    });
  }

  // Create one search, retrying a 429 (slskd rate-limiting the burst) with
  // backoff. Returns the search, or null with `rateLimited` telling the caller
  // whether the miss was throttling (the hunt is incomplete) or a genuine
  // failure (a genuine miss). A non-429 error is not retried.
  private async createSearch(
    q: string,
  ): Promise<{ search: { id: string } | null; rateLimited: boolean; sourceOffline: boolean }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const search = await this.slskd.searches.create(q, { searchTimeoutMs: SEARCH_TIMEOUT_MS });
        return { search, rateLimited: false, sourceOffline: false };
      } catch (err) {
        const is429 = err instanceof SlskdRequestError && err.status === 429;
        if (is429 && attempt < SEARCH_429_MAX_RETRIES) {
          await sleep(SEARCH_429_BACKOFF_MS * (attempt + 1));
          continue;
        }
        const is409 = err instanceof SlskdRequestError && err.status === 409;
        const sourceOffline = is409 ? !(await this.source.isReady()) : false;
        log.warn({ q, err, sourceOffline }, 'Search create failed');
        return { search: null, rateLimited: is429, sourceOffline };
      }
    }
  }

  // The I/O half of one wave: create the searches, poll to completion, clean
  // up, and return the raw slskd responses plus how many of the searches
  // actually ran to completion. Kept separate from `scoreFolders` (the pure
  // recognizer) so a hunt can surface its raw responses for feedback capture
  // without re-running the network.
  private async wave(queries: string[]): Promise<WaveResult> {
    const created = await mapPool(queries, SEARCH_LANES, (q) => this.createSearch(q));
    const searchIds = created.map((c) => c.search?.id).filter((id): id is string => Boolean(id));
    const sourceOffline = created.some((c) => c.sourceOffline);
    // Rate-limited only if a query was dropped to a 429 *and* we didn't otherwise
    // get results — an incomplete hunt the user can retry, not a genuine miss.
    const rateLimited = created.some((c) => c.rateLimited) && searchIds.length < queries.length;
    if (!searchIds.length) {
      return {
        responses: [],
        fired: queries.length,
        answered: 0,
        rateLimited: created.some((c) => c.rateLimited),
        sourceOffline,
      };
    }

    try {
      const { responses, answered } = await this.pollUntilDone(searchIds);
      return { responses, fired: queries.length, answered, rateLimited, sourceOffline };
    } finally {
      // Clean up searches (bounded — the same burst that 429s creates also 429s
      // deletes, and leaked searches pile up in slskd's history).
      await mapPool(searchIds, SEARCH_LANES, (id) =>
        this.slskd.searches.delete(id).catch(() => {}),
      );
    }
  }

  private async pollUntilDone(
    searchIds: string[],
  ): Promise<{ responses: ScoreResponse[]; answered: number }> {
    const deadline = Date.now() + this.waveTimeoutMs;
    let states: Array<{ state: string } | null> = [];

    while (Date.now() < deadline) {
      states = await Promise.all(
        searchIds.map((id) => this.slskd.searches.get(id).catch(() => null)),
      );
      if (states.every((s) => !s || searchIsDone(s.state))) break;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }

    // A search still `Queued`/`InProgress` at the deadline (or one slskd
    // errored) answered nothing — the count is what lets the host tell "the
    // album is not there" from "the source was busy" (#1049).
    const answered = states.filter((s) => s && searchIsDone(s.state) && !s.state.includes('Errored')).length;

    // Gather all responses from all searches
    const responseSets = await Promise.all(
      searchIds.map((id) => this.slskd.searches.getResponses(id).catch(() => [])),
    );

    return { responses: responseSets.flat(), answered };
  }
}

/** slskd reports a finished search as `Completed[, <reason>]`; anything else is still queued or running. */
function searchIsDone(state: string): boolean {
  return state.startsWith('Completed');
}

interface WaveResult {
  responses: ScoreResponse[];
  fired: number;
  answered: number;
  rateLimited: boolean;
  sourceOffline: boolean;
}

// Merge two candidate lists (base + skewed), de-duplicating by the unique
// folder key (username::directory) and keeping the higher-scoring instance, then
// re-rank with the shared comparator. why: the same peer folder can surface from
// both the base and a skewed query; without de-duping it would appear twice.
function mergeCandidates(base: FolderCandidate[], extra: FolderCandidate[]): FolderCandidate[] {
  const byKey = new Map<string, FolderCandidate>();
  for (const c of [...base, ...extra]) {
    const key = `${c.username}::${c.directory}`;
    const prev = byKey.get(key);
    if (!prev || c.matchPct > prev.matchPct) byKey.set(key, c);
  }
  return [...byKey.values()].sort(compareCandidates).slice(0, 20);
}

function extractDirectory(filename: string): string {
  // slskd filenames use backslashes on Windows peers
  const normalized = filename.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
}

// Strength of a single (1-track) hunt match: 100 when the full normalized titles
// overlap, SINGLE_PARTIAL_PCT when only their qualifier-stripped cores overlap
// (ranked below an exact hit, still above MIN_FLOOR_PCT), 0 otherwise.
export function singleMatchStrength(
  canonicalFull: string,
  canonicalCore: string,
  fileFull: string,
  fileCore: string,
): number {
  if (titlesOverlap(canonicalFull, fileFull)) return 100;
  if (canonicalCore && fileCore && titlesOverlap(canonicalCore, fileCore)) {
    return SINGLE_PARTIAL_PCT;
  }
  return 0;
}

function isLiveFolder(dir: string): boolean {
  const lower = dir.toLowerCase();
  return /\blive\b|\bconcert\b|\bin concert\b/.test(lower);
}

function detectFormat(files: HuntFile[]): string {
  const extensions = files.map((f) => f.filename.slice(f.filename.lastIndexOf('.')).toLowerCase());
  const counts = new Map<string, number>();
  for (const ext of extensions) counts.set(ext, (counts.get(ext) ?? 0) + 1);

  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!dominant) return 'Unknown';

  if (dominant[0] === '.flac') return 'FLAC';
  if (dominant[0] === '.mp3') {
    // Try to infer bitrate from the most common bitRate value
    const bitRates = files.map((f) => f.bitRate).filter(Boolean) as number[];
    if (bitRates.length) {
      const avgBitRate = Math.round(bitRates.reduce((a, b) => a + b, 0) / bitRates.length);
      return `MP3 ${avgBitRate}kbps`;
    }
    return 'MP3';
  }
  if (dominant[0] === '.opus') return 'Opus';
  if (dominant[0] === '.ogg') return 'Ogg';
  if (counts.size > 1) return 'Mixed';
  return dominant[0].slice(1).toUpperCase();
}
