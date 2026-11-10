import "server-only";

import { recordApiCall, recordBandwidth, today } from "@/lib/youtube-db";
import ytRedis from "@/lib/yt-redis";

/**
 * Layer 1 — the 10-project YouTube API quota pool.
 *
 * Phonq spreads its YouTube load across `YOUTUBE_API_KEYS` (up to 10 GCP service
 * accounts), each contributing ~10,000 free units/day ⇒ ~100,000 units/day pool.
 * Usage is metered in Redis with 24h TTL counters keyed per project and per
 * operation type (`quota:{projectId}:{opType}:{date}`) so every instance sees the
 * same burn and the router never silently over-spends a suspended project.
 *
 * Allocation:
 *   - Every configured key serves live `search.list` queries (search.list = 100
 *     units). A full 10-key pool therefore budgets ~1,000 live searches/day.
 *     `getAvailableProject` picks the least-loaded key, and a key that YouTube
 *     rejects (403/429) is charged to its limit via `markProjectExhausted` so
 *     the pool rotates around it instead of hammering a broken key.
 *   - Cheap 1-unit ops (videos.list batched ×50, playlistItems.list,
 *     channels.list) draw from the whole pool too — 100 units of search equals
 *     100 cheap ops, so a nightly seeding run can't meaningfully starve search.
 *   - Setting `YOUTUBE_SEARCH_PROJECTS` to N>0 restores the old split: the first
 *     N keys are reserved for live searches, the rest back the cheap ops only.
 *
 * When Redis is down, counters fall back to the in-memory shim in `yt-redis`,
 * and `recordApiCall` still writes to Postgres — so the per-project ledger is
 * recoverable and a Redis outage only loses cross-instance sharing, not quota
 * safety.
 */

export type OpType = "search" | "playback";

/** YouTube API quota cost per operation type (units). */
export const UNIT_COST: Record<OpType, number> = {
  search: 100, // search.list
  playback: 1, // videos.list / playlistItems.list / channels.list (batched)
};

/** Human endpoint name (API path basename) for the monitoring log. */
export function endpointFor(path: string): string {
  return path.split("/").pop() ?? path;
}

export interface Project {
  /** Zero-based index into the configured key list. */
  id: number;
  apiKey: string;
  dailyLimit: number;
}

/** Per-project daily quota (YouTube free tier ≈ 10,000 units/day × 10 projects). */
const DEFAULT_DAILY_LIMIT = 10000;

/**
 * Number of keys reserved for live `search.list` queries (the expensive op).
 * Default 0 reserves none — every configured key contributes to the search
 * budget, so a full 10-key pool yields ~1,000 live searches/day. Set
 * `YOUTUBE_SEARCH_PROJECTS` to N>0 to carve out a dedicated search slice and
 * leave the rest for cheap 1-unit ops only.
 */
export const SEARCH_PROJECT_SLOT = Math.max(0, Number(process.env.YOUTUBE_SEARCH_PROJECTS) || 0);

function readKeys(): string[] {
  const multi = (process.env.YOUTUBE_API_KEYS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length > 0) return multi;
  // Back-compat: a single legacy key.
  const single = process.env.YOUTUBE_API_KEY;
  return single ? [single] : [];
}

