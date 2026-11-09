import type { Track } from "@/lib/jamendo";
import { classifyTrack } from "@/lib/phonk-genres";

/**
 * "For You" recommendation engine.
 *
 * Builds a listening affinity profile from a user's play history + favorites,
 * then scores a candidate pool (trending, fresh drops, per-subgenre rows) by
 * subgenre / artist / tag affinity plus momentum, with a diversity pass so a
 * single dominant subgenre or artist never monopolizes the row.
 */

export interface AffinityProfile {
  subgenres: Map<string, number>;
  artists: Map<string, number>;
  tags: Map<string, number>;
  favoriteIds: Set<string>;
  hasHistory: boolean;
  topSubgenre: string | null;
  topTag: string | null;
  topArtist: string | null;
}

const SUBGENRE_WEIGHT = 2.5;
const ARTIST_WEIGHT = 3.5;
const TAG_WEIGHT = 1.1;
const FAVORITE_BOOST = 2.0;
const POPULARITY_WEIGHT = 1.5;

/** Recency decay so a more recent listen counts more than an old one. */
function decay(index: number): number {
  return 1 / (1 + 0.08 * index);
}

function trackSignals(track: Track): { subgenre: string | null; artist: string | null; tags: string[] } {
  const subgenre = track.subgenre ?? classifyTrack(track)?.slug ?? null;
  const tags: string[] = [];
  for (const raw of track.tags) {
    const tag = raw.toLowerCase().trim();
    if (!tag || tag === "phonk") continue;
    tags.push(tag);
  }
  return { subgenre, artist: track.artistName || null, tags };
}

function bump(map: Map<string, number>, key: string | null, weight: number) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + weight);
}

export function buildAffinity(listenedTracks: Track[], favoriteTracks: Track[]): AffinityProfile {
  const subgenres = new Map<string, number>();
  const artists = new Map<string, number>();
  const tags = new Map<string, number>();
  const favoriteIds = new Set<string>();

  listenedTracks.forEach((track, index) => {
    const weight = decay(index);
    const signals = trackSignals(track);
    bump(subgenres, signals.subgenre, weight);
    bump(artists, signals.artist, weight);
    for (const tag of signals.tags) bump(tags, tag, weight);
  });

  for (const track of favoriteTracks) {
    favoriteIds.add(track.id);
    const signals = trackSignals(track);
    bump(subgenres, signals.subgenre, 0.6);
    bump(artists, signals.artist, 0.8);
    for (const tag of signals.tags) bump(tags, tag, 0.4);
  }

  const sortByCount = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]);

  return {
    subgenres,
    artists,
    tags,
    favoriteIds,
    hasHistory: listenedTracks.length > 0,
    topSubgenre: sortByCount(subgenres)[0]?.[0] ?? null,
    topTag: sortByCount(tags)[0]?.[0] ?? null,
    topArtist: sortByCount(artists)[0]?.[0] ?? null,
  };
}

const MAX_PER_SUBGENRE = 3;
const MAX_PER_ARTIST = 2;

interface Scored {
  track: Track;
  score: number;
  slug: string | null;
}

/** Placeholder artist names that should never be capped (they group unrelated
 * uploads rather than a single artist). */
const GENERIC_ARTIST_NAMES = new Set([
  "unknown artist",
  "unknown",
  "various artists",
  "various",
]);

/** Greedily fill `picks` from the affinity-sorted pool, honouring per-subgenre
 * and per-artist caps. Counts of already-picked items are respected. */
function fillWithCaps(
  picks: Scored[],
  scored: Scored[],
  limit: number,
  subgenreCap: number,
  artistCap: number,
): Scored[] {
  const subgenreCount = new Map<string, number>();
  const artistCount = new Map<string, number>();
  const picked = new Set<Scored>();
  for (const item of picks) {
    if (item.slug) subgenreCount.set(item.slug, (subgenreCount.get(item.slug) ?? 0) + 1);
    const artist = item.track.artistName;
    if (artist && !GENERIC_ARTIST_NAMES.has(artist.toLowerCase().trim())) {
      artistCount.set(artist, (artistCount.get(artist) ?? 0) + 1);
    }
    picked.add(item);
  }
  for (const item of scored) {
    if (picks.length >= limit) break;
    if (picked.has(item)) continue;
    const overSubgenre = item.slug ? (subgenreCount.get(item.slug) ?? 0) >= subgenreCap : false;
    const artist = item.track.artistName;
    const overArtist = artist && !GENERIC_ARTIST_NAMES.has(artist.toLowerCase().trim())
      ? (artistCount.get(artist) ?? 0) >= artistCap
      : false;
    if (overSubgenre || overArtist) continue;
    picks.push(item);
    picked.add(item);
    if (item.slug) subgenreCount.set(item.slug, (subgenreCount.get(item.slug) ?? 0) + 1);
    if (artist && !GENERIC_ARTIST_NAMES.has(artist.toLowerCase().trim())) {
      artistCount.set(artist, (artistCount.get(artist) ?? 0) + 1);
    }
  }
  return picks;
}

export function rankForYou(profile: AffinityProfile, candidates: Track[], limit = 12): Track[] {
  const seen = new Set<string>();
  const unique = candidates.filter((track) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });

  const maxPopularity = Math.max(1, ...unique.map((track) => track.popularityWeek ?? 0));

  const scored = unique
    .map((track) => {
      const signals = trackSignals(track);
      let score = 0;
      score += (signals.subgenre ? (profile.subgenres.get(signals.subgenre) ?? 0) : 0) * SUBGENRE_WEIGHT;
      score += (signals.artist ? (profile.artists.get(signals.artist) ?? 0) : 0) * ARTIST_WEIGHT;
      let matched = 0;
      for (const tag of signals.tags) {
        if (matched >= 3) break;
        const count = profile.tags.get(tag);
        if (count) {
          score += count * TAG_WEIGHT;
          matched += 1;
        }
      }
      if (profile.favoriteIds.has(track.id)) score += FAVORITE_BOOST;
      score += ((track.popularityWeek ?? 0) / maxPopularity) * POPULARITY_WEIGHT;
      return { track, score, slug: signals.subgenre };
    })
    .sort((a, b) => b.score - a.score);

  // Three passes with progressively relaxed caps: strict diversity first, then
  // allow a subgenre/artist up to ~half the row, then fill unconditionally so a
  // row is never left short.
  const picks = fillWithCaps([], scored, limit, MAX_PER_SUBGENRE, MAX_PER_ARTIST);
  fillWithCaps(picks, scored, limit, Math.max(MAX_PER_SUBGENRE, Math.ceil(limit / 2)), Math.max(MAX_PER_ARTIST, Math.ceil(limit / 3)));
  fillWithCaps(picks, scored, limit, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);

  return picks.slice(0, limit).map((item) => item.track);
}
