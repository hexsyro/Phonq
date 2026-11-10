import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Proj = { id: number; apiKey: string; dailyLimit: number };

const poolMock = vi.hoisted(() => ({
  hasProjects: vi.fn(() => true),
  getAvailableProject: vi.fn(async (): Promise<Proj | null> => ({ id: 0, apiKey: "test-key", dailyLimit: 10000 })),
  markProjectExhausted: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
  UNIT_COST: { search: 100, playback: 1 },
  dailySearchBudget: vi.fn(() => 100),
  getQuotaStatus: vi.fn(),
  endpointFor: vi.fn((p: string) => p.split("/").pop() ?? p),
}));
vi.mock("@/lib/youtube-pool", () => poolMock);

const redisMock = vi.hoisted(() => ({
  ytRedis: {
    cacheGet: vi.fn(async (_key: string): Promise<unknown> => null),
    cacheSet: vi.fn(async (_k: string, _v: unknown) => undefined),
    cacheDel: vi.fn(async (_k: string) => undefined),
    readCounter: vi.fn(async (_k: string) => 0),
    incrCounter: vi.fn(async (_k: string, amount: number) => amount),
    ping: vi.fn(async () => "PONG"),
    configured: false,
    healthy: vi.fn(async () => false),
    isOnline: vi.fn(() => true),
    dbSize: vi.fn(async () => 0),
    usage: vi.fn(async () => ({ ops: 0, readBytes: 0, writeBytes: 0, hits: 0, misses: 0 })),
    flushUsage: vi.fn(async () => ({ ops: 0, readBytes: 0, writeBytes: 0, hits: 0, misses: 0 })),
  },
}));
vi.mock("@/lib/yt-redis", () => ({ default: redisMock.ytRedis, ytRedis: redisMock.ytRedis, YtRedis: class {} }));

