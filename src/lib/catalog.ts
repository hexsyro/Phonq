import "server-only";

/**
 * Catalog layer — a resilient, cache-first wrapper around the live Jamendo API.
 *
 * Failure ladder (never lets the UI break or leak raw upstream errors):
 *
 *   1. Live Jamendo  → on success, metadata is cached in Postgres (`cached_tracks`)
 *      so short outages don't take the app down and live API load is cut.
 *   2. Postgres cache → if the live API fails, serve the cached "smaller catalog".
 *   3. Static snapshot → if both the API and the DB are unavailable, serve the
 *      bundled `featured-tracks.ts` so the homepage never looks empty.
 *
 * Every step is best-effort and individually guarded: if there is no database
 * (fresh clone, broken DATABASE_URL) the layer still degrades to the static
 * snapshot instead of throwing.
 *
 * All upstream errors are logged server-side only (`console.error`); the public
 * API routes translate them into generic copy, never the raw message or env
 * var names.
 */

import type { Prisma } from "@/generated/prisma/client";
import type { Album, Artist, Radio, Track, TracksParams } from "@/lib/jamendo";
import * as jamendo from "@/lib/jamendo";
import { prisma } from "@/lib/prisma";
import { classifyTrack, getSubgenre, PHONK_FAMILY_QUERY_TAGS, PHONK_SUBGENRES } from "@/lib/phonk-genres";
import { FEATURED_TRACKS } from "@/content/featured-tracks";
import type { FeaturedTrack } from "@/content/featured-types";
import * as youtube from "@/lib/youtube";
import type { YouTubeVideo } from "@/lib/youtube";

export type CatalogProvider = "live" | "degraded" | "static";

export interface CatalogStatusShape {
  provider: CatalogProvider;
  cacheCount: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  updatedAt: string | null;
}

const CACHE_WRITE_TTL_MS = 5 * 60 * 1000;
const STATUS_THROTTLE_MS = 60 * 1000;
const DEGRADED_WINDOW_MS = 10 * 60 * 1000;

/**
 * How long the Postgres catalog cache is considered "verified fresh" after the
 * last successful live fetch. While fresh we serve reads straight from the DB
 * snapshot (local, fast) instead of re-hitting the Jamendo API — this is what
 * keeps app starts and page switches fast when the in-process memory cache is
 * cold (idle server, fresh instance, restart). `catalogStatus.lastSuccess` is
 * persisted, so the gate survives restarts too.
 */
const DB_FRESH_MS = 15 * 60 * 1000;

const globalForCatalog = globalThis as unknown as {
  __phonqCacheWrites?: Map<string, number>;
  __phonqStatusAt?: number;
  __phonqDegradedUntil?: number;
};

/**
 * Returns true when the catalog was verified live recently enough that the
 * persisted Postgres snapshot can serve reads. Cheap: a single indexed row read.
 */
