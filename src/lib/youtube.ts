import "server-only";

import ytRedis from "@/lib/yt-redis";
import {
  UNIT_COST,
  dailySearchBudget,
  endpointFor,
  getAvailableProject,
  getQuotaStatus,
  hasProjects,
  markProjectExhausted,
  recordUsage,
  type OpType,
} from "@/lib/youtube-pool";
import {
  findGeneralSongs,
  findSongByVideoId,
  findSongsByGenre,
  findSongsByIds,
  findAllSongs,
  redisUsageToday,
  searchSongFuzzy,
  thumbnailFor,
  touchLastPlayed,
  unitsUsedToday,
  upsertSong,
  type SongInput,
} from "@/lib/youtube-db";

/**
 * YouTube Data API v3 client for the hybrid catalog layer.
 *
 * Phonq's primary catalog is Jamendo (legal, direct audio, no quota). YouTube
 * fills genre gaps where Jamendo's CC catalog is thin (e.g. Brazilian funk) and
 * provides a "Play on YouTube" fallback for any track via the IFrame Player API.
 *
 * Stack:
 *
 *   Layer 1 — 10-project quota pool (`youtube-pool`). `search.list` (100 units)
 *     draws from the 2 projects reserved for live search; `videos.list` /
 *     `playlistItems.list` / `channels.list` (1 unit each) draw from the rest.
 *     Usage is metered in Redis (`quota:{project}:{opType}:{date}`, 24h TTL) and
 *     the router always picks the least-loaded project under its cap.
 *
 *   Layer 2 — Redis accelerator (`yt-redis`). `search:{query} → videoId` cache
 *     (24h), a `song:{videoId}` metadata read-through (12h), and `neg:{query}`
 *     (2h "nothing good") skip both the DB and the API on hot lookups.
 *     Counters + the bandwidth meter are best-effort; Redis down ⇒ transparent
 *     fall-through to Postgres.
 *
 *   Layer 3 — the `songs` store (`youtube-db`). Lean catalog (no thumbnail URLs,
 *     no raw API dumps), in a dedicated Neon DB when `YOUTUBE_DATABASE_URL` is
 *     set. Lookup ladder: Redis hot cache ⇒ Postgres trigram match ⇒ live
 *     pooled search ⇒ negative cache. The DB is the only source of truth.
 *
 * All upstream errors are caught and logged server-side; callers get `null` /
 * empty arrays so the app degrades to Jamendo-only instead of breaking.
 */

export const YOUTUBE_BASE_URL = "https://www.googleapis.com/youtube/v3";

/** `search.list` costs 100 units; `videos.list` / `playlistItems.list` cost 1. */
export const SEARCH_UNITS = 100;
/** `videoCategoryId=10` is Music; strips non-music uploads at the query level. */
export const VIDEO_CATEGORY_MUSIC = "10";

/* ------------------------------------------------------------------ */
/* Redis cache TTLs (env-overridable)                                  */
/*                                                                     */
/* With a 200 MB budget (maxmemory 200mb, allkeys-lru) the accelerator  */
/* holds the hot-lookup keys for the whole catalog, not a thin slice:  */
/*   search:{query} → video_id    TTL 24h (default)                    */
/*   song:{video_id} → JSON        TTL 12h (read-through)              */
/*   neg:{query}      → "1"        TTL 2h  (negative cache)            */
/*   quota:...        → counter    TTL 24h                             */
/* ------------------------------------------------------------------ */
function ttlFromEnv(name: string, fallbackSec: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackSec;
}
/** How long a resolved `search:{query} → video_id` mapping is trusted. */
export const SEARCH_CACHE_TTL = ttlFromEnv("YOUTUBE_REDIS_SEARCH_TTL", 24 * 3600);
/** How long a `song:{video_id}` read-through entry stays warm. */
export const SONG_CACHE_TTL = ttlFromEnv("YOUTUBE_REDIS_SONG_TTL", 12 * 3600);
/** How long a known-bad query is held in the negative cache. */
export const NEG_CACHE_TTL = ttlFromEnv("YOUTUBE_REDIS_NEG_TTL", 2 * 3600);

/** Payload stored under `song:{video_id}` — small JSON (no thumbnail URL,
 * reconstructed on read from the id), ~150-250 bytes per entry. */
interface SongCachePayload {
  videoId: string;
  title: string;
  artistName: string;
  duration: number;
  channelId: string | null;
  channelTitle: string | null;
  embeddable: boolean;
  subgenre: string | null;
  source: string;
}

function songCacheKey(videoId: string): string {
  return `song:${videoId}`;
}

/** Read a song's metadata from the `song:{videoId}` read-through cache. */
async function cacheGetSong(videoId: string): Promise<YouTubeVideo | null> {
  if (!videoId) return null;
  const payload = await ytRedis.cacheGet<SongCachePayload>(songCacheKey(videoId));
  if (!payload) return null;
  return {
    videoId: payload.videoId,
    title: payload.title,
    artistName: payload.artistName,
    duration: payload.duration,
    thumbnail: thumbnailFor(payload.videoId),
    channelId: payload.channelId,
    channelTitle: payload.channelTitle,
    embeddable: payload.embeddable,
    subgenre: payload.subgenre,
    source: payload.source,
  };
}

/** Warm the `song:{videoId}` read-through cache (best-effort, fire-and-forget). */
function cacheSetSong(video: YouTubeVideo): void {
  const payload: SongCachePayload = {
    videoId: video.videoId,
    title: video.title,
    artistName: video.artistName,
    duration: video.duration,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    embeddable: video.embeddable,
    subgenre: video.subgenre,
    source: video.source,
  };
  void ytRedis.cacheSet(songCacheKey(video.videoId), payload, SONG_CACHE_TTL);
}

