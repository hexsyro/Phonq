import "server-only";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { checkRateLimit, ipKey } from "@/lib/rate-limit";
import { findSongByVideoId } from "@/lib/youtube-db";
import { downloadYouTubeAudio } from "@/lib/ytdlp";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Keep user-supplied titles safe for a `Content-Disposition` filename. */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} _\-().]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "phonq-track";
}

/** `filename` is ASCII-only for legacy parsers; `filename*` carries the real
 * (possibly accented) title per RFC 6266. */
function dispositionFor(title: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "")
    .trim();
  const fallback = (ascii || "phonq-track") + ".m4a";
  const utf8 = encodeURIComponent(`${title}.m4a`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${utf8}`;
}

/**
 * GET /api/download/:videoId?title=…  →  streaming m4a download of a YouTube track.
 *
 * YouTube-sourced tracks have no direct audio URL, so this extracts the audio
 * with yt-dlp on the server and streams it back as an attachment. Only videos
 * already in the catalog are served (so the host can't be used as an open
 * yt-dlp proxy), and downloads are rate-limited per IP.
 */
export async function GET(request: Request, { params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return Response.json({ error: "Invalid video id" }, { status: 400 });
  }

  if (!(await checkRateLimit(`download:${ipKey(request)}`, 6, 60_000))) {
    return Response.json({ error: "Too many downloads, slow down" }, { status: 429 });
  }

  const song = await findSongByVideoId(videoId);
  if (!song) {
    return Response.json({ error: "Track not found" }, { status: 404 });
  }

  let audio;
  try {
    audio = await downloadYouTubeAudio(videoId);
  } catch (err) {
    console.error(`[download] ${videoId}: ${err instanceof Error ? err.message : err}`);
    return Response.json({ error: "Could not extract audio" }, { status: 502 });
  }

  const info = await stat(audio.path).catch(() => null);
  if (!info) {
    await audio.cleanup();
    return Response.json({ error: "Could not extract audio" }, { status: 502 });
  }

  const url = new URL(request.url);
  const title = sanitizeFilename(url.searchParams.get("title") ?? "phonq-track");
  const fileStream = createReadStream(audio.path);

  const cleanup = () => audio.cleanup().catch(() => {});
  fileStream.on("end", cleanup);
  fileStream.on("error", cleanup);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      fileStream.on("end", () => controller.close());
      fileStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      // Client disconnected mid-download — destroy the read stream and remove
      // the temp dir, otherwise partial downloads accumulate on disk forever.
      fileStream.destroy();
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "audio/mp4",
      "Content-Length": String(info.size),
      "Content-Disposition": dispositionFor(title),
      "Cache-Control": "no-store",
    },
  });
}
