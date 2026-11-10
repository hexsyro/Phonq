import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

import { badRequest, conflict, created, notFound, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

async function getOwnedPlaylist(id: string, userId: string) {
  return prisma.playlist.findFirst({ where: { id, userId } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  const { id } = await params;
  const playlist = await getOwnedPlaylist(id, session.user.id);
  if (!playlist) return notFound("Playlist not found");

  const body = (await request.json().catch(() => ({}))) as { trackId?: string };
  const trackId = body.trackId;
  if (!trackId) return badRequest("trackId is required");

  const existing = await prisma.playlistTrack.findUnique({
    where: { playlistId_trackId: { playlistId: id, trackId } },
  });
  if (existing) return conflict("Track is already in this playlist");

  // Compute the next position and insert atomically. Under SERIALIZABLE
  // isolation Postgres aborts one of two concurrent transactions with a
  // serialization failure (P2034) — retry the whole thing a few times so a
  // concurrent add to the same playlist can't duplicate positions.
  const MAX_RETRIES = 3;
  let entry;
  for (let attempt = 1; ; attempt += 1) {
    try {
      entry = await prisma.$transaction(
        async (tx) => {
          const nextPosition =
            (await tx.playlistTrack.aggregate({
              where: { playlistId: id },
              _max: { position: true },
            }))._max.position ?? -1;

          return tx.playlistTrack.create({
            data: { playlistId: id, trackId, position: nextPosition + 1 },
          });
        },
        { isolationLevel: "Serializable" },
      );
      break;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "P2034" && attempt < MAX_RETRIES) continue;
      throw err;
    }
  }

  await prisma.playlist.update({
    where: { id },
    data: { updatedAt: new Date() },
  });

  return created({ entry });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  const { id } = await params;
  const playlist = await getOwnedPlaylist(id, session.user.id);
  if (!playlist) return notFound("Playlist not found");

  const body = (await request.json().catch(() => ({}))) as { trackId?: string };
  const url = new URL(request.url);
  const trackId = body.trackId ?? url.searchParams.get("trackId");
  if (!trackId) return badRequest("trackId is required");

  await prisma.playlistTrack.deleteMany({
    where: { playlistId: id, trackId },
  });

  await prisma.playlist.update({
    where: { id },
    data: { updatedAt: new Date() },
  });

  return ok({ removed: true });
}