/**
 * Near-disqualifying title signals (case-insensitive, word-boundary safe).
 * These are unambiguous junk: mixes, compilations, hour-long re-ups, lyric
 * slideshows, karaoke, reactions, type beats. A match hard-drops the candidate
 * in genre/search fills and costs -100 in the resolution pipeline.
 *
 * Deliberately NOT here: bare "remix" (for Brazilian funk the official remix is
 * often the primary release), and "live"/"ao vivo"/"cover" — those are official
 * artist publications (an "(Ao Vivo)" cut is frequently THE hit), so they get a
 * soft deprioritization instead of disqualification.
 */
const TITLE_JUNK_RE =
  /\b(mix(es)?|mixtape|compilation|full album|one hour|1 hour|playlist|top \d+|melhores|remix pack|non-?stop|karaoke|reaction|lyrics? video|type beat|instrumental only)\b/i;

/** Legitimate-but-less-desirable signals: official live/covers lose to the
 * studio original but must never be dropped outright. */
const TITLE_DEPRIORITIZE_RE = /\b(live|ao vivo|cover)\b/i;

/** Sane track-length window in seconds (2:00–7:00), tuned for full-length
 * official audio uploads. Kills Shorts (<1m), DJ sets, mixes and whole
 * albums uploaded as a single video. */
const DURATION_MAX = 7 * 60;
const DURATION_MIN = 120;
/** Brazilian funk often runs shorter (2:00–3:30); lower the floor to 1:30. */
const DURATION_MIN_FUNK = 90;

/** Duration bounds (seconds) for a track window, genre-aware. */
export function durationBounds(subgenre?: string | null): { min: number; max: number } {
  const min = /brazil/i.test(subgenre ?? "") ? DURATION_MIN_FUNK : DURATION_MIN;
  return { min, max: DURATION_MAX };
}

const globalForYouTube = globalThis as unknown as {
  __phonqYouTubeSearches?: Map<string, number>;
};

/** Cheap in-process per-request dedupe so a burst of lookups for the same song
 * (e.g. a queue that references it twice) doesn't double-spend quota. */
function markSearch(key: string): boolean {
  const map = globalForYouTube.__phonqYouTubeSearches ?? (globalForYouTube.__phonqYouTubeSearches = new Map());
  const now = Date.now();
  if (map.size >= 1024) {
    for (const [k, at] of map) {
      if (now - at >= 60 * 1000) map.delete(k);
    }
  }
  const last = map.get(key) ?? 0;
  if (now - last < 60 * 1000) return false;
  map.set(key, now);
  return true;
}

export interface YouTubeVideo {
  videoId: string;
  title: string;
  artistName: string;
  duration: number;
  thumbnail: string | null;
  channelId: string | null;
  channelTitle: string | null;
  embeddable: boolean;
  subgenre: string | null;
  /** How the video was discovered: "search" | "playlist" | "channel". */
  source: string;
  /** Wikipedia topic categories (e.g. "https://en.wikipedia.org/wiki/Music");
   * a secondary music-confidence signal, only populated on live fetches. */
  topicCategories?: string[];
}

export interface YouTubeQuotaStatus {
  /** Units spent today (all endpoints, all projects). */
  unitsUsed: number;
  /** `search.list` calls made today. */
  searches: number;
  /** Remaining search budget for today (0 when exhausted). */
  searchesRemaining: number;
  budget: number;
  /** Per-project breakdown (Redis counters, Postgres fallback). */
  projects?: Array<{
    id: number;
    searchUsed: number;
    playbackUsed: number;
    dailyLimit: number;
  }>;
  /** True when at least one API key is configured. */
  configured: boolean;
  /** Redis accelerator capacity + bandwidth since the last flush. */
  redis?: {
    /** True when an Upstash REST endpoint is configured. */
    configured: boolean;
    /** True when the backing Redis answered a ping. */
    healthy: boolean;
    /** Number of keys stored (DBSIZE). */
    dbSize: number;
    /** In-process meter since the last flush (approx bytes). */
    ops: number;
    readBytes: number;
    writeBytes: number;
    hits: number;
    misses: number;
    /** Today's persisted ledger row (`redis_usage_log`), null when none. */
    today: {
      ops: number;
      readBytes: number;
      writeBytes: number;
      hits: number;
      misses: number;
    } | null;
  };
}

/* ------------------------------------------------------------------ */
/* Scoring helpers                                                     */
/* ------------------------------------------------------------------ */

/** Title → (songTitle, artistName). Handles "Artist - Song", "Song by Artist",
 * Topic-channel uploads ("Song" on "Artist - Topic"), "(Official Video)" etc. */
export function parseTitle(title: string, channelTitle: string | null): { songTitle: string; artistName: string } {
  let t = title.trim();
  t = t
    .replace(/\s*\(official\s*(music\s*)?video.*?\)\s*$/i, "")
    .replace(/\s*\(official\s*audio.*?\)\s*$/i, "")
    .replace(/\s*\(official\s*lyrics?.*?\)\s*$/i, "")
    .replace(/\s*\(lyrics?.*?\)\s*$/i, "")
    .replace(/\s*\(live\s*(session)?.*?\)\s*$/i, "")
    .replace(/\s*\(hd\)\s*$/i, "")
    .replace(/\s*\(4k\)\s*$/i, "")
    .trim();

  // Topic channel: channelTitle = "Artist - Topic", title is just the song.
  if (channelTitle) {
    const topicMatch = channelTitle.match(/^(.*?)\s*-\s*Topic$/i);
    if (topicMatch) {
      const artist = topicMatch[1]?.trim() ?? "";
      if (artist && t) return { songTitle: t, artistName: artist };
    }
  }

  // "Artist - Song" / "Artist – Song" / "Artist | Song"
  const sep = t.match(/^(.*?)\s*(?:-|–|—|:|~)\s+(.*)$/);
  if (sep && sep[1] && sep[2]) {
    return { songTitle: sep[2].trim(), artistName: sep[1].trim() };
  }

  // "Song · Artist" or "Song by Artist"
  const by = t.match(/^(.*?)\s*(?:·|by)\s+(.*)$/i);
  if (by && by[1] && by[2]) {
    return { songTitle: by[1].trim(), artistName: by[2].trim() };
  }

  return { songTitle: t, artistName: "" };
}