async function catalogFresh(): Promise<boolean> {
  try {
    const row = await prisma.catalogStatus.findUnique({
      where: { id: 1 },
      select: { lastSuccess: true },
    });
    if (!row?.lastSuccess) return false;
    return Date.now() - row.lastSuccess.getTime() < DB_FRESH_MS;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Status (single-row health flag)                                     */
/* ------------------------------------------------------------------ */

function nowIso(): string {
  return new Date().toISOString();
}

async function writeStatus(patch: {
  provider: CatalogProvider;
  error?: string | null;
  radios?: unknown;
}): Promise<void> {
  const radios = patch.radios as Prisma.InputJsonValue | undefined;
  try {
    await prisma.catalogStatus.upsert({
      where: { id: 1 },
      update: {
        provider: patch.provider,
        error: patch.error ?? undefined,
        radios,
        lastSuccess: patch.provider === "live" ? new Date() : undefined,
        lastFailure: patch.error ? new Date() : undefined,
      },
      create: {
        id: 1,
        provider: patch.provider,
        error: patch.error ?? null,
        radios,
        lastSuccess: patch.provider === "live" ? new Date() : undefined,
        lastFailure: patch.error ? new Date() : undefined,
      },
    });
  } catch {
    /* no database — status is best-effort only */
  }
}

async function writeSuccessStatus(radios?: unknown): Promise<void> {
  globalForCatalog.__phonqDegradedUntil = 0;
  const now = Date.now();
  if (globalForCatalog.__phonqStatusAt && now - globalForCatalog.__phonqStatusAt < STATUS_THROTTLE_MS) {
    return;
  }
  globalForCatalog.__phonqStatusAt = now;
  await writeStatus({ provider: "live", error: null, radios });
}

async function writeFailureStatus(error: unknown, provider: CatalogProvider = "degraded"): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  globalForCatalog.__phonqDegradedUntil = Date.now() + DEGRADED_WINDOW_MS;
  // Throttle so an expected, persistent outage (e.g. no JAMENDO_CLIENT_ID) only
  // logs once per window instead of on every single catalog request.
  const now = Date.now();
  if (!globalForCatalog.__phonqStatusAt || now - globalForCatalog.__phonqStatusAt >= STATUS_THROTTLE_MS) {
    globalForCatalog.__phonqStatusAt = now;
    console.error(`[catalog] upstream unavailable (${provider}) — falling back to cached static snapshot`);
  }
  await writeStatus({ provider, error: message });
}

export async function getCatalogStatus(): Promise<CatalogStatusShape> {
  let cacheCount = 0;
  let row:
    | {
        provider: string;
        lastSuccess: Date | null;
        lastFailure: Date | null;
        updatedAt: Date;
      }
    | null = null;
  try {
    const [cached, status] = await Promise.all([
      prisma.cachedTrack.count(),
      prisma.catalogStatus.findUnique({ where: { id: 1 } }),
    ]);
    cacheCount = cached;
    row = status;
  } catch {
    /* no database */
  }

  const memoryDegraded = Date.now() < (globalForCatalog.__phonqDegradedUntil ?? 0);
  // The status row is only written throttled, so a stale "degraded" provider in
  // Postgres shouldn't mask a live recovery. Trust the DB flag only when the
  // recorded failure is recent and newer than the last success.
  const lastFailure = row?.lastFailure ? row.lastFailure.getTime() : 0;
  const lastSuccess = row?.lastSuccess ? row.lastSuccess.getTime() : 0;
  const dbRowDegraded = lastFailure > lastSuccess && Date.now() - lastFailure < DEGRADED_WINDOW_MS;
  const provider: CatalogProvider =
    memoryDegraded || dbRowDegraded ? (cacheCount > 0 ? "degraded" : "static") : "live";

  return {
    provider,
    cacheCount,
    lastSuccess: row?.lastSuccess?.toISOString() ?? null,
    lastFailure: row?.lastFailure?.toISOString() ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Cache writes (best-effort, throttled)                               */
/* ------------------------------------------------------------------ */

/** Returns the subset of ids that haven't been written to Postgres recently. */
function freshCacheIds(ids: string[]): string[] {
  const map = globalForCatalog.__phonqCacheWrites ?? (globalForCatalog.__phonqCacheWrites = new Map());
  const now = Date.now();
  if (map.size >= 10_000) {
    // Bound the per-id write-throttle map in long-running processes.
    for (const [key, at] of map) {
      if (now - at > CACHE_WRITE_TTL_MS) map.delete(key);
    }
  }
  return ids.filter((id) => {
    const at = map.get(id);
    if (at === undefined || now - at > CACHE_WRITE_TTL_MS) {
      map.set(id, now);
      return true;
    }
    return false;
  });
}

/**
 * Jamendo name-searches often return a track with a thinner tag set than the
 * tag-query browse that originally classified it. If we classified from the live
 * tags alone, a previously-played (cached + classified) track can vanish from
 * search results. To keep search stable we union each live result with whatever
 * tags are already cached for its id, then re-derive the subgenre from the
 * merged set. Safe no-op when the DB is down (returns the tracks unchanged).
 */
async function enrichWithCachedTags(tracks: Track[]): Promise<Track[]> {
  if (tracks.length === 0) return tracks;
  const idSet = new Set<string>();
  for (const t of tracks) idSet.add(t.id);
  const ids = [...idSet];
  let cachedTags: { id: string; tags: string | null }[] = [];
  try {
    cachedTags = await prisma.cachedTrack.findMany({
      where: { id: { in: ids } },
      select: { id: true, tags: true },
    });
  } catch {
    return tracks;
  }
  const byId = new Map<string, string>();
  for (const row of cachedTags) {
    if (row.tags) byId.set(row.id, row.tags);
  }

  return tracks.map((track) => {
    const cached = byId.get(track.id);
    if (!cached) return track;
    const merged = unionTags(track.tags, cached.split(/\s+/).filter(Boolean));
    return { ...track, tags: merged, subgenre: classifyTrack({ ...track, tags: merged })?.slug ?? track.subgenre ?? null };
  });
}

/** Stable, deduplicated union of two tag arrays. */
function unionTags(a: string[], b: string[]): string[] {
  const set = new Set(a.map((t) => t.toLowerCase()));
  for (const t of b) set.add(t.toLowerCase());
  return [...set];
}

async function cacheTracks(tracks: Track[]): Promise<void> {
  if (tracks.length === 0) return;
  const ids = freshCacheIds(tracks.map((t) => t.id));
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const rows = tracks.filter((t) => idSet.has(t.id)).map((t) => ({
    id: t.id,
    name: t.name,
    duration: t.duration,
    artistId: t.artistId || null,
    artistName: t.artistName,
    albumId: t.albumId || null,
    albumName: t.albumName,
    audioUrl: t.audioUrl,
    downloadUrl: t.downloadUrl || null,
    image: t.image,
    imageSmall: t.imageSmall,
    licenseName: t.licenseName,
    genre: t.genre,
    bpm: t.bpm,
    speed: t.speed,
    vocalInstrumental: t.vocalInstrumental,
    tags: t.tags.join(" ") || null,
    popularityWeek: t.popularityWeek,
    popularityTotal: t.popularityTotal,
    listensTotal: t.listensTotal,
    downloadsTotal: t.downloadsTotal,
    releaseDate: t.releaseDate,
    audioDownloadAllowed: t.audioDownloadAllowed,
    source: "jamendo",
  }));

  try {
    // Upsert per row so the cache refreshes popularity/licensing over time.
    // Throttled per-id (5 min) by `freshCacheIds`, so this stays cheap.
    await prisma.$transaction(
      rows.map((row) =>
        prisma.cachedTrack.upsert({
          where: { id: row.id },
          update: row,
          create: row,
        }),
      ),
    );
  } catch {
    /* no database — caching is best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* DB + static fallback reads                                          */
/* ------------------------------------------------------------------ */

function dbRowToTrack(row: {
  id: string;
  name: string;
  duration: number;
  artistId: string | null;
  artistName: string;
  albumId: string | null;
  albumName: string;
  audioUrl: string;
  downloadUrl: string | null;
  image: string | null;
  imageSmall: string | null;
  licenseName: string | null;
  genre: string | null;
  bpm: number | null;
  speed: string | null;
  vocalInstrumental: string | null;
  tags: string | null;
  popularityWeek: number;
  popularityTotal: number;
  listensTotal: number;
  downloadsTotal: number;
  releaseDate: string | null;
  audioDownloadAllowed: boolean;
}): Track {
  return {
    id: row.id,
    name: row.name,
    duration: row.duration,
    artistId: row.artistId ?? "",
    artistName: row.artistName,
    albumId: row.albumId ?? "",
    albumName: row.albumName,
    audioUrl: row.audioUrl,
    downloadUrl: row.downloadUrl ?? "",
    image: row.image,
    imageSmall: row.imageSmall,
    licenseName: row.licenseName,
    genre: row.genre,
    bpm: row.bpm,
    speed: row.speed,
    vocalInstrumental: row.vocalInstrumental,
    tags: (row.tags ?? "").split(/\s+/).filter(Boolean),
    popularityWeek: row.popularityWeek,
    popularityTotal: row.popularityTotal,
    listensTotal: row.listensTotal,
    downloadsTotal: row.downloadsTotal,
    releaseDate: row.releaseDate,
    audioDownloadAllowed: row.audioDownloadAllowed,
    subgenre:
      classifyTrack({
        name: row.name,
        artistName: row.artistName,
        genre: row.genre,
        bpm: row.bpm,
        tags: (row.tags ?? "").split(/\s+/).filter(Boolean),
      })?.slug ?? null,
  };
}

function featuredToTrack(t: FeaturedTrack): Track {
  return {
    id: t.id,
    name: t.name,
    duration: t.duration,
    artistId: t.artistId,
    artistName: t.artistName,
    albumId: t.albumId,
    albumName: t.albumName,
    audioUrl: t.audioUrl,
    downloadUrl: t.downloadUrl,
    image: t.image,
    imageSmall: t.imageSmall,
    licenseName: t.licenseName,
    genre: t.genre,
    bpm: t.bpm,
    speed: t.speed,
    vocalInstrumental: t.vocalInstrumental,
    tags: t.tags,
    popularityWeek: t.popularityWeek,
    popularityTotal: t.popularityTotal,
    listensTotal: t.listensTotal,
    downloadsTotal: t.downloadsTotal,
    releaseDate: t.releaseDate,
    audioDownloadAllowed: t.audioDownloadAllowed,
    subgenre:
      classifyTrack({
        name: t.name,
        artistName: t.artistName,
        genre: t.genre,
        bpm: t.bpm,
        tags: t.tags,
        vocalInstrumental: t.vocalInstrumental,
      })?.slug ?? null,
  };
}

const staticTracks = FEATURED_TRACKS.map(featuredToTrack);
/** Fallback radios are the curated phonk subgenres themselves. */
const staticRadios: Radio[] = PHONK_SUBGENRES.map((subgenre) => ({
  id: `phonk-radio-${subgenre.slug}`,
  name: subgenre.slug,
  displayName: subgenre.name,
  image: "",
  subgenre: subgenre.slug,
}));

/* ------------------------------------------------------------------ */
/* YouTube adapter (hybrid catalog fill)                               */
/* ------------------------------------------------------------------ */

/** Convert a cached YouTube video into a `Track` for playback via the IFrame
 * Player API. Kept on the Jamendo `Track` shape so the whole app (queue,
 * favorites, playlists, player bar) treats both sources identically. */
function youtubeToTrack(video: YouTubeVideo): Track {
  return {
    id: `yt:${video.videoId}`,
    name: video.title,
    duration: video.duration,
    artistId: video.channelId ?? `yt:${video.videoId}`,
    artistName: video.artistName || video.channelTitle || "Unknown Artist",
    albumId: "",
    albumName: "",
    audioUrl: "",
    downloadUrl: "",
    image: video.thumbnail,
    imageSmall: video.thumbnail,
    licenseName: "YouTube",
    genre: null,
    bpm: null,
    speed: null,
    vocalInstrumental: null,
    tags: video.subgenre ? [video.subgenre] : [],
    popularityWeek: 0,
    popularityTotal: 0,
    listensTotal: 0,
    downloadsTotal: 0,
    releaseDate: null,
    audioDownloadAllowed: false,
    subgenre: video.subgenre,
    source: "youtube",
    videoId: video.videoId,
    videoThumbnail: video.thumbnail,
  };
}

/** Resolve a Jamendo track to its YouTube equivalent (DB-first, cheap). */
export async function resolveYouTubeForTrack(
  track: Pick<Track, "name" | "artistName" | "source" | "subgenre">,
  subgenre?: string,
): Promise<Track | null> {
  if (track.source === "youtube") return track as Track;
  const video = await youtube.resolveSongVideo(track.name, track.artistName, subgenre ?? track.subgenre ?? undefined);
  if (!video) return null;
  return youtubeToTrack(video);
}

/** Cached YouTube videos for a subgenre, converted to `Track`s (genre-gap fill). */
export async function fetchYouTubeFill(subgenre: string, limit = 12): Promise<Track[]> {
  if (!getSubgenre(subgenre)) return [];
  const videos = await youtube.fetchCachedSubgenreVideos(subgenre, limit);
  return videos.map(youtubeToTrack).slice(0, limit);
}

/** Cached, subgenre-agnostic YouTube tracks (query-discovered during search fill
 * and generic rescues), for topping up generic pages with free DB reads. */
export async function fetchGeneralYouTubeFill(limit = 12): Promise<Track[]> {
  if (limit <= 0) return [];
  const videos = await youtube.fetchCachedGeneralVideos(limit);
  return videos.map(youtubeToTrack).slice(0, limit);
}

/** Runtime genre-gap fill: search YouTube live (budget-gated, at most once per
 * day per genre) when the cached seed is still short — so thin genres never
 * render empty, without needing a manual `sync:youtube` run first. */
export async function fetchYouTubeLiveFill(subgenre: string, limit = 12): Promise<Track[]> {
  if (limit <= 0) return [];
  const sp = getSubgenre(subgenre);
  if (!sp) return [];
  const queries = [`${sp.name} phonk`, sp.name, ...sp.keywords.slice(0, 2)]
    .filter((q, i, arr) => q.trim() && arr.indexOf(q) === i)
    .slice(0, 3);
  const videos = await youtube.fetchGenreVideos(subgenre, queries, limit);
  return videos.map(youtubeToTrack);
}

/** Runtime search fill: when Jamendo can't match a user's query (e.g. "Brodyaga
 * Funk" — popular Russian phonk with no CC release), surface YouTube search
 * results for the exact query (budget-gated, at most once per day per query) so
 * search never renders empty. */
export async function fetchYouTubeQueryFill(query: string, limit = 12, subgenre?: string): Promise<Track[]> {
  if (limit <= 0) return [];
  const videos = await youtube.fetchQueryVideos(query, limit, subgenre);
  return videos.map(youtubeToTrack);
}

/** Daily YouTube search budget status, for the health/admin surface. */
export async function getYouTubeQuota(): Promise<youtube.YouTubeQuotaStatus> {
  return youtube.getYouTubeQuotaStatus();
}

interface QueryOptions {
  ids?: string[];
  search?: string;
  tags?: string[];
  order?: string;
  limit?: number;
  offset?: number;
  subgenre?: string;
  phonkOnly?: boolean;
}

/**
 * Keep only tracks that belong to the curated phonk catalog — every surfaced
 * track must classify into a phonk subgenre (and optionally a specific one).
 * Tracks loaded by id (favorites, playlists, history) skip this so user
 * libraries never break.
 */
function curatedTracks<T extends Track>(tracks: T[], opts: { subgenre?: string }): T[] {
  return tracks.filter((track) => {
    const slug = track.subgenre ?? classifyTrack(track)?.slug ?? null;
    if (slug == null) return false;
    if (opts.subgenre && slug !== opts.subgenre) return false;
    return true;
  });
}

/** Pull up to two upstream pages so classification has a bigger pool to draw
 * from — a single 100-track page frequently curates down below the window a
 * caller asks for, which is what made feeds feel sparse. */
async function fetchCuratedCandidates(
  params: {
    search?: string;
    tags: string[];
    boost?: string;
    order?: string;
    subgenre?: string;
  },
  desired: number,
): Promise<Track[]> {
  const candidates: Track[] = [];
  let offset = 0;
  while (candidates.length < desired) {
    const batch = await jamendo.fetchTracks({
      search: params.search,
      tags: params.tags,
      boost: params.boost,
      order: params.order,
      limit: 100,
      offset,
    });
    if (batch.length === 0) break;
    await cacheTracks(batch);
    candidates.push(...curatedTracks(batch, { subgenre: params.subgenre }));
    if (batch.length < 100) break;
    offset += 100;
  }
  return candidates;
}

async function queryDbTracks(opts: QueryOptions): Promise<Track[] | null> {
  try {
    const where: Record<string, unknown> = {};
    if (opts.ids && opts.ids.length > 0) {
      where.id = { in: opts.ids };
    } else if (opts.search) {
      const q = opts.search.trim();
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { artistName: { contains: q, mode: "insensitive" } },
        { tags: { contains: q, mode: "insensitive" } },
      ];
    } else if (opts.tags && opts.tags.length > 0) {
      where.OR = opts.tags.map((tag) => ({ tags: { contains: tag, mode: "insensitive" } }));
    }

    // Phonk-only curation: narrow to tracks tagged with phonk-family (or a
    // specific subgenre's) keywords, then filter the rows by classification.
    const and: Prisma.CachedTrackWhereInput[] = [];
    if (opts.phonkOnly || opts.subgenre) {
      const keywords = opts.subgenre
        ? (getSubgenre(opts.subgenre)?.keywords ?? []).slice(0, 10)
        : PHONK_FAMILY_QUERY_TAGS.slice(0, 12);
      and.push({
        OR: keywords.map((keyword) => ({
          tags: { contains: keyword, mode: "insensitive" as const },
        })),
      });
    }
    if (and.length > 0) {
      const existing = Array.isArray(where.AND) ? (where.AND as Prisma.CachedTrackWhereInput[]) : [];
      where.AND = [...existing, ...and];
    }

    const orderBy =
      opts.order === "dateadded_desc"
        ? { cachedAt: "desc" as const }
        : { popularityWeek: "desc" as const };

    const rows = await prisma.cachedTrack.findMany({
      where,
      orderBy,
      take: opts.limit ?? 24,
      skip: opts.offset ?? 0,
    });
    const tracks = rows.map(dbRowToTrack);
    return opts.subgenre || opts.phonkOnly ? curatedTracks(tracks, { subgenre: opts.subgenre }) : tracks;
  } catch {
    return null;
  }
}

function queryStaticTracks(opts: QueryOptions): Track[] {
  let list = staticTracks;
  if (opts.ids && opts.ids.length > 0) {
    const set = new Set(opts.ids);
    list = list.filter((t) => set.has(t.id));
  } else if (opts.search) {
    const q = opts.search.trim().toLowerCase();
    list = list.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.artistName.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  } else if (opts.tags && opts.tags.length > 0) {
    list = list.filter((t) => opts.tags!.some((tag) => t.tags.some((x) => x.toLowerCase().includes(tag.toLowerCase()))));
  }
  if (opts.subgenre) {
    list = list.filter((t) => t.subgenre === opts.subgenre);
  } else if (opts.phonkOnly && !(opts.ids && opts.ids.length > 0)) {
    list = list.filter((t) => t.subgenre != null);
  }
  if (opts.order !== "dateadded_desc") {
    list = [...list].sort((a, b) => b.popularityWeek - a.popularityWeek);
  }
  const start = opts.offset ?? 0;
  const end = start + (opts.limit ?? list.length);
  return list.slice(start, end);
}

/* ------------------------------------------------------------------ */
/* Public catalog functions (same signatures as the jamendo client)    */
/* ------------------------------------------------------------------ */

export async function fetchTracks(params: TracksParams = {}): Promise<Track[]> {
  const byId = Boolean(params.ids && params.ids.length > 0);
  const opts: QueryOptions = {
    ids: params.ids,
    search: params.search,
    tags: params.tags,
    order: params.order,
    limit: params.limit ?? 24,
    offset: params.offset,
    subgenre: params.subgenre,
    phonkOnly: !byId,
  };
  try {
    if (byId) {
      const tracks = await jamendo.fetchTracks({ ids: opts.ids, limit: opts.limit });
      await cacheTracks(tracks);
      await writeSuccessStatus();
      return tracks;
    }

    const pageSize = opts.limit ?? 24;

    // Cache-first: when the catalog was verified live recently enough, serve
    // the persisted Postgres snapshot instead of re-hitting the Jamendo API.
    // This is what makes app starts and page switches fast when the in-memory
    // cache is cold (idle instance, restart) — the DB snapshot is refreshed on
    // each live verification and serves reads for the whole freshness window.
    if (await catalogFresh()) {
      const cached = await queryDbTracks(opts);
      if (cached && cached.length > 0) {
        return fillYouTubeGaps(cached, { limit: pageSize, subgenre: opts.subgenre, query: opts.search });
      }
    }

    // Over-fetch so curation (classification) can fill the requested page; the
    // offset window is applied locally after curation so pages stay aligned
    // with the same ranked, curated list.
    const start = opts.offset ?? 0;
    const tags = opts.subgenre
      ? (getSubgenre(opts.subgenre)?.jamendoTags ?? PHONK_FAMILY_QUERY_TAGS)
      : (params.tags && params.tags.length > 0 ? params.tags : PHONK_FAMILY_QUERY_TAGS);
    const tracks = await fetchCuratedCandidates(
      { search: opts.search, tags, boost: params.boost, order: params.order, subgenre: opts.subgenre },
      start + pageSize,
    );
    await writeSuccessStatus();

    const page = tracks.slice(start, start + pageSize);
    // Auto-insert YouTube songs to fill the window when curated Jamendo content
    // runs short; specific-id fetches (queue/favorites restoration) stay exact.
    return fillYouTubeGaps(page, { limit: pageSize, subgenre: opts.subgenre, query: opts.search });
  } catch (err) {
    await writeFailureStatus(err);
    const cached = await queryDbTracks(opts);
    if (cached && cached.length > 0) return fillYouTubeGaps(cached, { limit: opts.limit ?? 24, subgenre: opts.subgenre, query: opts.search });
    const staticTracks = await queryStaticTracks(opts);
    return fillYouTubeGaps(staticTracks, { limit: opts.limit ?? 24, subgenre: opts.subgenre, query: opts.search });
  }
}

export async function fetchTrack(id: string): Promise<Track | null> {
  if (id.startsWith("yt:")) {
    const [video] = await youtube.fetchVideosByIds([id.slice(3)]);
    return video ? youtubeToTrack(video) : null;
  }
  const [track] = await fetchTracks({ ids: [id], limit: 1 });
  return track ?? null;
}

export async function fetchTracksByIds(ids: string[]): Promise<Track[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];

  // YouTube tracks are stored under `yt:<videoId>` and live in `youtube_videos`
  // (not `cached_tracks`), so resolve them through the YouTube table directly.
  const youtubeIds = unique.filter((id) => id.startsWith("yt:"));
  const jamendoIds = unique.filter((id) => !id.startsWith("yt:"));

  const tracks: Track[] = [];
  for (let i = 0; i < jamendoIds.length; i += 100) {
    const chunk = jamendoIds.slice(i, i + 100);
    tracks.push(...(await fetchTracks({ ids: chunk, limit: chunk.length })));
  }
  if (youtubeIds.length > 0) {
    const videos = await youtube.fetchVideosByIds(youtubeIds.map((id) => id.slice(3)));
    tracks.push(...videos.map(youtubeToTrack));
  }
  return tracks;
}

/** Phonk-distinctive words used to recognize phonk radios (unlike
 * `PHONK_FAMILY_QUERY_TAGS`, this deliberately excludes broad words such as
 * "metal", "funk", "wave" or "bass" that also name unrelated radios). */
const PHONK_RADIO_WORDS = new Set([
  "phonk",
  "drift",
  "memphis",
  "cowbell",
  "drill",
  "trap",
  "brazilian",
  "baile",
  "mandelao",
  "g-funk",
  "phonkwave",
  "hyperphonk",
  "hyperpop",
  "plugg",
  "jungle",
  "dnb",
  "breakbeat",
]);

function isPhonkRadio(radio: Radio): boolean {
  return [radio.displayName, radio.name, "type" in radio ? String((radio as Radio & { type?: string }).type) : ""]
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .some((word) => PHONK_RADIO_WORDS.has(word) || word.startsWith("phonk"));
}

async function readCachedRadios(): Promise<Radio[]> {
  try {
    const row = await prisma.catalogStatus.findUnique({ where: { id: 1 } });
    const cached = row?.radios as unknown as Radio[] | undefined;
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached.filter(isPhonkRadio);
    }
  } catch {
    /* no database */
  }
  return [];
}

export async function fetchRadios(): Promise<Radio[]> {
  if (await catalogFresh()) {
    const cached = await readCachedRadios();
    if (cached.length > 0) return cached;
  }
  try {
    const radios = await jamendo.fetchRadios();
    await writeSuccessStatus(radios);
    // Keep the platform phonk-only: only surface radios that belong to the
    // curated phonk family. Fall back to the subgenre radios when none do.
    const phonkRadios = radios.filter(isPhonkRadio);
    return phonkRadios.length > 0 ? phonkRadios : staticRadios;
  } catch (err) {
    await writeFailureStatus(err);
    const cached = await readCachedRadios();
    return cached.length > 0 ? cached : staticRadios;
  }
}

export async function fetchTrendingPhonk(limit = 24): Promise<Track[]> {
  if (await catalogFresh()) {
    const cached = await queryDbTracks({ limit, phonkOnly: true });
    if (cached && cached.length > 0) return fillYouTubeGaps(cached, { limit });
  }
  try {
    const tracks = await jamendo.fetchTrendingPhonk(Math.min(limit * 4, 100));
    await cacheTracks(tracks);
    await writeSuccessStatus();
    return fillYouTubeGaps(curatedTracks(tracks, {}).slice(0, limit), { limit });
  } catch (err) {
    await writeFailureStatus(err);
    const cached = await queryDbTracks({ limit, phonkOnly: true });
    if (cached && cached.length > 0) return fillYouTubeGaps(cached, { limit });
    return fillYouTubeGaps(await queryStaticTracks({ limit, phonkOnly: true }), { limit });
  }
}

export async function fetchFreshDrops(limit = 24): Promise<Track[]> {
  if (await catalogFresh()) {
    const cached = await queryDbTracks({ limit, order: "dateadded_desc", phonkOnly: true });
    if (cached && cached.length > 0) return fillYouTubeGaps(cached, { limit });
  }
  try {
    const tracks = await jamendo.fetchFreshDrops(Math.min(limit * 4, 100));
    await cacheTracks(tracks);
    await writeSuccessStatus();
    return fillYouTubeGaps(curatedTracks(tracks, {}).slice(0, limit), { limit });
  } catch (err) {
    await writeFailureStatus(err);
    const cached = await queryDbTracks({ limit, order: "dateadded_desc", phonkOnly: true });
    if (cached && cached.length > 0) return fillYouTubeGaps(cached, { limit });
    return fillYouTubeGaps(await queryStaticTracks({ limit, order: "dateadded_desc", phonkOnly: true }), { limit });
  }
}

export async function searchTracks(query: string, limit = 30, subgenre?: string): Promise<Track[]> {
  if (!query.trim()) return [];
  const topUpFromYouTube = async (results: Track[]): Promise<Track[]> => {
    // Search fill: when Jamendo's CC catalog comes back short or empty for a
    // phonk query (YouTube/SoundCloud-native artists) — or when the upstream is
    // degraded entirely — top up with budget-gated live YouTube search results
    // for the exact query so search never renders empty. Winners are persisted
    // on the run, so later identical queries are free DB reads.
    if (results.length >= limit) return results.slice(0, limit);
    const filled = await fetchYouTubeQueryFill(query.trim(), limit - results.length, subgenre);
    return dedupeTracks([...results, ...filled]).slice(0, limit);
  };
  try {
    const tags = subgenre ? (getSubgenre(subgenre)?.jamendoTags ?? PHONK_FAMILY_QUERY_TAGS) : PHONK_FAMILY_QUERY_TAGS;
    const first = await jamendo.searchTracks(query, Math.min(limit * 4, 100), subgenre);
    const enriched = await enrichWithCachedTags(first);
    await cacheTracks(enriched);
    const candidates = [...curatedTracks(enriched, { subgenre })];
    if (candidates.length < limit && enriched.length >= 100) {
      const second = await jamendo.fetchTracks({ search: query.trim(), tags, limit: 100, offset: 100 });
      const enriched2 = await enrichWithCachedTags(second);
      await cacheTracks(enriched2);
      candidates.push(...curatedTracks(enriched2, { subgenre }));
    }
    await writeSuccessStatus();
    return topUpFromYouTube(candidates);
  } catch (err) {
    await writeFailureStatus(err);
    const cached = await queryDbTracks({ search: query.trim(), limit, subgenre, phonkOnly: true });
    if (cached && cached.length > 0) return topUpFromYouTube(cached);
    const staticTracks = await queryStaticTracks({ search: query.trim(), limit, subgenre, phonkOnly: true });
    return topUpFromYouTube(staticTracks);
  }
}

/** Tracks for a single phonk subgenre page. Returns [] for an unknown slug. */
export async function fetchSubgenreTracks(slug: string, limit = 24): Promise<Track[]> {
  if (!getSubgenre(slug)) return [];
  const jamendoTracks = await fetchTracks({ subgenre: slug, limit, boost: "popularity_week" });
  // Genre-gap fill: when Jamendo's CC catalog is thin for this subgenre (e.g.
  // Brazilian funk), top up the page from the cached YouTube seed (free reads —
  // the bulk of the genre was backfilled once with playlistItems.list). When
  // even the seed is empty, fall back to a budget-gated live YouTube search so
  // thin genres never render empty. Keeps Jamendo primary (legal, direct
  // audio) while YouTube covers the gaps.
  if (jamendoTracks.length >= limit) return jamendoTracks;
  let tracks = dedupeTracks([...jamendoTracks, ...(await fetchYouTubeFill(slug, limit - jamendoTracks.length))]);
  if (tracks.length < limit) {
    tracks = dedupeTracks([...tracks, ...(await fetchYouTubeLiveFill(slug, limit - tracks.length))]);
  }
  return tracks.slice(0, limit);
}

/** Deduplicate tracks by id so cached seed and live-search fill never double-list. */
function dedupeTracks<T extends Track>(tracks: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const track of tracks) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}

/**
 * Auto-insert YouTube songs into any catalog surface that comes back short or
 * empty - the "everywhere" twin of the genre and search gap fills. Live
 * content stays primary; cached YouTube seeds (free DB reads) top up short
 * pages; budget-gated live searches only run when there is a concrete intent
 * (a subgenre or a query) and the page is still short, or (once per day, for
 * the generic "phonk" pool) when a generic page is completely empty.
 */
async function fillYouTubeGaps(
  tracks: Track[],
  opts: { limit: number; subgenre?: string; query?: string },
): Promise<Track[]> {
  if (opts.limit <= 0) return [];
  if (tracks.length >= opts.limit) return tracks.slice(0, opts.limit);

  let merged = tracks;
  const short = () => opts.limit - merged.length;

  const seed = opts.subgenre ? await fetchYouTubeFill(opts.subgenre, short()) : await fetchGeneralYouTubeFill(short());
  merged = dedupeTracks([...merged, ...seed]);

  if (merged.length < opts.limit) {
    if (opts.query) {
      merged = dedupeTracks([...merged, ...(await fetchYouTubeQueryFill(opts.query.trim(), short(), opts.subgenre))]);
    } else if (opts.subgenre) {
      merged = dedupeTracks([...merged, ...(await fetchYouTubeLiveFill(opts.subgenre, short()))]);
    } else if (merged.length === 0) {
       // Generic page with nothing at all: rescue it with a single budget-gated
       // "phonk" search (throttled to once per day by the query fill) whose
       // winners become the cached general pool for later free reads.
       merged = dedupeTracks([...merged, ...(await fetchYouTubeQueryFill("phonk", short()))]);
     }
   }

   return merged.slice(0, opts.limit);
 }

/* ------------------------------------------------------------------ */
/* Artist + album views (v1.1)                                        */
/* ------------------------------------------------------------------ */

export interface AlbumGroup {
  album: Album;
  tracks: Track[];
}

/** Jamendo artist ids are numeric; YouTube-sourced tracks carry `yt:` artist ids
 * which have no Jamendo artist page, so we only link Jamendo artists. */
export function isJamendoArtistId(artistId: string): boolean {
  return /^\d+$/.test((artistId ?? "").trim());
}

/** Build an `Artist` for an artist page when the live API is down, by aggregating
 * the cached/static tracks that belong to the artist. Best-effort only. */
async function aggregateArtistFromTracks(id: string, name: string): Promise<Artist | null> {
  let rows: Awaited<ReturnType<typeof prisma.cachedTrack.findMany>> | null = null;
  try {
    rows = await prisma.cachedTrack.findMany({
      where: { artistId: id },
      orderBy: { popularityWeek: "desc" },
    });
    if (rows.length === 0) {
      rows = await prisma.cachedTrack.findMany({
        where: { artistName: { equals: name, mode: "insensitive" } },
        orderBy: { popularityWeek: "desc" },
      });
    }
  } catch {
    rows = null;
  }

  if (!rows || rows.length === 0) return null;
  const image = rows.find((r) => r.image ?? r.imageSmall) ?? null;
  const pic = image ? (image.image ?? image.imageSmall) : null;
  const albumIds = new Set(rows.filter((r) => r.albumId).map((r) => r.albumId));
  return {
    id,
    name: rows[0].artistName || name || "Unknown Artist",
    image: pic,
    imageSmall: pic,
    website: null,
    location: null,
    joindate: null,
    nbTracks: rows.length,
    nbAlbums: albumIds.size,
    nbFans: null,
    bio: null,
  };
}

/** Build an `Artist` from the static snapshot by matching the (possibly
 * synthetic) artist id or artist name. Used when the live API and the DB cache
 * are both unavailable — the last rung of the artist-page ladder. */
async function aggregateArtistFromStatic(id: string, name: string): Promise<Artist | null> {
  const rows = staticTracks.filter((t) => t.artistId === id || (name && t.artistName === name));
  if (rows.length === 0) return null;
  const image = rows.find((t) => t.image ?? t.imageSmall) ?? null;
  const pic = image ? (image.image ?? image.imageSmall) : null;
  const albumIds = new Set(rows.filter((t) => t.albumId).map((t) => t.albumId));
  return {
    id,
    name: rows[0].artistName || name || "Unknown Artist",
    image: pic,
    imageSmall: pic,
    website: null,
    location: null,
    joindate: null,
    nbTracks: rows.length,
    nbAlbums: albumIds.size,
    nbFans: null,
    bio: null,
  };
}

/** Fetch a single artist, with the live → DB → static failure ladder. */
export async function fetchArtist(id: string): Promise<Artist | null> {
  if (!id || id.startsWith("yt:")) return null;

  try {
    const artist = await jamendo.fetchArtist(id);
    await writeSuccessStatus();
    return artist; // may be null (genuinely not found upstream)
  } catch (err) {
    await writeFailureStatus(err);
    const fromDb = await aggregateArtistFromTracks(id, "");
    if (fromDb) return fromDb;
    return aggregateArtistFromStatic(id, "");
  }
}

const ARTIST_TRACKS_LIMIT = 100;
const JAMENDO_PAGE_SIZE = 50;

/** Paginate through Jamendo's tracks-by-artist until the cap is reached. */
async function fetchAllArtistTracks(artistId: string, limit = ARTIST_TRACKS_LIMIT): Promise<Track[]> {
  const cap = Math.max(1, Math.min(limit, ARTIST_TRACKS_LIMIT));
  const out: Track[] = [];
  let offset = 0;
  while (out.length < cap) {
    const batch = await jamendo.fetchTracksByArtist(artistId, Math.min(JAMENDO_PAGE_SIZE, cap - out.length), offset);
    if (batch.length === 0) break;
    out.push(...batch);
    if (batch.length < JAMENDO_PAGE_SIZE) break;
    offset += JAMENDO_PAGE_SIZE;
  }
  return out.slice(0, cap);
}

/** An artist's full discography, with the live → DB → static failure ladder. */
export async function fetchArtistTracks(artistId: string, artistName = "", limit = ARTIST_TRACKS_LIMIT): Promise<Track[]> {
  // Live Jamendo by numeric artist id (no curation — show the full catalog entry).
  if (isJamendoArtistId(artistId)) {
    try {
      const tracks = await fetchAllArtistTracks(artistId, limit);
      if (tracks.length > 0) {
        await cacheTracks(tracks);
        await writeSuccessStatus();
        return tracks;
      }
    } catch (err) {
      await writeFailureStatus(err);
    }
  }

  // DB cache: match by stored artistId (numeric) or by artist name.
  try {
    const where: Prisma.CachedTrackWhereInput = artistName
      ? { OR: [{ artistId: artistId }, { artistName: { equals: artistName, mode: "insensitive" } }] }
      : { artistId: artistId };
    const rows = await prisma.cachedTrack.findMany({
      where,
      orderBy: { popularityWeek: "desc", releaseDate: "desc" },
      take: limit,
    });
    if (rows.length > 0) return dedupeTracks(rows.map(dbRowToTrack));
  } catch {
    /* no database */
  }

  // Static snapshot (only reachable when the artistName is known, since the
  // bundled set is classified by metadata rather than Jamendo artist id).
  if (artistName) {
    return staticTracks.filter((t) => t.artistName === artistName).slice(0, limit);
  }
  return [];
}

/** Derive "similar artists" from the subgenres an artist's tracks sit in. */
export async function fetchSimilarArtists(
  artistId: string,
  artistName: string,
  tracks: Track[],
  limit = 8,
): Promise<Artist[]> {
  if (limit <= 0) return [];
  const subgenres = (Array.from(new Set(tracks.map((t) => t.subgenre).filter(Boolean))) as string[]).filter(Boolean);
  if (subgenres.length === 0) return [];

  const seen = new Set<string>();
  const scored = new Map<string, { id: string; name: string; image: string | null; weight: number }>();

  for (const slug of subgenres) {
    const subs = await fetchSubgenreTracks(slug, 48).catch(() => []);
    for (const t of subs) {
      const isTarget = (artistName ? t.artistName === artistName : false) || t.artistId === artistId;
      if (isTarget) continue;
      if (!t.artistId || t.artistId.startsWith("yt:")) continue;
      const key = `${t.artistId}:${t.artistName}`;
      if (seen.has(key)) {
        const existing = scored.get(key);
        if (existing) existing.weight += 1;
        continue;
      }
      seen.add(key);
      scored.set(key, { id: t.artistId, name: t.artistName, image: t.image ?? t.imageSmall, weight: 1 });
    }
    if (scored.size >= limit) break;
  }

  return [...scored.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      name: a.name,
      image: a.image,
      imageSmall: a.image,
      website: null,
      location: null,
      joindate: null,
      nbTracks: null,
      nbAlbums: null,
      nbFans: null,
      bio: null,
    }));
}

