import "server-only";

import { Redis } from "@upstash/redis";

/**
 * Layer 2 — the YouTube catalog Redis accelerator.
 *
 * Redis is an *accelerator*, never a source of truth. With a 200 MB budget
 * (`maxmemory 200mb`, `allkeys-lru`) it holds more than a thin hot slice:
 *
 *   - `search:{normalized_query}`  → video_id            TTL 24h (env-overridable)
 *   - `song:{video_id}`            → small JSON           TTL 12h — read-through
 *     (title/artist/duration/thumbnail) in front of Postgres
 *   - `neg:{normalized_query}`     → "1"                  TTL 2h (negative cache)
 *   - `quota:{project}:{op}:{date}`→ counter              TTL 24h
 *   - `ratelimit:{bucket}:{key}`   → counter              TTL 1h (API rate limiter)
 *
 * When Redis is unreachable the app falls through to Postgres (the dedicated
 * `songs` store) transparently — "Redis unreachable → falls through to Postgres"
 * is a hard requirement of the design. A lightweight in-process meter estimates
 * bytes read/written so the monthly bandwidth budget is logged (see
 * `redis_usage_log` in youtube-db.ts) instead of being a surprise bill.
 *
 * Provider (first match wins):
 *   1. Upstash REST: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
 *   2. In-memory Map shard (single-process dev/test). No TCP support here —
 *      `@upstash/redis` speaks HTTP only. For a local docker redis, front it
 *      with a REST proxy or just let the in-memory shim carry dev.
 *
 * Every method swallows errors and returns a safe default so catalog callers
 * can ignore the failure mode entirely.
 */