/** Normalize a name for keying/matching: lowercase, strip accents+punctuation. */
export function normalizeKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when a title carries a near-disqualifying signal (unambiguous junk:
 * mixes, compilations, hour-long re-ups, lyric slideshows, karaoke…). */
export function isBlacklistedTitle(title: string): boolean {
  return TITLE_JUNK_RE.test(title);
}

/** True when a title is a legitimate-but-deprioritized official release:
 * "(Ao Vivo)"/"(Live)" cuts and covers lose to studio originals but are never
 * dropped — for Brazilian funk the live version is often the primary release. */
export function isDeprioritizedTitle(title: string): boolean {
  return TITLE_DEPRIORITIZE_RE.test(title);
}

/** Whether `duration` (seconds) sits inside the sane track-length window. */
function durationInRange(duration: number, subgenre?: string | null): boolean {
  if (duration <= 0) return false; // unknown duration (no videos.list hit) → no bonus
  const { min, max } = durationBounds(subgenre);
  return duration > min && duration < max;
}

/** Topic-channel check — the highest-signal filter. Auto-generated "{Artist} -
 * Topic" channels contain only official audio (one video per track). */
export function isTopicChannel(channelTitle: string | null | undefined): boolean {
  return /- topic$/i.test(channelTitle ?? "");
}

/** Music-indicating Wikipedia topic category → weak positive confidence. */
function hasMusicTopic(topicCategories?: string[]): boolean {
  return (topicCategories ?? []).some((c) => /\bmusic\b/i.test(c));
}

/** Quality score for a cataloged song based on uploader signals, used later by
 * the monthly prune. Topic channels (ground truth) and official/VEVO uploads are
 * kept longest; generic uploads are pruned first if never played. */
export function channelQuality(channelTitle: string | null | undefined): number {
  if (isTopicChannel(channelTitle)) return 50;
  if (/vevo/i.test(channelTitle ?? "")) return 45;
  if (/official/i.test(channelTitle ?? "")) return 42;
  return 25;
}

/** Score for a `search.list` winner from the layered pipeline. */
function winnerQuality(score: number): number {
  return Math.max(30, Math.min(100, Math.round(score)));
}

/* ------------------------------------------------------------------ */
/* Per-project channel stats                                           */
/* ------------------------------------------------------------------ */

interface ChannelStats {
  customUrl?: string;
  country?: string;
  subscriberCount: number;
  viewCount: number;
}

interface ChannelItem {
  id?: string;
  snippet?: { customUrl?: string; country?: string };
  statistics?: { subscriberCount?: string; viewCount?: string };
}

interface ChannelResponse {
  items?: ChannelItem[];
}

async function channelStats(ids: string[]): Promise<Map<string, ChannelStats>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, ChannelStats>();
  if (unique.length === 0) return out;
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await ytGet<ChannelResponse>("channels", { part: "snippet,statistics", id: chunk.join(",") }, "playback");
    for (const item of data?.items ?? []) {
      if (!item.id) continue;
      const subscriberCount = Number(item.statistics?.subscriberCount) || 0;
      const viewCount = Number(item.statistics?.viewCount) || 0;
      out.set(item.id, {
        customUrl: item.snippet?.customUrl,
        country: item.snippet?.country,
        subscriberCount,
        viewCount,
      });
    }
  }
  return out;
}

/** +10 when the uploader looks like an official artist: real subscriber count
 * with a sane subscriber→view ratio, ideally with branding handles set. */
function channelReputationScore(channel: ChannelStats | null | undefined): number {
  if (!channel) return 0;
  const { subscriberCount, viewCount } = channel;
  const saneRatio = viewCount === 0 || viewCount / Math.max(subscriberCount, 1) < 1000;
  let score = 0;
  if (subscriberCount >= 50 && saneRatio) score += 10;
  if (channel.customUrl) score += 1;
  if (channel.country) score += 1;
  return score;
}

/* ------------------------------------------------------------------ */
/* Candidate scoring                                                   */
/* ------------------------------------------------------------------ */

interface SearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelId?: string;
    channelTitle?: string;
    description?: string;
    thumbnails?: { medium?: { url?: string } };
  };
}

interface SearchResponse {
  items?: SearchItem[];
}

/** A search candidate with its layered-pipeline score attached. */
interface RankedVideo extends YouTubeVideo {
  score: number;
}

/** Rank every search candidate through the layered scoring pipeline:
 *
 *    Channel is "- Topic"                  +50   (ground-truth signal)
 *    Title matches junk blacklist          -100  (near-disqualifying)
 *    Title is live/cover ("ao vivo")        -5   (deprioritize, never drop)
 *    Title contains the artist name        +15
 *    Duration inside the sane range        +20
 *    Has music topicCategories             +10
 *    Channel sub/view ratio looks official  +10
 *
 * Candidates that can't plausibly be the requested song (no title/channel
 * match for the artist or song) are dropped first; winners are ranked by
 * score, ties broken by VEVO/official branding and a thumbnail.
 */