/** Fetch a single album, with the live → DB → static failure ladder. */
export async function fetchAlbum(albumId: string): Promise<Album | null> {
  if (isJamendoArtistId(albumId)) {
    try {
      const album = await jamendo.fetchAlbum(albumId);
      await writeSuccessStatus();
      if (album) return album;
    } catch (err) {
      await writeFailureStatus(err);
    }
  }

  return fetchAlbumFromTracks(albumId);
}

/** Build an `Album` from its members when the live API is down. */
export async function fetchAlbumTracks(albumId: string, limit = 50): Promise<Track[]> {
  if (isJamendoArtistId(albumId)) {
    try {
      const out: Track[] = [];
      let offset = 0;
      while (out.length < limit) {
        const batch = await jamendo.fetchTracksByAlbum(albumId, Math.min(JAMENDO_PAGE_SIZE, limit - out.length), offset);
        if (batch.length === 0) break;
        out.push(...batch);
        if (batch.length < JAMENDO_PAGE_SIZE) break;
        offset += JAMENDO_PAGE_SIZE;
      }
      if (out.length > 0) {
        await cacheTracks(out);
        await writeSuccessStatus();
        return out;
      }
    } catch (err) {
      await writeFailureStatus(err);
    }
  }

  try {
    const rows = await prisma.cachedTrack.findMany({
      where: { albumId: albumId },
      orderBy: { releaseDate: "asc", popularityWeek: "desc" },
      take: limit,
    });
    if (rows.length > 0) return dedupeTracks(rows.map(dbRowToTrack));
  } catch {
    /* no database */
  }

  return staticTracks.filter((t) => t.albumId === albumId).slice(0, limit);
}

