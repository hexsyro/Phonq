import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

import { touchLastPlayed, upsertSong } from "@/lib/youtube-db";

import { badRequest, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Minimal YouTube metadata sent by the player on playback. */
interface YoutubePlaybackMeta {
  videoId?: string;
  title?: string;
  artist?: string;
  durationSec?: number;
  channelId?: string | null;
  channelTitle?: string | null;
}

/**
 * Reports that the signed-in user listened to a track.
 * The player calls this once per track (deduped client-side by track id).
 * We store one row per (user, track), updating progress and timestamps.
 *
 * For YouTube tracks the video is upserted into the `songs` catalog on
 * playback (best-effort, fire-and-forget) and its `lastPlayedAt` touched, so a
 * played video survives pruning and always resolves on read-back even when it
 * only ever existed in the Redis hot cache.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as {
    trackId?: string;
    progress?: number;
    completed?: boolean;
    youtube?: YoutubePlaybackMeta;
  };
  if (!body.trackId) return badRequest("trackId is required");

  const progress = Math.max(0, Math.min(1, Number(body.progress) || 0));
  const completed = Boolean(body.completed);

  const existing = await prisma.listen.findFirst({
    where: { userId: session.user.id, trackId: body.trackId },
  });

  if (existing) {
    await prisma.listen.update({
      where: { id: existing.id },
      data: {
        progress: Math.max(existing.progress, progress),
        completed: existing.completed || completed,
        listenedAt: new Date(),
      },
    });
  } else {
    try {
      await prisma.listen.create({
        data: { userId: session.user.id, trackId: body.trackId, progress, completed },
      });
    } catch (err) {
      // Two concurrent plays for the same (user, track) raced past findFirst.
      // The loser of the unique(userId, trackId) constraint retries as an
      // update instead of turning the user's listen into a 500.
      const code = (err as { code?: string } | null)?.code;
      if (code !== "P2002") throw err;
      const winner = await prisma.listen.findFirst({
        where: { userId: session.user.id, trackId: body.trackId },
      });
      if (winner) {
        await prisma.listen.update({
          where: { id: winner.id },
          data: {
            progress: Math.max(winner.progress, progress),
            completed: winner.completed || completed,
            listenedAt: new Date(),
          },
        });
      }
    }
  }

  // Keep played YouTube videos resolvable (see the comment above).
  const yt = body.trackId.startsWith("yt:") ? body.youtube : undefined;
  if (yt?.videoId) {
    void upsertSong({
      videoId: yt.videoId,
      title: yt.title ?? `Phonq track ${yt.videoId}`,
      artist: yt.artist ?? "Unknown Artist",
      channelId: yt.channelId ?? null,
      channelTitle: yt.channelTitle ?? yt.artist ?? null,
      durationSec: Math.max(0, Math.round(Number(yt.durationSec) || 0)),
      genreTag: null,
      qualityScore: 30,
      embedStatus: true,
      source: "search",
      lastPlayedAt: new Date(),
    }).catch(() => undefined);
    void touchLastPlayed(yt.videoId).catch(() => undefined);
  }

  return ok({ recorded: true });
}