function rankCandidates(
  items: SearchItem[],
  metas: YouTubeVideo[],
  channels: Map<string, ChannelStats>,
  songTitle: string,
  artistName: string,
  subgenre?: string,
): RankedVideo[] {
  const song = normalizeKey(songTitle);
  const artist = normalizeKey(artistName);
  const metaByVideoId = new Map(metas.map((m) => [m.videoId, m]));
  const ranked: RankedVideo[] = [];

  for (const item of items) {
    const videoId = item.id?.videoId;
    if (!videoId) continue;
    const meta = metaByVideoId.get(videoId);
    if (!meta || !meta.embeddable) continue;

    const title = meta.title || item.snippet?.title || "";
    const channelTitle = meta.channelTitle || item.snippet?.channelTitle || "";
    const nTitle = normalizeKey(title);
    const nChannel = normalizeKey(channelTitle);

    // Relevance floor: must plausibly reference the requested song or artist.
    if (!(song && nTitle.includes(song)) && !(artist && (nTitle.includes(artist) || nChannel.includes(artist)))) {
      continue;
    }

    let score = 0;
    if (isTopicChannel(channelTitle)) score += 50;
    if (isBlacklistedTitle(title)) score -= 100;
    if (isDeprioritizedTitle(title)) score -= 5;
    if (artist && nTitle.includes(artist)) score += 15;
    if (durationInRange(meta.duration, subgenre)) score += 20;
    if (hasMusicTopic(meta.topicCategories)) score += 10;
    score += channelReputationScore(channels.get(meta.channelId ?? ""));

    // Stability tiebreakers.
    if (/vevo/i.test(channelTitle)) score += 2;
    if (/official/i.test(channelTitle)) score += 1;
    if (item.snippet?.thumbnails?.medium?.url) score += 1;

    ranked.push({ ...meta, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/* ------------------------------------------------------------------ */
/* Low-level fetch helpers                                             */
/* ------------------------------------------------------------------ */

interface GoogleApiError extends Error {
  status?: number;
  reason?: string;
}

/**
 * Fetch a YouTube Data API page, drawing the API key from the least-loaded
 * project in the pool for `op`. Records quota usage + an `api_call_log` row on a
 * successful call. Returns null when the pool is exhausted, the key is missing,
 * the request errors, or YouTube answers a quota/rate rejection (403 / 429).
 */
async function ytGet<T>(path: string, params: Record<string, string>, op: OpType): Promise<T | null> {
  const project = await getAvailableProject(op);
  if (!project) {
    if (op === "search") {
      console.warn(`[youtube] quota pool exhausted for ${op} — skipping ${path}`);
    }
    return null;
  }

  const url = new URL(`${YOUTUBE_BASE_URL}/${path}`);
  url.searchParams.set("key", project.apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), { cache: "no-store" });
  } catch (err) {
    console.error(`[youtube] network error for ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!res.ok) {
    const err: GoogleApiError = new Error(`YouTube API returned ${res.status} for ${path}`);
    err.status = res.status;
    try {
      const body = (await res.json()) as { error?: { message?: string; reason?: string } };
      err.reason = body.error?.reason;
      err.message = body.error?.message ?? err.message;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 403 || res.status === 429) {
      // Project suspended or quota/rate-exceeded. Charge the remaining headroom
      // so the router rotates to the next healthy project instead of retrying
      // one that's already spent for the day.
      await markProjectExhausted(project.id, op);
      console.warn(
        `[youtube] project ${project.id} rejected (${err.reason ?? `HTTP ${res.status}`}) — marked exhausted for today: ${err.message}`,
      );
    } else {
      console.error(`[youtube] ${err.message} (${err.reason ?? "unknown reason"})`);
    }
    return null;
  }

  const data = (await res.json()) as T;
  await recordUsage(project.id, op, UNIT_COST[op], endpointFor(path));
  return data;
}

/* ------------------------------------------------------------------ */
/* videos.list (batched, 1 unit per 50 ids)                            */
/* ------------------------------------------------------------------ */

interface VideoItem {
  id?: string;
  contentDetails?: { duration?: string };
  status?: { embeddable?: boolean; uploadStatus?: string };
  topicDetails?: { topicCategories?: string[] };
  snippet?: {
    title?: string;
    channelId?: string;
    channelTitle?: string;
    thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
  };
}

interface VideosResponse {
  items?: VideoItem[];
}

/** ISO-8601 duration (PT1M30S) → seconds. */
export function isoDurationToSeconds(iso: string | undefined): number {
  if (!iso) return 0;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) || 0;
}

function videoItemToVideo(item: VideoItem): YouTubeVideo | null {
  if (!item.id) return null;
  return {
    videoId: item.id,
    title: item.snippet?.title ?? "",
    artistName: item.snippet?.channelTitle ?? "",
    duration: isoDurationToSeconds(item.contentDetails?.duration),
    thumbnail: item.snippet?.thumbnails?.medium?.url ?? item.snippet?.thumbnails?.default?.url ?? null,
    channelId: item.snippet?.channelId ?? null,
    channelTitle: item.snippet?.channelTitle ?? null,
    embeddable: item.status?.embeddable ?? true,
    subgenre: null,
    source: "search",
    topicCategories: item.topicDetails?.topicCategories,
  };
}

/** Fetch fresh metadata for up to 50 videos (1 unit per call, batched). */
async function videosList(ids: string[]): Promise<YouTubeVideo[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const out: YouTubeVideo[] = [];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await ytGet<VideosResponse>("videos", { part: "snippet,contentDetails,status,topicDetails", id: chunk.join(",") }, "playback");
    if (!data?.items) continue;
    for (const item of data.items) {
      const video = videoItemToVideo(item);
      if (video) out.push(video);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Persistence (Layer 3: the `songs` catalog store)                    */
/* ------------------------------------------------------------------ */

function toSongInput(video: YouTubeVideo, qualityScore: number): SongInput {
  return {
    videoId: video.videoId,
    title: video.title,
    artist: video.artistName,
    channelId: video.channelId,
    channelTitle: video.channelTitle,
    durationSec: video.duration,
    genreTag: video.subgenre,
    qualityScore,
    embedStatus: video.embeddable,
    source: video.source,
  };
}

/** Persist a resolved/seeded video into the `songs` catalog (best-effort) and
 * warm the `song:{videoId}` read-through cache so later resolves skip Postgres. */
async function persistSong(video: YouTubeVideo, qualityScore: number): Promise<void> {
  await upsertSong(toSongInput(video, qualityScore));
  cacheSetSong(video);
}

/* ------------------------------------------------------------------ */
/* search.list + ranking                                               */
/* ------------------------------------------------------------------ */

/** Outcome of a live search, so callers can distinguish "searched, nothing
 * good found" (negative-cache it) from "the API/pool failed" (retry later). */
export type SongSearchOutcome =
  | { kind: "hit"; video: YouTubeVideo }
  | { kind: "miss" }
  | { kind: "error" };

/**
 * Run a real `search.list` call (100 units) for a song, rank the candidates
 * via the layered scoring pipeline (videoCategoryId=10 already applied at the
 * query), and cache the winner. The caller is responsible for the per-process
 * 60s dedupe guard (`markSearch`) so a burst doesn't double-spend.
 */
async function searchAndCache(
  songTitle: string,
  artistName: string,
  subgenre?: string,
): Promise<SongSearchOutcome> {
  const artist = normalizeKey(artistName);
  const queries = [
    artistName && songTitle ? `${artistName} ${songTitle}` : songTitle,
    songTitle,
  ].filter(Boolean);
  const query = queries[0] ?? "";

  const data = await ytGet<SearchResponse>(
    "search",
    {
      part: "snippet",
      type: "video",
      q: query,
      maxResults: "25",
      safeSearch: "none",
      relevanceLanguage: "en",
      videoCategoryId: VIDEO_CATEGORY_MUSIC,
    },
    "search",
  );
  if (!data?.items) return { kind: "error" };

  // Fetch fresh metadata (duration, embed status, topic categories) for every
  // candidate in one 1-unit batched videos.list call, then score them all.
  const items = data.items;
  const ids = items.map((i) => i.id?.videoId).filter((x): x is string => Boolean(x));
  const metas = await videosList(ids);

  // Degrade gracefully: if videos.list failed for some/all candidates, synthesize
  // snippet-only metadata so ranking still runs (fewer signals, same winner logic).
  const metaByVideoId = new Map(metas.map((m) => [m.videoId, m]));
  const allMetas: YouTubeVideo[] = items.flatMap((item) => {
    const videoId = item.id?.videoId;
    if (!videoId) return [];
    const fresh = metaByVideoId.get(videoId);
    if (fresh) return [fresh];
    return [{
      videoId,
      title: item.snippet?.title ?? "",
      artistName: item.snippet?.channelTitle ?? "",
      duration: 0,
      thumbnail: item.snippet?.thumbnails?.medium?.url ?? null,
      channelId: item.snippet?.channelId ?? null,
      channelTitle: item.snippet?.channelTitle ?? null,
      embeddable: true,
      subgenre: null,
      source: "search",
    }];
  });
  if (allMetas.length === 0) return { kind: "miss" };

  const channels = await channelStats([...new Set(allMetas.map((m) => m.channelId).filter((x): x is string => Boolean(x)))]);
  const ranked = rankCandidates(items, allMetas, channels, songTitle, artistName, subgenre);
  const best = ranked[0];
  if (!best) return { kind: "miss" };

  const video: YouTubeVideo = {
    ...best,
    // videos.list reports the raw channel title as artist (e.g. "Artist -
    // Topic"); prefer the parsed artist from the real video title.
    artistName: parseTitle(best.title, best.channelTitle).artistName || artistName,
    subgenre: subgenre ?? null,
    source: "search",
  };

  await persistSong(video, winnerQuality(best.score));
  video.thumbnail = thumbnailFor(video.videoId);
  return { kind: "hit", video };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve a song (title + artist) to a YouTube video.
 *
 * Lookup ladder (Redis → Postgres trigram → pooled live search):
 *   1. Redis `search:{query}` hot cache (24h) → video id, then the
 *      `song:{videoId}` read-through cache (12h) → metadata without touching
 *      Postgres. Cold song entries fall back to the `songs` row and re-warm.
 *   2. Postgres trigram match on `songs` (artist/title `gin_trgm`).
 *   3. `search.list` via `getAvailableProject('search')` — 100 units, budget
 *      gated, winner persisted + cached so the next lookup is a free read.
 *
 * A negative cache (`neg:`) holds known-bad queries for 2h so a missing song is
 * never re-searched. Pool exhaustion falls through to the Postgres fuzzy match
 * (and the query is effectively queued for the next nightly seed); the function
 * never throws.
 */
export async function resolveSongVideo(
  songTitle: string,
  artistName: string,
  subgenre?: string,
): Promise<YouTubeVideo | null> {
  if (!songTitle.trim()) return null;
  if (!hasProjects()) return null;

  const songKey = normalizeKey(songTitle);
  const artistKey = normalizeKey(artistName);
  const cacheKey = `search:${artistKey ? `${artistKey}|${songKey}` : songKey}`;

  // 0. Negative cache — avoid re-searching known-bad queries for 2h.
  if (await ytRedis.cacheGet(`neg:${cacheKey}`)) return null;

  // 1. Redis hot cache (24h) → video id → song metadata via the `song:{videoId}`
  //    read-through cache; Postgres only on a cold entry.
  const cachedId = await ytRedis.cacheGet<string>(cacheKey);
  if (cachedId) {
    const cachedSong = await cacheGetSong(cachedId);
    if (cachedSong?.embeddable) {
      void touchLastPlayed(cachedSong.videoId);
      return cachedSong;
    }
    const song = await findSongByVideoId(cachedId);
    if (song?.embeddable) {
      cacheSetSong(song);
      void touchLastPlayed(song.videoId);
      return song;
    }
    // Cached id no longer in the catalog — fall through to fuzzy + live.
  }

  // 2. Postgres trigram fuzzy match (0 quota cost).
  const fuzzy = await searchSongFuzzy(songKey, artistKey, 1);
  if (fuzzy && fuzzy.length && fuzzy[0].embeddable) {
    const song = fuzzy[0];
    void ytRedis.cacheSet(cacheKey, song.videoId, SEARCH_CACHE_TTL);
    cacheSetSong(song);
    void touchLastPlayed(song.videoId);
    return song;
  }

  // 3. Live search via the pool (per-process dedupe guards bursts).
  const dedupeKey = `${songKey}|${artistKey}`;
  if (!markSearch(dedupeKey)) return null;

  const outcome = await searchAndCache(songTitle, artistName, subgenre);
  if (outcome.kind === "hit") {
    void ytRedis.cacheSet(cacheKey, outcome.video.videoId, SEARCH_CACHE_TTL);
    void touchLastPlayed(outcome.video.videoId);
    return outcome.video;
  }

  // 4. Negative-cache ONLY when the search executed and found nothing usable.
  // Pool exhaustion / upstream errors must not poison the query for 2h — the
  // song may resolve fine on the next attempt once the API recovers.
  if (outcome.kind === "miss") {
    void ytRedis.cacheSet(`neg:${cacheKey}`, "1", NEG_CACHE_TTL);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Runtime genre-gap fill (on-demand, budget-gated)                    */
/* ------------------------------------------------------------------ */

/** Per-process throttle so a burst of page renders doesn't re-search the same
 * genre within a day, and the winners are persisted for free reads. */
const genreFillAt: Map<string, number> = new Map();
const GENRE_FILL_DEDUPE_MS = 24 * 60 * 60 * 1000;

/** Opt out of live searches with `YOUTUBE_RUNTIME_FILL=0`; on by default. */
export function runtimeFillEnabled(): boolean {
  const value = (process.env.YOUTUBE_RUNTIME_FILL ?? "1").toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

/** Drop entries older than `maxAgeMs` once the map is large, so these
 * long-lived process-local throttles don't grow without bound. */
function pruneOlderThan(map: Map<string, number>, maxAgeMs: number): void {
  if (map.size < 1024) return;
  const now = Date.now();
  for (const [key, at] of map) {
    if (now - at >= maxAgeMs) map.delete(key);
  }
}

function genreFillDue(subgenre: string): boolean {
  const now = Date.now();
  const last = genreFillAt.get(subgenre) ?? 0;
  return now - last >= GENRE_FILL_DEDUPE_MS;
}

function markGenreFill(subgenre: string): void {
  pruneOlderThan(genreFillAt, GENRE_FILL_DEDUPE_MS);
  genreFillAt.set(subgenre, Date.now());
}

/** Skip low-quality "lyrics" results (no audio of their own). */
function isLyricResult(title: string | undefined, channelTitle: string | undefined): boolean {
  return /lyric(s)?/i.test(`${title ?? ""} ${channelTitle ?? ""}`);
}

/** Rank candidates for a genre (not a specific song): prefer auto-generated
 * Topic audio and official/VEVO uploads that carry a thumbnail. Official
 * "(Ao Vivo)"/"(Live)" cuts rank slightly below studio versions (never dropped). */
function genreCandidateScore(item: SearchItem): number {
  const title = item.snippet?.title ?? "";
  const channel = item.snippet?.channelTitle ?? "";
  let score = 0;
  if (title) score += 2;
  if (isDeprioritizedTitle(title)) score -= 1;
  if (channel.endsWith("- topic")) score += 4;
  if (channel.includes("vevo")) score += 2;
  if (channel.includes("official")) score += 1;
  if (item.snippet?.thumbnails?.medium?.url) score += 1;
  return score;
}

/**
 * Search YouTube live for a subgenre's tracks (e.g. "Brazilian Funk phonk") to
 * top up a genre that Jamendo's CC catalog can't fill — no manual seeding
 * required. Each genre is searched at most once per day (per process) and the
 * spend is capped by the rolling quota pool; winners are persisted so later
 * page loads are free DB reads. Lyrics videos and non-embeddable/short/long
 * items are dropped; the best candidates return as `YouTubeVideo`s tagged with
 * the subgenre.
 */
export async function fetchGenreVideos(
  subgenre: string,
  queries: string[],
  limit = 12,
): Promise<YouTubeVideo[]> {
  if (!hasProjects() || !runtimeFillEnabled() || limit <= 0) return [];
  if (queries.length === 0 || !genreFillDue(subgenre)) return [];

  const found: YouTubeVideo[] = [];
  const seenIds = new Set<string>();
  // Whether at least one live search call actually executed (API responded, not
  // just an empty candidate filter). Used to gate the daily throttle below:
  // an empty-but-real result means "searched, nothing good" and must not
  // re-burn 100 units on the next page render.
  let searchedLive = false;

  for (const query of queries.slice(0, 3)) {
    if (found.length >= limit) break;
    const data = await ytGet<SearchResponse>(
      "search",
      {
        part: "snippet",
        type: "video",
        q: query,
        maxResults: "25",
        safeSearch: "none",
        relevanceLanguage: "en",
        videoCategoryId: VIDEO_CATEGORY_MUSIC,
      },
      "search",
    );
    if (!data?.items) continue;
    searchedLive = true;

    const candidates = data.items
      .filter((item) => {
        if (!item.id?.videoId || seenIds.has(item.id.videoId)) return false;
        const title = item.snippet?.title?.trim() ?? "";
        if (!title) return false;
        if (isLyricResult(title, item.snippet?.channelTitle)) return false;
        if (isBlacklistedTitle(title)) return false; // junk: mixes, compilations, 1-hour re-ups…
        return true;
      })
      .sort((a, b) => genreCandidateScore(b) - genreCandidateScore(a))
      .slice(0, Math.max(limit * 2, 12));

    const buckets = durationBounds(subgenre);
    const metas = await videosList(candidates.map((item) => item.id!.videoId!));
    for (const meta of metas) {
      if (!meta.embeddable) continue;
      if (meta.duration <= buckets.min || meta.duration >= buckets.max) continue;
      if (seenIds.has(meta.videoId)) continue;
      seenIds.add(meta.videoId);
      const track: YouTubeVideo = {
        ...meta,
        thumbnail: thumbnailFor(meta.videoId),
        // videos.list reports the raw channel title as artist; prefer a parsed
        // "Artist" from the actual video title (handles "- Topic" channels).
        artistName: parseTitle(meta.title, meta.channelTitle).artistName || meta.artistName,
        subgenre,
        source: "search",
      };
      found.push(track);
      await persistSong(track, channelQuality(track.channelTitle));
      if (found.length >= limit) break;
    }
  }

  // Mark the daily throttle whenever a live search actually ran — even if every
  // candidate was dropped as junk/short/non-embeddable. Otherwise an empty
  // genre re-spends the search budget on every page render.
  if (searchedLive) markGenreFill(subgenre);
  return found.slice(0, limit);
}

/** Per-process throttle so a burst of identical search queries doesn't re-run
 * the same 100-unit search within a day. */
const queryFillAt: Map<string, number> = new Map();

function queryFillDue(key: string): boolean {
  const now = Date.now();
  const last = queryFillAt.get(key) ?? 0;
  return now - last >= GENRE_FILL_DEDUPE_MS;
}

function markQueryFill(key: string): void {
  pruneOlderThan(queryFillAt, GENRE_FILL_DEDUPE_MS);
  queryFillAt.set(key, Date.now());
}

/**
 * Search YouTube live for an arbitrary user-provided query (e.g. "Brodyaga
 * Funk") that Jamendo's CC catalog can't match. Budget-gated like the genre
 * fill: at most once per day per query (per process), capped by the rolling
 * quota pool, winners persisted so later lookups are free DB reads. Results are
 * ranked by the same quality heuristic as genre fill (Topic/official uploads
 * first), with lyrics and non-embeddable/short/long items dropped.
 */
export async function fetchQueryVideos(query: string, limit = 12, subgenre?: string): Promise<YouTubeVideo[]> {
  const q = query.trim();
  if (!hasProjects() || !runtimeFillEnabled() || limit <= 0 || !q) return [];
  if (!queryFillDue(q.toLowerCase())) return [];

  const data = await ytGet<SearchResponse>(
    "search",
    {
      part: "snippet",
      type: "video",
      q,
      maxResults: "25",
      safeSearch: "none",
      videoCategoryId: VIDEO_CATEGORY_MUSIC,
    },
    "search",
  );
  if (!data?.items) return [];
  // The daily throttle must engage whenever a live search actually executed —
  // even if every candidate was dropped — otherwise an empty result re-spends
  // the search budget on every identical request.
  markQueryFill(q.toLowerCase());

  const seenIds = new Set<string>();
  const candidates = data.items
    .filter((item) => {
      if (!item.id?.videoId || seenIds.has(item.id.videoId)) return false;
      const title = item.snippet?.title?.trim() ?? "";
      if (!title) return false;
      if (isLyricResult(title, item.snippet?.channelTitle)) return false;
      if (isBlacklistedTitle(title)) return false; // junk: mixes, compilations, 1-hour re-ups…
      return true;
    })
    .sort((a, b) => genreCandidateScore(b) - genreCandidateScore(a))
    .slice(0, Math.max(limit * 2, 12));

  const buckets = durationBounds(subgenre);
  const metas = await videosList(candidates.map((item) => item.id!.videoId!));

  const found: YouTubeVideo[] = [];
  for (const meta of metas) {
    if (!meta.embeddable) continue;
    if (meta.duration <= buckets.min || meta.duration >= buckets.max) continue;
    if (seenIds.has(meta.videoId)) continue;
    seenIds.add(meta.videoId);
    const track: YouTubeVideo = {
      ...meta,
      thumbnail: thumbnailFor(meta.videoId),
      artistName: parseTitle(meta.title, meta.channelTitle).artistName || meta.artistName,
      subgenre: subgenre ?? null,
      source: "search",
    };
    found.push(track);
    await persistSong(track, channelQuality(track.channelTitle));
    if (found.length >= limit) break;
   }

  return found;
}

/**
 * Backfill a genre by paging an uploads/curated playlist with `playlistItems.list`
 * (1 unit per 50 items) instead of `search.list` (100 units each). Bulk-seeds
 * the `songs` catalog for a genre without burning the search budget — the cheap
 * ops draw from the playback slice of the quota pool.
 */
export async function seedFromPlaylist(
  playlistId: string,
  subgenre: string,
  maxItems = 200,
): Promise<YouTubeVideo[]> {
  if (!hasProjects()) return [];
  const found: YouTubeVideo[] = [];
  let pageToken: string | undefined;
  let count = 0;

  interface PlaylistResponse {
    nextPageToken?: string;
    items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }>;
  }

  do {
    if (count >= maxItems) break;
    const data = await ytGet<PlaylistResponse>(
      "playlistItems",
      { part: "snippet", playlistId, maxResults: "50", ...(pageToken ? { pageToken } : {}) },
      "playback",
    );
    if (!data) break;
    pageToken = data.nextPageToken;
    const ids: string[] = [];
    for (const item of data.items ?? []) {
      const videoId = item.id?.videoId;
      if (videoId) ids.push(videoId);
    }
    count += ids.length;
    // Fetch fresh metadata in batches of 50 (1 unit each).
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const metas = await videosList(chunk);
      for (const video of metas) {
        const track: YouTubeVideo = {
          ...video,
          thumbnail: thumbnailFor(video.videoId),
          artistName: parseTitle(video.title, video.channelTitle).artistName || video.artistName,
          subgenre,
          source: "playlist",
        };
        found.push(track);
        await persistSong(track, channelQuality(track.channelTitle));
      }
    }
  } while (pageToken);

  return found;
}

/* ------------------------------------------------------------------ */
/* Catalog reads (Layer 3, Postgres — 0 quota)                        */
/* ------------------------------------------------------------------ */

/** Cached YouTube songs for a subgenre (from playlist seeding / live fill). */
export async function fetchCachedSubgenreVideos(subgenre: string, limit = 24): Promise<YouTubeVideo[]> {
  return findSongsByGenre(subgenre, limit);
}

/** Cached YouTube songs not tied to a subgenre — query-discovered during search
 * fill and generic rescues. Used to top up generic pages with free DB reads. */
export async function fetchCachedGeneralVideos(limit = 12): Promise<YouTubeVideo[]> {
  return findGeneralSongs(limit);
}

/** All cached YouTube songs, used by the admin/seeding UI and quota page. */
export async function fetchAllCachedVideos(limit = 100): Promise<YouTubeVideo[]> {
  return findAllSongs(limit);
}

/** Cached YouTube songs by their raw video ids. Primary source is the `songs`
 * store; videos that were resolved recently but pruned from or never written to
 * Postgres are recovered from the `song:{videoId}` read-through cache, so saved
 * history/favorites/playlists keep resolving. Videos missing from both the DB
 * and the read-through cache are fetched live via `videos.list` (1 unit per 50
 * ids, budget-gated) so a saved track never silently vanishes. */
export async function fetchVideosByIds(videoIds: string[]): Promise<YouTubeVideo[]> {
  const songs = await findSongsByIds(videoIds);
  for (const song of songs) cacheSetSong(song);

  const found = new Set(songs.map((s) => s.videoId));
  let missing = [...new Set(videoIds.filter((id) => !found.has(id)))];
  if (missing.length === 0) return songs;

  const cached = (
    await Promise.all(missing.map((id) => cacheGetSong(id).catch(() => null)))
  ).filter((v): v is YouTubeVideo => v != null);
  const cachedIds = new Set(cached.map((v) => v.videoId));
  missing = missing.filter((id) => !cachedIds.has(id));
  if (missing.length === 0) return [...songs, ...cached];

  // Still missing: fetch live metadata via the 1-unit-per-50-ids videos.list
  // endpoint and persist the winners so later lookups are free reads.
  const live = await videosList(missing);
  for (const video of live) {
    await persistSong(video, channelQuality(video.channelTitle));
  }
  return [...songs, ...cached, ...live];
}

/* ------------------------------------------------------------------ */
/* Quota status (pooled, cross-project)                                */
/* ------------------------------------------------------------------ */

/**
 * Aggregate daily quota status across the whole project pool. Uses the Redis
 * counters when available, and falls back to summing today's `api_call_log`
 * rows from Postgres when Redis is down — so the health surface never blanks
 * out just because the cache layer is unavailable. Also reports Redis
 * capacity (DBSIZE) and the bandwidth ledger so a runaway cache job shows up
 * before the monthly egress budget is silently spent.
 */
export async function getYouTubeQuotaStatus(): Promise<YouTubeQuotaStatus> {
  const budget = dailySearchBudget();

  const [healthy, dbSize, meter, persistedToday] = await Promise.all([
    ytRedis.healthy(),
    ytRedis.dbSize(),
    ytRedis.usage(),
    redisUsageToday().catch(() => null),
  ]);

  try {
    const pool = await getQuotaStatus();
    const searches = pool.searches;
    return {
      unitsUsed: pool.unitsUsed,
      searches,
      searchesRemaining: Math.max(0, budget - searches),
      budget,
      projects: pool.projects,
      configured: pool.configured,
      redis: {
        configured: ytRedis.configured,
        healthy,
        dbSize,
        ops: meter.ops,
        readBytes: meter.readBytes,
        writeBytes: meter.writeBytes,
        hits: meter.hits,
        misses: meter.misses,
        today: persistedToday,
      },
    };
  } catch {
    // Redis + pool unavailable — fall back to the Postgres call log.
    const unitsUsed = await unitsUsedToday();
    const searches = Math.round(unitsUsed / UNIT_COST.search);
    return {
      unitsUsed,
      searches,
      searchesRemaining: Math.max(0, budget - searches),
      budget,
      projects: [],
      configured: false,
      redis: {
        configured: ytRedis.configured,
        healthy,
        dbSize,
        ops: meter.ops,
        readBytes: meter.readBytes,
        writeBytes: meter.writeBytes,
        hits: meter.hits,
        misses: meter.misses,
        today: persistedToday,
      },
    };
  }
}