async function fetchAlbumFromTracks(albumId: string): Promise<Album | null> {
  const tracks = await fetchAlbumTracks(albumId, 50);
  if (albumId === "singles" || albumId === "unalbumed") {
    const singles = tracks.filter((t) => !t.albumId);
    const imageTrack = singles.find((t) => t.image ?? t.imageSmall) ?? null;
    const pic = imageTrack ? (imageTrack.image ?? imageTrack.imageSmall) : null;
    if (singles.length === 0) return null;
    return {
      id: albumId,
      name: "Singles & tracks",
      artistId: singles[0].artistId,
      artistName: singles[0].artistName,
      image: pic,
      imageSmall: null,
      releaseDate: null,
      nbTracks: singles.length,
    };
  }

  const valid = tracks.filter((t) => t.albumId === albumId);
  if (valid.length === 0) return null;
  const image = valid.find((t) => t.image ?? t.imageSmall) ?? null;
  const releases = valid
    .map((t) => t.releaseDate)
    .filter(Boolean)
    .sort();
  return {
    id: albumId,
    name: valid[0].albumName || `Album ${albumId}`,
    artistId: valid[0].artistId,
    artistName: valid[0].artistName,
    image: image ? (image.image ?? image.imageSmall ?? null) : null,
    imageSmall: null,
    releaseDate: releases[0] ?? null,
    nbTracks: valid.length,
  };
}