function dailyLimit(): number {
  const fromEnv = Number(process.env.YOUTUBE_DAILY_QUOTA_PER_PROJECT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : DEFAULT_DAILY_LIMIT;
}

const globalForPool = globalThis as unknown as { __phonqYtProjects?: Project[] };
function projects(): Project[] {
  if (globalForPool.__phonqYtProjects) return globalForPool.__phonqYtProjects;
  const limit = dailyLimit();
  const list = readKeys().map((apiKey, id) => ({ id, apiKey, dailyLimit: limit }));
  globalForPool.__phonqYtProjects = list;
  return list;
}

/** True when at least one YouTube API key is configured. */
export function hasProjects(): boolean {
  return readKeys().length > 0;
}

export function projectCount(): number {
  return projects().length;
}

/** Number of keys reserved for live searches (used for status reporting). */
export function searchProjectSlot(): number {
  return Math.min(SEARCH_PROJECT_SLOT, Math.max(0, projects().length));
}

/** Projects eligible for live `search.list` — the whole pool by default, or the
 * reserved slice when `YOUTUBE_SEARCH_PROJECTS` is set. */
export function searchProjects(): Project[] {
  const reserved = searchProjectSlot();
  return reserved > 0 ? projects().slice(0, reserved) : projects();
}

export function playbackProjects(): Project[] {
  const rest = projects().slice(searchProjectSlot());
  // When there's no dedicated playback slice (e.g. a single key), fall back to
  // the whole pool so cheap ops still work.
  return rest.length > 0 ? rest : projects();
}

/** Daily search budget in search.list calls (env override ⇒ reserved slice). */
export function dailySearchBudget(): number {
  const env = Number(process.env.YOUTUBE_DAILY_SEARCH_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  const reserved = searchProjects();
  if (reserved.length === 0) return 100;
  const units = reserved.reduce((sum, p) => sum + p.dailyLimit, 0);
  return Math.round(units / UNIT_COST.search);
}

function counterKey(projectId: number, op: OpType): string {
  return `quota:${projectId}:${op}:${today()}`;
}

/** Current units used by a project/op today (Redis counter, 0 if absent). */
export async function usage(projectId: number, op: OpType): Promise<number> {
  return ytRedis.readCounter(counterKey(projectId, op));
}

/**
 * Pick the least-loaded project that still has room for `op`, or null when the
 * pool is exhausted. Reads today's per-project counter, applies a small safety
 * margin so a quota rejection (403/429) never stalls the last slot, and reserves
 * the unit cost immediately. Reserving at selection time is what stops a burst
 * of concurrent requests from all landing on the same key before any of them
 * has reported its usage back — the next reader sees the reservation and picks
 * a different project.
 * `markProjectExhausted` charges a rejected project's headroom so this helper
 * stops selecting it for the rest of the day.
 */
export async function getAvailableProject(op: OpType): Promise<Project | null> {
  const pool = op === "search" ? searchProjects() : playbackProjects();
  if (pool.length === 0) return null;
  const cost = UNIT_COST[op];
  const margin = Math.max(0, Math.floor(pool[0].dailyLimit * 0.02));
  const withUsage = await Promise.all(pool.map(async (p) => ({ p, used: await usage(p.id, op) })));
  const usable = withUsage
    .filter(({ p, used }) => used + cost <= p.dailyLimit - margin)
    .sort((a, b) => a.used - b.used || a.p.id - b.p.id);
  const picked = usable[0]?.p;
  if (!picked) return null;
  // Reserve the units now; `recordUsage` only writes the ledger, so the Redis
  // counter is charged exactly once per selection (conservatively, even if the
  // upstream call later fails — cf. markProjectExhausted for 403/429).
  await ytRedis.incrCounter(counterKey(picked.id, op), cost, 24 * 60 * 60);
  return picked;
}

/**
 * Mark a project as exhausted for `op` for the rest of the day after YouTube
 * answers with a quota/rate rejection (403 or 429). Charges the remaining
 * headroom so `getAvailableProject` stops selecting it and the pool rotates to
 * the next healthy project. Quota-exceeded responses never reach `recordUsage`
 * (usage is only charged on success), so without this the exhausted project
 * keeps winning the "least loaded" race and every call errors all day.
 */
export async function markProjectExhausted(projectId: number, op: OpType): Promise<void> {
  const target = projects()[projectId];
  if (!target) return;
  const used = await usage(projectId, op);
  const remaining = Math.max(0, target.dailyLimit - used);
  if (remaining > 0) {
    await ytRedis.incrCounter(counterKey(projectId, op), remaining, 24 * 60 * 60);
  }
}

/** Ledger-only bookkeeping after an API call. The unit reservation already
 * happened in `getAvailableProject` (so concurrent selections spread across
 * the pool), so this only records the call in Postgres and hands the Redis
 * bandwidth meter to the daily ledger. */
export async function recordUsage(projectId: number, op: OpType, units: number, endpoint: string): Promise<void> {
  await recordApiCall(projectId, endpoint, units);
  // Piggyback: hand the accumulated Redis bandwidth meter to the daily ledger
  // on each API call, so a runaway cache / quota job shows up in the logs
  // before the monthly egress budget is silently spent.
  const usage = ytRedis.flushUsage();
  if (usage.ops > 0) {
    void recordBandwidth(usage);
  }
}

export interface QuotaProjectStat {
  id: number;
  searchUsed: number;
  playbackUsed: number;
  dailyLimit: number;
}

export interface QuotaStatus {
  projects: QuotaProjectStat[];
  /** Aggregate units used across the pool today. */
  unitsUsed: number;
  /** search.list calls charged today. */
  searches: number;
  /** Remaining searches the reserved slice can still perform. */
  searchesRemaining: number;
  /** Total search budget (reserved slice capacity). */
  searchBudget: number;
  /** Whether any keys are configured (and thus the live pool is wired). */
  configured: boolean;
}

export async function getQuotaStatus(): Promise<QuotaStatus> {
  const list = projects();
  const projectsStat: QuotaProjectStat[] = await Promise.all(
    list.map(async (p) => ({
      id: p.id,
      searchUsed: await usage(p.id, "search"),
      playbackUsed: await usage(p.id, "playback"),
      dailyLimit: p.dailyLimit,
    })),
  );

  const reserved = searchProjects();
  const reservedUnits = reserved.reduce((sum, p) => sum + p.dailyLimit, 0);
  const reservedUsed = reserve(list, projectsStat, reserved.length);
  const searchBudget = Math.round(reservedUnits / UNIT_COST.search);
  const searchesRemaining = Math.round(Math.max(0, reservedUnits - reservedUsed) / UNIT_COST.search);

  const searchUnits = sum(projectsStat.map((s) => s.searchUsed));
  const searches = Math.round(searchUnits / UNIT_COST.search);
  const unitsUsed = sum(projectsStat.map((s) => s.searchUsed + s.playbackUsed));

  return {
    projects: projectsStat,
    unitsUsed,
    searches,
    searchesRemaining,
    searchBudget,
    configured: list.length > 0,
  };
}

/** Sum of the first `n` projects' search usage (the reserved slice). */
function reserve(all: Project[], stat: QuotaProjectStat[], n: number): number {
  return sum(stat.slice(0, n).map((s) => s.searchUsed));
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}