const dbMock = vi.hoisted(() => ({
  upsertSong: vi.fn(async () => {}),
  findSongByVideoId: vi.fn(async (_id: string): Promise<any | null> => null),
  searchSongFuzzy: vi.fn(async (): Promise<any[] | null> => null),
  findSongsByGenre: vi.fn(async () => []),
  findGeneralSongs: vi.fn(async () => []),
  findAllSongs: vi.fn(async () => []),
  findSongsByIds: vi.fn(async () => []),
  touchLastPlayed: vi.fn(async () => {}),
  unitsUsedToday: vi.fn(async () => 0),
  recordApiCall: vi.fn(async () => {}),
  recordBandwidth: vi.fn(async () => {}),
  redisUsageToday: vi.fn(async () => null),
  today: vi.fn(() => "2026-08-11"),
  thumbnailFor: (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  hasDedicatedCatalogDb: false,
}));
vi.mock("@/lib/youtube-db", () => dbMock);

import {
  fetchGenreVideos,
  fetchQueryVideos,
  fetchVideosByIds,
  isoDurationToSeconds,
  isBlacklistedTitle,
  isDeprioritizedTitle,
  isTopicChannel,
  durationBounds,
  normalizeKey,
  resolveSongVideo,
  parseTitle,
  SEARCH_CACHE_TTL,
  SONG_CACHE_TTL,
  NEG_CACHE_TTL,
} from "@/lib/youtube";

describe("normalizeKey", () => {
  it("lowercases and strips accents + punctuation", () => {
    expect(normalizeKey("Anitta Envolver")).toBe("anitta envolver");
    expect(normalizeKey("  MC   Kevinho  ")).toBe("mc kevinho");
    expect(normalizeKey("Mc Don Juan — Tudo Ok")).toBe("mc don juan tudo ok");
    expect(normalizeKey("DJ Boy & MC Smith (Ao Vivo)")).toBe("dj boy mc smith ao vivo");
    expect(normalizeKey("Café, 123!")).toBe("cafe 123");
  });

  it("handles empty input", () => {
    expect(normalizeKey("")).toBe("");
    expect(normalizeKey("   ")).toBe("");
  });
});

describe("isoDurationToSeconds", () => {
  it("parses ISO-8601 YouTube durations", () => {
    expect(isoDurationToSeconds("PT3M45S")).toBe(225);
    expect(isoDurationToSeconds("PT1H2M3S")).toBe(3723);
    expect(isoDurationToSeconds("PT1M")).toBe(60);
    expect(isoDurationToSeconds("PT30S")).toBe(30);
    expect(isoDurationToSeconds("PT2H")).toBe(7200);
  });

  it("returns 0 for missing or malformed input", () => {
    expect(isoDurationToSeconds(undefined)).toBe(0);
    expect(isoDurationToSeconds("")).toBe(0);
    expect(isoDurationToSeconds("3:45")).toBe(0);
    expect(isoDurationToSeconds("PT")).toBe(0);
  });
});

describe("isBlacklistedTitle", () => {
  it("flags unambiguous junk: mixes, compilations, karaoke, and track-length labels", () => {
    for (const title of [
      "Brazilian Funk Mix 2026",
      "Melhores Funks do Ano — Compilation",
      "Funk Full Album 1 Hour",
      "Top 10 Brazilian Funk",
      "Non-Stop Funk Session",
      "Karaoke Brasileiro",
      "Reaction to the Funk",
      "Lyrics Video",
      "Type Beat Brasileiro",
      "Instrumental Only",
      "mixes de ontem",
      "mixtape do verão",
    ]) {
      expect(isBlacklistedTitle(title), title).toBe(true);
    }
  });

  it("keeps official audio, remixes, and live/covers (never disqualified)", () => {
    for (const title of [
      "Brasil Funk Banger",
      "Anitta - Envolver (Official Audio)",
      "MC Kevin - Remix",
      "Official Music Video",
      "delivery funk",
      "mixed feelings",
      "MC Kevinho (Live)",
      "Funk ao vivo",
      "MC Kevin O Chris - Evoluiu (Ao Vivo)",
      "Cover: Ne Me Quitte Pas",
    ]) {
      expect(isBlacklistedTitle(title), title).toBe(false);
    }
  });
});

describe("isDeprioritizedTitle", () => {
  it("flags official live/covers for soft deprioritization", () => {
    for (const title of [
      "MC Kevinho (Live)",
      "Funk ao vivo",
      "MC Kevin O Chris - Evoluiu (Ao Vivo)",
      "Cover: Ne Me Quitte Pas",
    ]) {
      expect(isDeprioritizedTitle(title), title).toBe(true);
    }
  });

  it("ignores studio originals and junk", () => {
    for (const title of [
      "Brasil Funk Banger",
      "Anitta - Envolver (Official Audio)",
      "Brazilian Funk Mix 2026",
      "Karaoke Brasileiro",
    ]) {
      expect(isDeprioritizedTitle(title), title).toBe(false);
    }
  });
});

describe("isTopicChannel", () => {
  it("detects auto-generated Topic channels case-insensitively", () => {
    expect(isTopicChannel("Anitta - Topic")).toBe(true);
    expect(isTopicChannel("MC Kevinho - TOPIC")).toBe(true);
    expect(isTopicChannel("Anitta Official")).toBe(false);
    expect(isTopicChannel(null)).toBe(false);
    expect(isTopicChannel(undefined)).toBe(false);
  });
});

describe("durationBounds", () => {
  it("uses the 120–420s window by default", () => {
    expect(durationBounds()).toEqual({ min: 120, max: 420 });
    expect(durationBounds("drift")).toEqual({ min: 120, max: 420 });
  });

  it("lowers the floor to 90s for Brazilian funk", () => {
    expect(durationBounds("brazilian")).toEqual({ min: 90, max: 420 });
    expect(durationBounds("brazilian-funk")).toEqual({ min: 90, max: 420 });
  });
});

describe("parseTitle", () => {
  it("parses Topic channels, separators and 'by' joins", () => {
    expect(parseTitle("Envolver (Official Audio)", "Anitta - Topic")).toEqual({
      songTitle: "Envolver",
      artistName: "Anitta",
    });
    expect(parseTitle("Anitta - Envolver", null)).toEqual({
      songTitle: "Envolver",
      artistName: "Anitta",
    });
    expect(parseTitle("Envolver by Anitta", null)).toEqual({
      songTitle: "Envolver",
      artistName: "Anitta",
    });
    expect(parseTitle("Plain Song", null)).toEqual({ songTitle: "Plain Song", artistName: "" });
  });
});

describe("fetchGenreVideos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolMock.hasProjects.mockReturnValue(true);
    poolMock.getAvailableProject.mockResolvedValue({ id: 0, apiKey: "test-key", dailyLimit: 10000 });
    poolMock.recordUsage.mockResolvedValue(undefined);
    dbMock.upsertSong.mockResolvedValue(undefined);
    dbMock.findSongByVideoId.mockResolvedValue(null);
    dbMock.searchSongFuzzy.mockResolvedValue(null);
    redisMock.ytRedis.cacheGet.mockResolvedValue(null);
  });

  afterEach(() => {
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEYS;
    delete process.env.YOUTUBE_RUNTIME_FILL;
    vi.unstubAllGlobals();
  });

  function stubYouTube() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const isSearch = url.pathname.endsWith("/search");
        const body = isSearch
          ? {
              items: [
                {
                  id: { videoId: "g1" },
                  snippet: {
                    title: "Brasil Funk Banger",
                    channelId: "c1",
                    channelTitle: "Br Funk - Topic",
                    thumbnails: { medium: { url: "https://i.ytimg.com/vi/g1/mqdefault.jpg" } },
                  },
                },
                {
                  id: { videoId: "g2" },
                  snippet: {
                    title: "Brasil Funk Banger (Lyrics)",
                    channelId: "c2",
                    channelTitle: "Lyrics Channel",
                    thumbnails: { medium: { url: "https://i.ytimg.com/vi/g2/mqdefault.jpg" } },
                  },
                },
                {
                  id: { videoId: "g3" },
                  snippet: {
                    title: "Drift Jean Challenge",
                    channelId: "c3",
                    channelTitle: "Random Uploader",
                    thumbnails: { medium: { url: "https://i.ytimg.com/vi/g3/mqdefault.jpg" } },
                  },
                },
              ],
            }
          : {
              items: [
                {
                  id: "g1",
                  snippet: { title: "Brasil Funk Banger", channelId: "c1", channelTitle: "Br Funk - Topic" },
                  contentDetails: { duration: "PT3M10S" },
                  status: { embeddable: true },
                },
                {
                  id: "g3",
                  snippet: { title: "Drift Jean Challenge", channelId: "c3", channelTitle: "Random Uploader" },
                  contentDetails: { duration: "PT2M5S" },
                  status: { embeddable: true },
                },
              ],
            };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
  }

  it("returns embeddable genre videos (skipping lyrics) and persists them", async () => {
    stubYouTube();
    const videos = await fetchGenreVideos("brazilian-fill-1", ["Brazilian Funk phonk"], 12);

    expect(videos).toHaveLength(2);
    expect(videos.map((v) => v.videoId)).toEqual(["g1", "g3"]);
    expect(videos.every((v) => v.subgenre === "brazilian-fill-1")).toBe(true);
    expect(videos.every((v) => v.embeddable)).toBe(true);
    expect(videos[0].artistName).toBe("Br Funk"); // parsed from "- Topic" channel
    expect(videos[0].thumbnail).toBe("https://i.ytimg.com/vi/g1/hqdefault.jpg"); // reconstructed
    expect(dbMock.upsertSong).toHaveBeenCalledTimes(2);
    expect(poolMock.recordUsage).toHaveBeenCalled(); // search + videos.list ledger
  });

  it("does not search when the quota pool is exhausted", async () => {
    poolMock.getAvailableProject.mockResolvedValue(null as unknown as Proj);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const videos = await fetchGenreVideos("brazilian-fill-2", ["Brazilian Funk phonk"], 12);
    expect(videos).toHaveLength(0);
    expect(dbMock.upsertSong).not.toHaveBeenCalled();
    // fetch is never reached once the pool refuses a project.
    expect(vi.mocked(fetch as typeof globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("no-ops without projects or when runtime fill is disabled", async () => {
    poolMock.hasProjects.mockReturnValue(false);
    expect(await fetchGenreVideos("fill-x", ["brasil phonk"], 5)).toEqual([]);

    poolMock.hasProjects.mockReturnValue(true);
    process.env.YOUTUBE_RUNTIME_FILL = "0";
    expect(await fetchGenreVideos("fill-x2", ["brasil phonk"], 5)).toEqual([]);
  });

  it("keeps official '(Ao Vivo)' songs while dropping mixes and shorts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const isSearch = url.pathname.endsWith("/search");
        const body = isSearch
          ? {
              items: [
                {
                  id: { videoId: "v1" },
                  snippet: { title: "Evoluiu (Ao Vivo)", channelId: "c1", channelTitle: "MC Kevin O Chris - Topic" },
                },
                {
                  id: { videoId: "v2" },
                  snippet: { title: "Funk Mix 2026 (Non-Stop)", channelId: "c9", channelTitle: "Funk Mixes" },
                },
                {
                  id: { videoId: "v3" },
                  snippet: { title: "Evoluiu (clip)", channelId: "c8", channelTitle: "Clips Channel" },
                },
              ],
            }
          : {
              items: [
                {
                  id: "v1",
                  snippet: { title: "Evoluiu (Ao Vivo)", channelId: "c1", channelTitle: "MC Kevin O Chris - Topic" },
                  contentDetails: { duration: "PT3M2S" },
                  status: { embeddable: true },
                },
                {
                  id: "v2",
                  snippet: { title: "Funk Mix 2026 (Non-Stop)", channelId: "c9", channelTitle: "Funk Mixes" },
                  contentDetails: { duration: "PT1H2M3S" },
                  status: { embeddable: true },
                },
                {
                  id: "v3",
                  snippet: { title: "Evoluiu (clip)", channelId: "c8", channelTitle: "Clips Channel" },
                  contentDetails: { duration: "PT30S" },
                  status: { embeddable: true },
                },
              ],
            };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    const videos = await fetchGenreVideos("brazilian-fill-4", ["Evoluiu"], 12);
    // The official "(Ao Vivo)" release (an artist-published song) must surface;
    // the non-stop mix and the 30s clip are still filtered out.
    expect(videos.map((v) => v.videoId)).toEqual(["v1"]);
    expect(videos[0].artistName).toBe("MC Kevin O Chris");
  });

  it("drops mix compilations and shorts that pass the title/duration filters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const isSearch = url.pathname.endsWith("/search");
        const body = isSearch
          ? {
              items: [
                { id: { videoId: "m1" }, snippet: { title: "Explicit Lover", channelId: "c1", channelTitle: "Explicit - Topic" } },
                { id: { videoId: "m2" }, snippet: { title: "Explicit Lover (Mix 1 Hour)", channelId: "c9", channelTitle: "Funk Mixes" } },
                { id: { videoId: "m3" }, snippet: { title: "Explicit Lover (clip)", channelId: "c8", channelTitle: "Clips Channel" } },
              ],
            }
          : {
              items: [
                { id: "m1", snippet: { title: "Explicit Lover", channelId: "c1", channelTitle: "Explicit - Topic" }, contentDetails: { duration: "PT3M10S" }, status: { embeddable: true } },
                { id: "m2", snippet: { title: "Explicit Lover (Mix 1 Hour)", channelId: "c9", channelTitle: "Funk Mixes" }, contentDetails: { duration: "PT1H2M3S" }, status: { embeddable: true } },
                { id: "m3", snippet: { title: "Explicit Lover (clip)", channelId: "c8", channelTitle: "Clips Channel" }, contentDetails: { duration: "PT30S" }, status: { embeddable: true } },
              ],
            };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    const videos = await fetchGenreVideos("brazilian-fill-3", ["Explicit Lover"], 12);
    expect(videos.map((v) => v.videoId)).toEqual(["m1"]);
    expect(videos[0].artistName).toBe("Explicit");
  });

  it("returns empty when the live search returns no items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ items: [{ id: { videoId: "x1" }, snippet: { title: "Lyrics", channelTitle: "Lyric Channel" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const videos = await fetchGenreVideos("fill-lyrics", ["Something"], 12);
    expect(videos).toHaveLength(0);
  });

  it("returns empty when the quota pool is exhausted mid search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ items: [{ id: { videoId: "q1" }, snippet: { title: "Song", channelTitle: "Artist - Topic", thumbnails: { medium: { url: "u" } } } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    poolMock.getAvailableProject.mockResolvedValue(null as unknown as Proj);

    const videos = await fetchQueryVideos("Brodyaga Funk", 12, "brazilian");
    expect(videos).toHaveLength(0);
    expect(dbMock.upsertSong).not.toHaveBeenCalled();
  });

  it("marks the project exhausted on a 429 rate-limit rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: "Quota exceeded for quota metric 'Search Queries' and limit 'Search Queries per day'", reason: "quotaExceeded" } }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const videos = await fetchQueryVideos("Rate Limited", 12, "brazilian");
    expect(videos).toHaveLength(0);
    expect(dbMock.upsertSong).not.toHaveBeenCalled();
    // The router charges the project's headroom so the next request rotates
    // away instead of hammering the same exhausted key all day.
    expect(poolMock.markProjectExhausted).toHaveBeenCalledWith(0, "search");
  });

  it("marks the project exhausted on a 403 quotaExceeded rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { message: "Quota exceeded", reason: "quotaExceeded" } }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const videos = await fetchGenreVideos("fill-quota-403", ["Phonk"], 12);
    expect(videos).toHaveLength(0);
    expect(poolMock.markProjectExhausted).toHaveBeenCalledWith(0, "search");
  });

  it("logs an error (but does not exhaust the project) on a non-quota 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "Backend failure", reason: "backendError" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const videos = await fetchGenreVideos("fill-500", ["Phonk"], 12);
    expect(videos).toHaveLength(0);
    expect(poolMock.markProjectExhausted).not.toHaveBeenCalled();
  });
});