/** Group a flat list of tracks into album-bundled discs for an artist page. */
export function groupTracksByAlbum(tracks: Track[]): AlbumGroup[] {
  const byAlbum = new Map<string, Track[]>();
  const singles: Track[] = [];

  for (const track of tracks) {
    const key = track.albumId || "";
    if (key) {
      const list = byAlbum.get(key);
      if (list) list.push(track);
      else byAlbum.set(key, [track]);
    } else {
      singles.push(track);
    }
  }

  const groups: AlbumGroup[] = [];
  for (const [albumId, albumTracks] of byAlbum) {
    const image = albumTracks.find((t) => t.image ?? t.imageSmall) ?? null;
    const releases = albumTracks.map((t) => t.releaseDate).filter(Boolean).sort();
    groups.push({
      album: {
        id: albumId,
        name: albumTracks[0].albumName || `Album ${albumId}`,
        artistId: albumTracks[0].artistId || "",
        artistName: albumTracks[0].artistName,
        image: image ? (image.image ?? image.imageSmall ?? null) : null,
        imageSmall: image ? (image.imageSmall ?? image.image ?? null) : null,
        releaseDate: releases[0] ?? null,
        nbTracks: albumTracks.length,
      },
      tracks: albumTracks,
    });
  }

  groups.sort((a, b) => {
    const aDate = a.album.releaseDate ? new Date(a.album.releaseDate).getTime() : Infinity;
    const bDate = b.album.releaseDate ? new Date(b.album.releaseDate).getTime() : Infinity;
    return aDate - bDate;
  });

  if (singles.length > 0) {
    const pic = singles.find((t) => t.image ?? t.imageSmall);
    const img = pic ? (pic.image ?? pic.imageSmall) : null;
    groups.push({
      album: {
        id: "singles",
        name: "Singles & tracks",
        artistId: singles[0].artistId || "",
        artistName: singles[0].artistName,
        image: img,
        imageSmall: null,
        releaseDate: null,
        nbTracks: singles.length,
      },
      tracks: singles,
    });
  }

  return groups;
}

