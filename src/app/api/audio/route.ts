import "server-only";

import { checkRateLimit, ipKey } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const ALLOWED_HOSTS = new Set<string>([
  "api.jamendo.com",
  "prod-1.storage.jamendo.com",
  "prod-2.storage.jamendo.com",
  "prod-3.storage.jamendo.com",
  "mp3.jamendo.com",
  "mp3d.jamendo.com",
]);

const ONE_HOUR = 60 * 60 * 24 * 365;

export async function OPTIONS() {
  return new Response(null, {
    headers: corsHeaders(),
  });
}

export async function GET(request: Request) {
  if (!(await checkRateLimit(ipKey(request), 1200, 60_000))) {
    return new Response("Too many requests, slow down", { status: 429, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return new Response("Missing ?url=", { status: 400, headers: corsHeaders() });

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response("Invalid url", { status: 400, headers: corsHeaders() });
  }
  if (parsed.protocol !== "https:") {
    return new Response("Only https targets are allowed", { status: 400, headers: corsHeaders() });
  }
  if (!ALLOWED_HOSTS.has(parsed.host)) {
    return new Response("Host not allowed", { status: 403, headers: corsHeaders() });
  }

  try {
    const range = request.headers.get("range");
    const upstreamHeaders: HeadersInit = {
      accept: "audio/mpeg, application/ogg",
    };
    if (range) upstreamHeaders["range"] = range;
    const res = await fetch(parsed.toString(), {
      method: "GET",
      headers: upstreamHeaders,
      // Don't let Vercel buffer a potentially large stream; we pipe it.
      redirect: "follow",
    });

    if (!res.ok && res.status !== 416) {
      return new Response(`Upstream error ${res.status}`, { status: 502, headers: corsHeaders() });
    }

    const headers = new Headers(corsHeaders());
    const contentType = res.headers.get("content-type") || "audio/mpeg";
    headers.set("content-type", contentType);
    headers.set("accept-ranges", "bytes");

    const contentLength = res.headers.get("content-length");
    const contentRange = res.headers.get("content-range");
    if (contentRange) {
      headers.set("content-range", contentRange);
      // Do NOT fabricate a content-length of "0" when the upstream serves the
      // partial body without a content-length header (chunked transfer): the
      // client would treat the range as empty and audio would fail to play.
      if (contentLength) headers.set("content-length", contentLength);
      return new Response(res.body, { status: 206, headers });
    }
    if (contentLength) headers.set("content-length", contentLength);

    // Range requested but upstream returned the full body (e.g. 416 with full content):
    // serve as 200 with the full stream.
    if (range && (!contentRange || res.status === 416)) {
      return new Response(res.body, { status: 200, headers });
    }

    return new Response(res.body, { status: 200, headers });
  } catch (err) {
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