describe("resolveSongVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolMock.hasProjects.mockReturnValue(true);
    poolMock.getAvailableProject.mockResolvedValue({ id: 0, apiKey: "test-key", dailyLimit: 10000 });
    poolMock.recordUsage.mockResolvedValue(undefined);
    dbMock.upsertSong.mockResolvedValue(undefined);
    dbMock.findSongByVideoId.mockResolvedValue(null);
    dbMock.searchSongFuzzy.mockResolvedValue(null);
    redisMock.ytRedis.cacheGet.mockResolvedValue(null);
    redisMock.ytRedis.cacheSet.mockResolvedValue(undefined);
  });

  it("returns the DB song from the Redis hot cache and skips the live search", async () => {
    redisMock.ytRedis.cacheGet.mockImplementation(async (k: string) =>
      k.startsWith("search:") ? "abc123" : null,
    );
    dbMock.findSongByVideoId.mockResolvedValue({
      videoId: "abc123",
      title: "Envolver",
      artistName: "Anitta",
      duration: 200,
      thumbnail: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
      channelId: "c1",
      channelTitle: "Anitta - Topic",
      embeddable: true,
      subgenre: "brazilian",
      source: "search",
    });

    const video = await resolveSongVideo("Envolver", "Anitta", "brazilian");
    expect(video?.videoId).toBe("abc123");
    expect(dbMock.findSongByVideoId).toHaveBeenCalledWith("abc123");
    // The DB-backed song warms the song:{videoId} read-through cache so the
    // next resolve for the same id skips Postgres entirely.
    expect(redisMock.ytRedis.cacheSet).toHaveBeenCalledWith(
      "song:abc123",
      expect.objectContaining({ videoId: "abc123", title: "Envolver", artistName: "Anitta" }),
      SONG_CACHE_TTL,
    );
    // No live search, no fuzzy lookup, no persistence.
    expect(poolMock.getAvailableProject).not.toHaveBeenCalled();
    expect(dbMock.searchSongFuzzy).not.toHaveBeenCalled();
    expect(dbMock.upsertSong).not.toHaveBeenCalled();
  });

  it("falls through to a live search on a cold cache and caches the winner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const isSearch = url.pathname.endsWith("/search");
        const body = isSearch
          ? { items: [{ id: { videoId: "live1" }, snippet: { title: "Funk Banger", channelTitle: "Br Funk - Topic", thumbnails: { medium: { url: "u" } } } }] }
          : { items: [{ id: "live1", snippet: { title: "Funk Banger", channelTitle: "Br Funk - Topic" }, contentDetails: { duration: "PT2M30S" }, status: { embeddable: true } }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    const video = await resolveSongVideo("Funk Banger", "Br Funk");
    expect(video?.videoId).toBe("live1");
    expect(dbMock.upsertSong).toHaveBeenCalledTimes(1);
    expect(redisMock.ytRedis.cacheSet).toHaveBeenCalledWith(expect.stringMatching(/^search:/), "live1", SEARCH_CACHE_TTL);
  });

  it("negative-caches the query when a live search runs but nothing passes the relevance floor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const isSearch = url.pathname.endsWith("/search");
        const body = isSearch
          ? { items: [{ id: { videoId: "z1" }, snippet: { title: "Totally Unrelated Video", channelTitle: "Somebody - Random", thumbnails: { medium: { url: "u" } } } }] }
          : { items: [{ id: "z1", snippet: { title: "Totally Unrelated Video", channelTitle: "Somebody - Random" }, contentDetails: { duration: "PT2M30S" }, status: { embeddable: true } }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    const video = await resolveSongVideo("Missing Song", "Nobody");
    expect(video).toBeNull();
    expect(redisMock.ytRedis.cacheSet).toHaveBeenCalledWith(expect.stringMatching(/^neg:/), "1", NEG_CACHE_TTL);
    expect(dbMock.upsertSong).not.toHaveBeenCalled();
  });

  it("does not negative-cache the query when the search pool is exhausted", async () => {
    // Pool exhaustion says nothing about whether the song exists — negative-
    // caching here would poison the query for 2h after the API recovers.
    poolMock.getAvailableProject.mockResolvedValue(null);

    const video = await resolveSongVideo("Missing Song", "Nobody");
    expect(video).toBeNull();
    expect(redisMock.ytRedis.cacheSet).not.toHaveBeenCalledWith(expect.stringMatching(/^neg:/), "1", NEG_CACHE_TTL);
    expect(dbMock.upsertSong).not.toHaveBeenCalled();
  });
});