/* ------------------------------------------------------------------ */
/* Browse lists (top-level artists & albums pages)                     */
/* ------------------------------------------------------------------ */

interface ArtistAggregate {
  name: string;
  image: string | null;
  tracks: number;
  albums: Set<string>;
}

/** Collapse a flat track list into distinct artists, counting tracks and
 * distinct albums. Used for the "browse artists" page. YouTube-sourced tracks
 * carry no Jamendo artist page, so `yt:` ids are skipped (only Jamendo artists
 * are browsable). */
export function aggregateArtistsFromTracks(tracks: Track[]): Artist[] {
  const byId = new Map<string, ArtistAggregate>();
  for (const t of tracks) {
    if (!t.artistId || !t.artistName || t.artistId.startsWith("yt:")) continue;
    const entry = byId.get(t.artistId) ?? { name: t.artistName, image: null, tracks: 0, albums: new Set<string>() };
    entry.name = entry.name || t.artistName;
    entry.image = entry.image ?? (t.image || t.imageSmall) ?? null;
    entry.tracks += 1;
    if (t.albumId) entry.albums.add(t.albumId);
    byId.set(t.artistId, entry);
  }
  return [...byId.entries()]
    .map(([id, e]) => ({
      id,
      name: e.name,
      image: e.image,
      imageSmall: e.image,
      website: null,
      location: null,
      joindate: null,
      nbTracks: e.tracks,
      nbAlbums: e.albums.size,
      nbFans: null,
      bio: null,
    }))
    .sort((a, b) => (b.nbTracks ?? 0) - (a.nbTracks ?? 0));
}

