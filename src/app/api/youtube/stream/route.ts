import "server-only";

import { extractStreamUrl, invalidateStreamCache } from "@/lib/youtube-stream";
import { checkRateLimit, ipKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Same-origin audio proxy for YouTube-sourced tracks.
 *
 * GET /api/youtube/stream?videoId=…
 *
 * Extracts a deciphered audio stream URL (youtube.js, with a yt-dlp fallback —
 * see `@/lib/youtube-stream`) and streams the bytes back through this server.
 * YouTube's media responses no longer send `Access-Control-Allow-Origin`, so a
 * browser can't read them for the Web Audio analyser; proxying keeps the media
 * same-origin (just like the Jamendo `/api/audio` proxy) so the analyser works.
 *
 * Range requests are forwarded upstream so seeking works. Access is bounded by
 * the per-IP rate limit below; playback must never depend on the catalog DB
 * being reachable or the song being cached, or every YouTube track would
 * silently fall back to the IFrame engine.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ONE_HOUR = 60 * 60 * 24 * 365;

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders() });
}

export async function GET(request: Request) {
  if (!(await checkRateLimit(ipKey(request), 1200, 60_000))) {
    return new Response("Too many requests, slow down", { status: 429, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const videoId = url.searchParams.get("videoId")?.trim() ?? "";
  if (!VIDEO_ID_RE.test(videoId)) {
    return new Response("Invalid videoId", { status: 400, headers: corsHeaders() });
  }

  const range = request.headers.get("range");
  const upstreamHeaders: HeadersInit = { accept: "audio/*, */*;q=0.8" };
  if (range) upstreamHeaders.range = range;

  const fetchUpstream = async (target: string) => fetch(target, { method: "GET", headers: upstreamHeaders, redirect: "follow" });
  const usable = (res: Response) => res.ok || res.status === 416;

  let target: string;
  let res: Response;
  try {
    target = (await extractStreamUrl(videoId)).url;
  } catch (err) {
    console.warn(`[yt-stream] extraction failed for ${videoId}: ${err instanceof Error ? err.message : err}`);
    return new Response("Stream unavailable", { status: 502, headers: corsHeaders() });
  }

  try {
    res = await fetchUpstream(target);
    if (!usable(res)) {
      // Cached googlevideo URLs can be revoked before their TTL — drop the
      // stale entry and re-extract once so a dead URL doesn't keep 502ing (and
      // silently demoting the track to the IFrame animation path).
      invalidateStreamCache(videoId);
      target = (await extractStreamUrl(videoId)).url;
      res = await fetchUpstream(target);
    }

    if (!usable(res)) {
      return new Response(`Upstream error ${res.status}`, { status: 502, headers: corsHeaders() });
    }

    const headers = new Headers(corsHeaders());
    headers.set("content-type", res.headers.get("content-type") || "audio/mp4");
    headers.set("accept-ranges", "bytes");

    const contentLength = res.headers.get("content-length");
    const contentRange = res.headers.get("content-range");
    if (contentRange) {
      headers.set("content-range", contentRange);
      // Do NOT fabricate a content-length of "0" when the upstream served the
      // partial body with chunked transfer encoding (no content-length header):
      // that makes the client believe the range is empty and breaks seeking.
      if (contentLength) headers.set("content-length", contentLength);
      return new Response(res.body, { status: 206, headers });
    }
    if (contentLength) headers.set("content-length", contentLength);

    // Range requested but upstream returned the full body (e.g. 416 with full
    // content): serve as 200 with the full stream.
    if (range && (!contentRange || res.status === 416)) {
      return new Response(res.body, { status: 200, headers });
    }

    return new Response(res.body, { status: 200, headers });
  } catch (err) {
    console.warn(`[yt-stream] proxy failed for ${videoId}: ${err instanceof Error ? err.message : err}`);
    return new Response("Proxy error", { status: 502, headers: corsHeaders() });
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "range, content-range, content-type, authorization",
    "access-control-expose-headers": "accept-ranges, content-range, content-length, content-type",
    "cache-control": `public, max-age=${ONE_HOUR}`,
  };
}