describe("fetchVideosByIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns DB rows and warms the song cache", async () => {
    dbMock.findSongsByIds.mockResolvedValue([
      {
        videoId: "db1",
        title: "Envolver",
        artistName: "Anitta",
        duration: 200,
        thumbnail: "https://i.ytimg.com/vi/db1/hqdefault.jpg",
        channelId: "c1",
        channelTitle: "Anitta - Topic",
        embeddable: true,
        subgenre: "brazilian",
        source: "search",
      } as never,
    ]);

    const videos = await fetchVideosByIds(["db1", "missing1"]);
    expect(videos.map((v) => v.videoId)).toEqual(["db1"]);
    expect(dbMock.findSongsByIds).toHaveBeenCalledWith(["db1", "missing1"]);
    expect(redisMock.ytRedis.cacheSet).toHaveBeenCalledWith("song:db1", expect.any(Object), SONG_CACHE_TTL);
  });

  it("recovers videos that only exist in the Redis read-through cache", async () => {
    dbMock.findSongsByIds.mockResolvedValue([]);
    redisMock.ytRedis.cacheGet.mockImplementation(async (k: string) =>
      k === "song:ytcached1"
        ? {
            videoId: "ytcached1",
            title: "Cached Banger",
            artistName: "Cache Artist",
            duration: 180,
            channelId: "c9",
            channelTitle: "Cache Artist - Topic",
            embeddable: true,
            subgenre: "drift",
            source: "search",
          }
        : null,
    );

    const videos = await fetchVideosByIds(["ytcached1", "nowhere"]);
    const ids = videos.map((v) => v.videoId);
    expect(ids).toContain("ytcached1");
    expect(ids).not.toContain("nowhere");
    expect(videos.find((v) => v.videoId === "ytcached1")?.title).toBe("Cached Banger");
    expect(dbMock.findSongsByIds).toHaveBeenCalledWith(["ytcached1", "nowhere"]);
  });
});
