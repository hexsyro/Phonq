import "server-only";

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * Server-side download of a YouTube track.
 *
 * Jamendo tracks link straight to the artist's `downloadUrl`, but YouTube-sourced
 * tracks have no public audio stream — they only play through the IFrame Player
 * API. To let users download those, we shell out to `yt-dlp` (see the Dockerfile,
 * which installs the standalone binary plus ffmpeg) and pipe the extracted audio
 * back through `/api/download/[videoId]`. The route must live on a Node runtime
 * host that can spawn processes.
 *
 * yt-dlp's audio postprocessor is skipped when writing to stdout (`-o -`), so the
 * download lands in a temp dir first, is transcoded to m4a/AAC (`-x --audio-format
 * m4a`), and the resulting file is then streamed to the client. That guarantees a
 * single codec that plays everywhere (Safari, iOS, Android, desktop) regardless of
 * what YouTube served.
 */

export const YTDLP_BINARY = process.env.YTDLP_BINARY ?? "yt-dlp";

export interface DownloadedAudio {
  /** Absolute path to the finished `.m4a` file. */
  path: string;
  /** Remove the temp directory containing `path`. */
  cleanup: () => Promise<void>;
}

/** Spawned with `stdio: ["ignore", "pipe", "pipe"]` → `stdout`/`stderr` are always readable. */
type YtDlpProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Download + transcode a video to m4a in a fresh temp dir. Rejects on yt-dlp
 * failure and always cleans the temp dir on the error path. */
export async function downloadYouTubeAudio(videoId: string, timeoutMs = 90_000): Promise<DownloadedAudio> {
  const dir = await mkdtemp(join(tmpdir(), "phonq-dl-"));
  const outTemplate = join(dir, "audio.%(ext)s");

  try {
    await runYtDlp(
      [
        "-f", "bestaudio/best",
        "-x",
        "--audio-format", "m4a",
        "--audio-quality", "0",
        "--no-playlist",
        "--no-warnings",
        "--no-cache-dir",
        "--no-progress",
        "-o", outTemplate,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      timeoutMs,
    );
    return {
      path: join(dir, "audio.m4a"),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

function runYtDlp(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: YtDlpProcess = spawn(YTDLP_BINARY, args, { stdio: ["ignore", "pipe", "pipe"] } /*turbopackIgnore: true*/);
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        reject(new Error(`Audio extraction timed out after ${Math.round(timeoutMs / 1000)}s`));
        settled = true;
      }
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
      // Keep only a bounded tail so a verbose log can't grow unbounded.
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
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
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Audio extraction failed (yt-dlp exited ${code}): ${stderr.trim().slice(-400)}`));
      }
    });
  });
}