/** Collapse a flat track list into distinct albums, counting tracks. Used for
 * the "browse albums" page when the live API is unreachable. */
export function aggregateAlbumsFromTracks(tracks: Track[]): Album[] {
  const byId = new Map<string, { name: string; artistId: string; artistName: string; image: string | null; count: number; releaseDate: string | null }>();
  for (const t of tracks) {
    if (!t.albumId) continue;
    const entry = byId.get(t.albumId) ?? {
      name: `Album ${t.albumId}`,
      artistId: t.artistId,
      artistName: t.artistName,
      image: null,
      count: 0,
      releaseDate: null,
    };
    if (entry.name === `Album ${t.albumId}` && t.albumName) entry.name = t.albumName;
    entry.artistId = entry.artistId || t.artistId;
    entry.artistName = entry.artistName || t.artistName;
    entry.image = entry.image ?? (t.image || t.imageSmall) ?? null;
    entry.count += 1;
    if (!entry.releaseDate && t.releaseDate) entry.releaseDate = t.releaseDate;
    byId.set(t.albumId, entry);
  }
  return [...byId.entries()]
    .map(([id, e]) => ({
      id,
      name: e.name,
      artistId: e.artistId,
      artistName: e.artistName,
      image: e.image,
      imageSmall: e.image,
      releaseDate: e.releaseDate,
      nbTracks: e.count,
    }))
    .sort((a, b) => (b.nbTracks ?? 0) - (a.nbTracks ?? 0));
}

