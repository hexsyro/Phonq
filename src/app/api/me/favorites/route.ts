import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

import { fetchTracksByIds } from "@/lib/catalog";

import { badRequest, created, notFound, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  const favorites = await prisma.favorite.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    select: { trackId: true, createdAt: true },
  });

  const tracks = await fetchTracksByIds(favorites.map((f) => f.trackId));

  return ok({
    favorites: favorites.map((f) => ({
      trackId: f.trackId,
      createdAt: f.createdAt,
      track: tracks.find((t) => t.id === f.trackId) ?? null,
    })),
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  const body = (await request.json().catch(() => ({}))) as { trackId?: string };
  if (!body.trackId) return badRequest("trackId is required");

  const existing = await prisma.favorite.findUnique({
    where: { userId_trackId: { userId: session.user.id, trackId: body.trackId } },
  });
  if (existing) return created({ favorite: existing });

  try {
    const favorite = await prisma.favorite.create({
      data: { userId: session.user.id, trackId: body.trackId },
    });
    return created({ favorite });
  } catch (err) {
    // Two concurrent likes for the same track raced past findUnique —
    // return the winner's row instead of a 500 on the unique constraint.
    const code = (err as { code?: string } | null)?.code;
    if (code !== "P2002") throw err;
    const favorite = await prisma.favorite.findUnique({
      where: { userId_trackId: { userId: session.user.id, trackId: body.trackId } },
    });
    return created({ favorite });
  }
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  const url = new URL(request.url);
  const body = (await request.json().catch(() => ({}))) as { trackId?: string };
  const trackId = body.trackId ?? url.searchParams.get("trackId");
  if (!trackId) return badRequest("trackId is required");

  await prisma.favorite.deleteMany({
    where: { userId: session.user.id, trackId },
  });
  return ok({ removed: true });
}
