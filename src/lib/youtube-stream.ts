import "server-only";

import { spawn } from "node:child_process";

import { ClientType, Innertube, Platform } from "youtubei.js";

import { YTDLP_BINARY } from "@/lib/ytdlp";

/**
 * Server-side extraction of a playable (deciphered) audio stream for a
 * YouTube-sourced track.
 *
 * Two things make this non-trivial these days:
 *
 * 1. YouTube's web player requires a "proof of origin" token (po_token) before
 *    it hands out playable stream URLs, and the library's default WEB client
 *    strips the URL/cipher fields without one. The ANDROID_VR client still
 *    returns decipherable URLs, so we rotate through clients until one yields a
 *    stream, then fall back to `yt-dlp -g` if all of them fail.
 *
 * 2. The media response no longer carries `Access-Control-Allow-Origin`, so a
 *    browser cannot read the stream cross-origin for a Web Audio analyser. The
 *    `/api/youtube/stream` route therefore proxies the bytes back same-origin
 *    (mirroring the Jamendo `/api/audio` proxy) instead of handing the raw URL
 *    to the `<audio>` element.
 *
 * youtubei.js v17 refuses to decipher URLs unless a JavaScript evaluator is
 * installed (`Platform.shim.eval`). The player script is assembled into
 * `data.output` (player functions plus a `process(n, sp, s)` helper that
 * returns `{ sig, n }`), so a plain `new Function` evaluation is enough.
 */

export interface ExtractedStream {
  url: string;
  mimeType?: string;
}

const STREAM_CACHE_TTL_MS = 30 * 60 * 1000;

interface CacheEntry {
  url: string;
  mimeType?: string;
  expiresAt: number;
}

/** Deciphered URLs expire server-side (~6h), so a 30-minute TTL is plenty. */
const urlCache = new Map<string, CacheEntry>();
const URL_CACHE_MAX = 1024;

/** Evict expired entries and, if still at capacity, the oldest ones (insertion
 * order). Keeps the cache bounded in long-running servers. */
function sweepUrlCache(): void {
  if (urlCache.size < URL_CACHE_MAX) return;
  const now = Date.now();
  for (const [key, entry] of urlCache) {
    if (entry.expiresAt <= now) urlCache.delete(key);
  }
  while (urlCache.size >= URL_CACHE_MAX) {
    const oldest = urlCache.keys().next();
    if (oldest.done) break;
    urlCache.delete(oldest.value);
  }
}

/** Drop a cached stream URL so the next request re-extracts (used when the
 * upstream proxy fetch fails — googlevideo URLs can be revoked before TTL). */
export function invalidateStreamCache(videoId: string): void {
  urlCache.delete(videoId);
}

/** One lazy `Innertube` session per client type (each is heavy to create). */
const innertubeCache = new Map<ClientType, Promise<Innertube>>();

Platform.shim.eval = (data) => new Function(data.output)();

function getInnertube(clientType: ClientType): Promise<Innertube> {
  let promise = innertubeCache.get(clientType);
  if (!promise) {
    promise = Innertube.create({
      lang: "en",
      location: "US",
      retrieve_player: true,
      client_type: clientType,
    });
    // Drop a failed creation so the next call retries instead of reusing the
    // rejected promise forever.
    promise.catch(() => innertubeCache.delete(clientType));
    innertubeCache.set(clientType, promise);
  }
  return promise;
}

async function extractWithClient(clientType: ClientType, videoId: string): Promise<ExtractedStream | null> {
  const yt = await getInnertube(clientType);
  const info = await yt.getBasicInfo(videoId);
  const format = info.chooseFormat({ type: "audio", quality: "best" });
  if (!format.url && !format.signature_cipher && !format.cipher) return null;
  const player = yt.session.player;
  if (!player) return null;
  const url = await format.decipher(player);
  if (!url || !url.startsWith("https://")) return null;
  return { url, mimeType: format.mime_type };
}

/** Shells out to yt-dlp for a direct stream URL (`-g`) as a last resort. */
function extractWithYtDlp(videoId: string, timeoutMs = 30_000): Promise<ExtractedStream> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      YTDLP_BINARY,
      [
        "-g",
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "--no-warnings",
        "--no-cache-dir",
        "--no-progress",
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        settled = true;
        reject(new Error("yt-dlp stream extraction timed out"));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 16_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`yt-dlp unavailable: ${err.message}`));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const line = stdout.trim().split("\n")[0];
      if (code === 0 && line) resolve({ url: line });
      else reject(new Error(`yt-dlp stream extraction failed (${code}): ${stderr.trim().slice(-300)}`));
    });
  });
}

/**
 * Returns a deciphered, playable audio stream URL for the video, trying each
 * youtube.js client in turn and falling back to yt-dlp. Results are cached
 * in memory for 30 minutes so seek/preload range requests don't re-extract.
 */
export async function extractStreamUrl(videoId: string): Promise<ExtractedStream> {
  const cached = urlCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, mimeType: cached.mimeType };
  }

  let result: ExtractedStream | null = null;
  for (const clientType of [ClientType.ANDROID_VR, ClientType.MWEB, ClientType.WEB]) {
    try {
      result = await extractWithClient(clientType, videoId);
      if (result) break;
    } catch (err) {
      console.warn(
        `[yt-stream] ${clientType} extraction failed for ${videoId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (!result) {
    result = await extractWithYtDlp(videoId);
  }

  sweepUrlCache();
  urlCache.set(videoId, {
    url: result.url,
    mimeType: result.mimeType,
    expiresAt: Date.now() + STREAM_CACHE_TTL_MS,
  });
  return result;
}