/** Popular artists for the "Browse artists" page.

 * Artists are derived from the curated phonk track catalog (live → DB → static
 * ladder, with YouTube fills) so the list stays phonk-only and never surfaces
 * non-phonk Jamendo artists. This is best-effort and never throws — on a total
 * outage it falls back to the static snapshot. */
export async function fetchBrowseArtists(limit = 48): Promise<Artist[]> {
  const tracks = await fetchTracks({
    tags: PHONK_FAMILY_QUERY_TAGS,
    order: "popularity_total",
    limit: 360,
  }).catch(() => staticTracks);
  const source = tracks.length > 0 ? tracks : staticTracks;
  return aggregateArtistsFromTracks(source).slice(0, limit);
}

/** Popular albums for the "Browse albums" page.

 * Albums are derived from the curated phonk track catalog (same ladder as above)
 * so they stay phonk-only. On total outage it falls back to the static snapshot.
 */
export async function fetchBrowseAlbums(limit = 48): Promise<Album[]> {
  const tracks = await fetchTracks({
    tags: PHONK_FAMILY_QUERY_TAGS,
    order: "popularity_total",
    limit: 360,
  }).catch(() => staticTracks);
  const source = tracks.length > 0 ? tracks : staticTracks;
  return aggregateAlbumsFromTracks(source).slice(0, limit);
}