interface RedisLike {
  /** Raw string value (no JSON). null when missing/expired. */
  getString(key: string): Promise<string | null>;
  /** Returns "OK" on success, null when NX rejected. */
  setString(key: string, value: string, opts?: SetOptions): Promise<string | null>;
  incr(key: string): Promise<number>;
  incrby(key: string, amount: number): Promise<number>;
  del(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  exists(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  ping(): Promise<string>;
  /** Number of keys currently stored (DBSIZE). */
  dbSize(): Promise<number>;
}

interface SetOptions {
  ex?: number;
  nx?: boolean;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

const upstashUrl = env("UPSTASH_REDIS_REST_URL");
const upstashToken = env("UPSTASH_REDIS_REST_TOKEN");

/** Upstash REST client (http/https, serverless-friendly, no persistent socket). */
class UpstashRedis implements RedisLike {
  private client: Redis;
  constructor() {
    this.client = new Redis({ url: upstashUrl!, token: upstashToken! });
  }
  getString(key: string) {
    return this.client.get<string>(key);
  }
  setString(key: string, value: string, opts?: SetOptions) {
    if (opts?.ex != null) {
      return opts.nx
        ? this.client.set(key, value, { ex: opts.ex, nx: true })
        : this.client.set(key, value, { ex: opts.ex });
    }
    return this.client.set(key, value);
  }
  incr(key: string) {
    return this.client.incr(key);
  }
  incrby(key: string, amount: number) {
    return this.client.incrby(key, amount);
  }
  del(key: string) {
    return this.client.del(key);
  }
  expire(key: string, seconds: number) {
    return this.client.expire(key, seconds);
  }
  ttl(key: string) {
    return this.client.ttl(key);
  }
  exists(key: string) {
    return this.client.exists(key);
  }
  ping() {
    return this.client.ping();
  }
  dbSize() {
    return this.client.dbsize();
  }
}

/** In-process fallback so the app boots without an external Redis. */
class MemoryRedis implements RedisLike {
  private store = new Map<string, { value: string; expiresAt: number }>();
  private now() {
    return Date.now();
  }
  private alive(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async getString(key: string): Promise<string | null> {
    return this.alive(key) ? this.store.get(key)!.value : null;
  }

  async setString(key: string, value: string, opts?: SetOptions): Promise<string | null> {
    if (opts?.nx && this.alive(key)) return null;
    const expiresAt = opts?.ex ? this.now() + opts.ex * 1000 : Infinity;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async incr(key: string): Promise<number> {
    // Expired entries must not carry forward — otherwise a stale quota bucket
    // for yesterday keeps accumulating forever in the shim.
    const alive = this.alive(key);
    const cur = alive ? Number(this.store.get(key)!.value) || 0 : 0;
    const next = cur + 1;
    const expiresAt = alive ? this.store.get(key)!.expiresAt : Infinity;
    this.store.set(key, { value: String(next), expiresAt });
    return next;
  }

  async incrby(key: string, amount: number): Promise<number> {
    const alive = this.alive(key);
    const cur = alive ? Number(this.store.get(key)!.value) || 0 : 0;
    const next = cur + amount;
    const expiresAt = alive ? this.store.get(key)!.expiresAt : Infinity;
    this.store.set(key, { value: String(next), expiresAt });
    return next;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.alive(key)) return 0;
    const entry = this.store.get(key)!;
    entry.expiresAt = this.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    if (!this.alive(key)) return -2;
    const entry = this.store.get(key)!;
    return entry.expiresAt === Infinity ? -1 : Math.ceil((entry.expiresAt - this.now()) / 1000);
  }

  async exists(key: string): Promise<number> {
    return this.alive(key) ? 1 : 0;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async dbSize(): Promise<number> {
    return this.store.size;
  }
}

/** Re-probe Upstash at most every 30s while the backing Redis is offline, so
 * the app recovers automatically instead of sticking to the shim forever. */
const REPROBE_INTERVAL_MS = 30_000;

/** Best-effort Redis facade. Never throws; serves from the in-memory shim
 * while the configured Redis is down (quota counters and caches keep working
 * instead of silently reading 0 / returning null), and recovers when Redis is
 * back. Returns safe defaults when both fail. */
export class YtRedis {
  /** True only when a real (networked) Upstash REST endpoint is configured. */
  readonly configured: boolean = Boolean(upstashUrl && upstashToken);
  private online = true;
  private inner: RedisLike;
  /** In-process fallback used while the configured Redis is unreachable. */
  private memory: RedisLike = new MemoryRedis();
  private lastProbe = 0;

  /** In-process bandwidth meter — approximate payload bytes moved per op so the
   * monthly budget (Upstash 10 GB egress, roughly) is visible before the
   * provider starts throttling. Estimates key + value bytes; a `flushUsage()`
   * hands the running total to the `redis_usage_log` daily ledger and resets. */
  private stats: RedisUsage = { ops: 0, readBytes: 0, writeBytes: 0, hits: 0, misses: 0 };

  constructor() {
    this.inner = this.configured ? new UpstashRedis() : new MemoryRedis();
  }

  /** True when the backing Redis is reachable (flips false on the first failed
   * call, back true via `healthy()`). Consumers (e.g. the rate limiter) use this
   * to switch to their in-memory fallback instead of degrading open. */
  isOnline(): boolean {
    return this.online;
  }

  /** Approximate bytes read/written + cache hit/miss counts since the last
   * `flushUsage()`. */
  usage(): RedisUsage {
    return { ...this.stats };
  }

  /** Return the accumulated bandwidth stats and reset the in-process meter. */
  flushUsage(): RedisUsage {
    const snapshot = { ...this.stats };
    this.stats = { ops: 0, readBytes: 0, writeBytes: 0, hits: 0, misses: 0 };
    return snapshot;
  }

  /** Number of keys stored in Redis (DBSIZE) — 0 when down or unconfigured. */
  async dbSize(): Promise<number> {
    return this.safe((r) => r.dbSize(), 0);
  }

  private async safe<T>(op: (inner: RedisLike) => Promise<T>, fallback: T): Promise<T> {
    if (this.configured && !this.online) {
      // Redis is down — re-probe at most once every REPROBE_INTERVAL_MS, then
      // either flip back online or serve from the in-process shim. The shim
      // keeps quota counters and the cache path working instead of silently
      // degrading to 0/null (as documented in youtube-pool.ts).
      if (Date.now() - this.lastProbe >= REPROBE_INTERVAL_MS) {
        this.lastProbe = Date.now();
        try {
          await this.inner.ping();
          this.online = true;
        } catch {
          return this.memoryRun(op, fallback);
        }
      } else {
        return this.memoryRun(op, fallback);
      }
    }
    try {
      return await op(this.inner);
    } catch (err) {
      this.online = false;
      this.lastProbe = Date.now();
      if (upstashUrl) {
        console.warn(`[yt-redis] ${err instanceof Error ? err.message : String(err)}`);
      }
      return this.memoryRun(op, fallback);
    }
  }

  /** Run the same operation against the in-process shim; on failure, degrade to
   * the provided fallback. */
  private async memoryRun<T>(op: (inner: RedisLike) => Promise<T>, fallback: T): Promise<T> {
    try {
      return await op(this.memory);
    } catch {
      return fallback;
    }
  }

  /** Health probe — true when the backing Redis answered. */
  async healthy(): Promise<boolean> {
    try {
      await this.inner.ping();
      this.online = true;
      return true;
    } catch {
      this.online = false;
      return false;
    }
  }

  /* ---- JSON caches: hot lookups + negative cache + song read-through ---- */

  async cacheGet<T = unknown>(key: string): Promise<T | null> {
    return this.safe(async (r) => {
      const raw = await r.getString(key);
      this.stats.ops += 1;
      if (raw === null) {
        this.stats.misses += 1;
        this.stats.readBytes += key.length;
        return null;
      }
      this.stats.hits += 1;
      this.stats.readBytes += key.length + raw.length;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    }, null);
  }

  async cacheSet<T>(key: string, value: T, ttlSec?: number): Promise<void> {
    await this.safe(async (r) => {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      this.stats.ops += 1;
      this.stats.writeBytes += key.length + raw.length;
      await r.setString(key, raw, ttlSec ? { ex: ttlSec } : undefined);
    }, undefined);
  }

  async cacheDel(key: string): Promise<void> {
    await this.safe(async (r) => {
      this.stats.ops += 1;
      this.stats.writeBytes += key.length;
      await r.del(key);
    }, undefined);
  }

  /* ---- Numeric counters: per-project quota budget + rate limiting ---- */

  async readCounter(key: string): Promise<number> {
    return this.safe(async (r) => {
      const raw = await r.getString(key);
      this.stats.ops += 1;
      this.stats.readBytes += key.length + (raw?.length ?? 0);
      if (raw === null) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }, 0);
  }

  /**
   * INCRby with a TTL applied only on first creation (SET NX + EX), then
   * INCRBY. The date-suffixed key pattern (`quota:{project}:{op}:{YYYY-MM-DD}`)
   * gives natural midnight rollover; the 24h TTL is just a cleanup guard.
   */
  async incrCounter(key: string, amount: number, ttlSec: number): Promise<number> {
    return this.safe(async (r) => {
      this.stats.ops += 1;
      this.stats.writeBytes += key.length + String(amount).length;
      const created = await r.setString(key, String(amount), { ex: ttlSec, nx: true });
      if (created === "OK") return amount;
      const next = await r.incrby(key, amount);
      // Renew a TTL if one was lost (e.g. after a restart of an ephemeral store).
      await r.expire(key, ttlSec);
      return next;
    }, amount);
  }
}

/** Approximate Redis usage since the last flush. */
export interface RedisUsage {
  /** Redis operations performed. */
  ops: number;
  /** Approximate bytes read (keys + values) from Redis. */
  readBytes: number;
  /** Approximate bytes written (keys + values) to Redis. */
  writeBytes: number;
  /** Cache GETs that hit. */
  hits: number;
  /** Cache GETs that missed. */
  misses: number;
}

const globalForRedis = globalThis as unknown as { __phonqYtRedis?: YtRedis };
export const ytRedis: YtRedis = globalForRedis.__phonqYtRedis ?? new YtRedis();
if (process.env.NODE_ENV !== "production") {
  globalForRedis.__phonqYtRedis = ytRedis;
}

export default ytRedis;
