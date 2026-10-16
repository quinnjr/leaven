/**
 * @leaven-graphql/core - Redis document cache
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { GraphQLError } from 'graphql';
import type { DocumentNode } from 'graphql';
import type { IDocumentCache, CachedValidation, CacheStats } from './cache-interface';
import { sha256Hex } from './cache';

/**
 * Redis client interface (compatible with ioredis and node-redis)
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  exists(key: string | string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  incr(key: string): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  dbsize?(): Promise<number>;
  flushdb?(): Promise<string>;
  /**
   * Optional cursor-based key iteration (SCAN). When available, `clear()`
   * uses it instead of the blocking `KEYS` command. Both the ioredis tuple
   * return shape (`[cursor, keys]`) and the node-redis object shape
   * (`{ cursor, keys }`) are supported.
   */
  scan?(
    cursor: string | number,
    ...args: unknown[]
  ): Promise<[string | number, string[]] | { cursor: string | number; keys: string[] }>;
  /**
   * Optional atomic conditional write — `SET key value NX [EX ttl]`.
   *
   * When present, it is used so that insert detection is atomic with the
   * write: two concurrent `set()` calls for the same NEW key see exactly one
   * insert, and the size counter is incremented once. Implementations MUST
   * resolve to a nil-ish value (`null`/`undefined`/`false`) when the key
   * already existed, and to a truthy reply (`'OK'`) when it was created.
   * `ttlSeconds` of `0` means "no expiry".
   *
   * Clients without it fall back to a non-atomic EXISTS-then-SET, which can
   * over-count `getStats().size` when identical queries race.
   *
   * ioredis: `(k, v, ttl) => ttl > 0 ? client.set(k, v, 'EX', ttl, 'NX') : client.set(k, v, 'NX')`
   * node-redis: `(k, v, ttl) => client.set(k, v, ttl > 0 ? { EX: ttl, NX: true } : { NX: true })`
   */
  setNx?(key: string, value: string, ttlSeconds: number): Promise<unknown>;
}

/**
 * Hard cap on SCAN round trips during `clear()`. A server (or a misbehaving
 * client shim) that never returns the terminating cursor would otherwise
 * loop forever.
 */
const MAX_SCAN_ITERATIONS = 10_000;

/**
 * Normalize a SCAN reply from either supported client shape, rejecting
 * anything else with a diagnosable error rather than a bare TypeError from
 * a failed destructure.
 */
function normalizeScanReply(result: unknown): { cursor: string | number; keys: string[] } {
  if (Array.isArray(result)) {
    // ioredis: [cursor, keys]
    const [cursor, keys] = result as [unknown, unknown];
    if ((typeof cursor === 'string' || typeof cursor === 'number') && Array.isArray(keys)) {
      return { cursor, keys: keys as string[] };
    }
  } else if (result !== null && typeof result === 'object') {
    // node-redis: { cursor, keys }
    const { cursor, keys } = result as { cursor?: unknown; keys?: unknown };
    if ((typeof cursor === 'string' || typeof cursor === 'number') && Array.isArray(keys)) {
      return { cursor, keys: keys as string[] };
    }
  }

  throw new Error(
    'Redis client returned an unrecognised SCAN reply; expected [cursor, keys] or { cursor, keys }'
  );
}

/**
 * Configuration for Redis document cache
 */
export interface RedisCacheConfig {
  /** Redis client instance */
  client: RedisClient;
  /**
   * Key prefix for all cache entries (default: 'leaven:doc:').
   *
   * The prefix is the cache's namespace, including for the size/hits
   * counters and for `clear()`. Give each logically distinct cache its own
   * prefix — deployments that share one Redis between services should not
   * share a prefix, or `clear()` in one wipes the other.
   */
  prefix?: string;
  /** TTL for cache entries in seconds (default: 3600 = 1 hour) */
  ttl?: number;
  /**
   * Advisory maximum number of entries (default: 10000, 0 = unlimited).
   *
   * NOTE: This value is advisory only — Leaven performs NO eviction when it
   * is exceeded; it is merely reported back via `getStats().maxSize`. To
   * actually bound the cache, configure Redis itself with `maxmemory` and an
   * appropriate `maxmemory-policy` (e.g. `allkeys-lru`), or rely on entry
   * TTLs.
   */
  maxSize?: number;
  /**
   * Track cache hits in a shared counter (default: true).
   *
   * Every hit fires an extra `INCR` against a single key. The write is
   * fire-and-forget so it adds no latency to the request, but it doubles the
   * command volume of the read path and makes that one key a hotspot for
   * every instance sharing the prefix. Set to `false` on a hot deployment;
   * `getStats()` then reports `totalHits: 0` and `hitRate: 0`.
   */
  trackHits?: boolean;
  /** Enable compression for large documents (default: false) */
  compress?: boolean;
  /** Compression threshold in bytes (default: 1024) */
  compressionThreshold?: number;
  /**
   * Called when a background cache operation fails, with the key involved.
   *
   * Covers two classes of failure:
   * - A stored entry cannot be deserialized (corrupt JSON, failed
   *   decompression, invalid base64). The unreadable key is deleted so it
   *   cannot fail repeatedly and the lookup is treated as a cache miss.
   * - A fire-and-forget stats counter write fails, or a counter holds an
   *   unparseable value. These never fail a request, but they silently skew
   *   `getStats()` — a read-only or OOM Redis still answers GET, so requests
   *   look healthy while `getStats()` reports a cold, empty cache that is in
   *   fact full and serving.
   *
   * Defaults to silent (errors are dropped).
   */
  onError?: (error: unknown, key: string) => void;
  /**
   * Hash used to derive an entry's Redis key from its query
   * (default: SHA-256, hex).
   *
   * Each entry also stores its full query, and a read only hits when it
   * matches, so even a colliding hash can never serve one query's document or
   * validation verdict for another; a collision is just a miss.
   */
  hashKey?: (query: string) => string;
}

/**
 * Serialized form of a validation error
 */
interface SerializedError {
  message: string;
  locations?: readonly { line: number; column: number }[];
  path?: readonly (string | number)[];
  positions?: readonly number[];
  extensions?: Record<string, unknown>;
}

/**
 * Serialized cache entry for Redis storage
 */
interface SerializedEntry {
  /** Serialized document (JSON string) */
  d: string;
  /** Validation result */
  v?: {
    valid: boolean;
    errors: SerializedError[];
  };
  /** The full query string the entry was stored for */
  q?: string;
  /** Created timestamp */
  c: number;
  /** Compressed flag */
  z?: boolean;
}

/**
 * Redis-backed document cache for distributed GraphQL deployments
 */
export class RedisDocumentCache implements IDocumentCache {
  private readonly client: RedisClient;
  private readonly prefix: string;
  private readonly ttl: number;
  private readonly maxSize: number;
  private readonly trackHits: boolean;
  private readonly compress: boolean;
  private readonly compressionThreshold: number;
  private readonly sizeKey: string;
  private readonly hitsKey: string;
  private readonly onError?: (error: unknown, key: string) => void;
  private readonly hashKey: (query: string) => string;

  constructor(config: RedisCacheConfig) {
    this.client = config.client;
    this.prefix = config.prefix ?? 'leaven:doc:';
    this.ttl = config.ttl ?? 3600;
    this.maxSize = config.maxSize ?? 10000;
    this.trackHits = config.trackHits ?? true;
    this.compress = config.compress ?? false;
    this.compressionThreshold = config.compressionThreshold ?? 1024;
    const statsKey = `${this.prefix}__stats__`;
    this.sizeKey = `${statsKey}:size`;
    this.hitsKey = `${statsKey}:hits`;
    this.onError = config.onError;
    this.hashKey = config.hashKey ?? sha256Hex;
  }

  /**
   * Generate a cache key for a query string
   */
  private generateKey(query: string): string {
    return `${this.prefix}${this.hashKey(query)}`;
  }

  /**
   * Serialize a document for Redis storage
   */
  private serialize(query: string, document: DocumentNode, validation?: CachedValidation): string {
    const entry: SerializedEntry = {
      d: JSON.stringify(document),
      q: query,
      c: Date.now(),
    };

    if (validation) {
      entry.v = {
        valid: validation.valid,
        errors: validation.errors.map((e) => ({
          message: e.message,
          locations: e.locations,
          path: e.path,
          positions: e.positions,
          extensions: e.extensions as Record<string, unknown> | undefined,
        })),
      };
    }

    const serialized = JSON.stringify(entry);

    // Compress if enabled and above threshold
    if (this.compress && serialized.length > this.compressionThreshold) {
      const compressed = Bun.gzipSync(serialized);
      return JSON.stringify({ z: true, d: Buffer.from(compressed).toString('base64') });
    }

    return serialized;
  }

  /**
   * Rebuild a real GraphQLError instance from its serialized form so that
   * cached validation errors are `instanceof GraphQLError` and keep their
   * `extensions` (e.g. `extensions.code`) through a cache round trip.
   */
  private reviveError(e: SerializedError): GraphQLError {
    const error = new GraphQLError(e.message, {
      positions: e.positions,
      path: e.path,
      extensions: e.extensions,
    });

    // `locations` can only be derived from nodes or source + positions,
    // neither of which survives serialization — restore the recorded
    // locations directly so formatted output matches the original error.
    if (e.locations && error.locations === undefined) {
      Object.defineProperty(error, 'locations', { value: e.locations });
    }

    return error;
  }

  /**
   * Deserialize a document from Redis storage.
   *
   * Returns null when the stored entry is unreadable (corrupt JSON, failed
   * decompression, invalid base64), so callers observe a normal cache miss.
   * The unreadable key is deleted so it cannot fail again on every request,
   * and the error is reported through the optional `onError` config hook
   * (silent by default).
   */
  private deserialize(
    data: string,
    key: string,
    query: string
  ): { document: DocumentNode; validation?: CachedValidation } | null {
    try {
      const parsed = JSON.parse(data);

      // Handle compressed data
      if (parsed.z) {
        const buffer = Buffer.from(parsed.d, 'base64');
        const decompressed = Bun.gunzipSync(new Uint8Array(buffer));
        return this.deserialize(new TextDecoder().decode(decompressed), key, query);
      }

      const entry = parsed as SerializedEntry;
      // The slot holds a different query (a key collision) or an entry
      // written before queries were recorded: a plain miss, never a hit on
      // someone else's document.
      if (entry.q !== query) {
        return null;
      }
      const document = JSON.parse(entry.d) as DocumentNode;

      let validation: CachedValidation | undefined;
      if (entry.v) {
        validation = {
          valid: entry.v.valid,
          errors: entry.v.errors.map((e) => this.reviveError(e)),
        };
      }

      return { document, validation };
    } catch (error) {
      // Evict the poisoned entry (fire-and-forget) so it cannot re-fail on
      // every request, keeping the authoritative size counter in sync.
      this.track(
        this.client
          .del(key)
          .then((deleted) => (deleted > 0 ? this.client.incrby(this.sizeKey, -1) : undefined)),
        key
      );
      this.onError?.(error, key);
      return null;
    }
  }

  /**
   * Attach the configured error hook to a fire-and-forget background write.
   *
   * These writes must never add latency or fail a request, but they must not
   * fail SILENTLY either: see `RedisCacheConfig.onError`.
   */
  private track(operation: Promise<unknown>, key: string): void {
    void operation.catch((error) => this.onError?.(error, key));
  }

  /**
   * Read a stats counter, reporting an unparseable value through `onError`
   * instead of silently reading as 0.
   */
  private readCounter(value: string | null, key: string): number {
    if (value === null || value === '') return 0;

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      this.onError?.(
        new Error(`Cache counter "${key}" holds a non-numeric value: ${JSON.stringify(value)}`),
        key
      );
      return 0;
    }

    return parsed;
  }

  /**
   * Record a cache hit, unless hit tracking is disabled.
   * Fire-and-forget so stats tracking never adds latency to the hit path.
   */
  private recordHit(): void {
    if (!this.trackHits) return;
    this.track(this.client.incr(this.hitsKey), this.hitsKey);
  }

  /**
   * Unconditionally write a value with the given expiry (`0` = no expiry).
   */
  private async writeValue(
    key: string,
    serialized: string,
    ttlSeconds: number
  ): Promise<void> {
    if (ttlSeconds > 0) {
      await this.client.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, serialized);
    }
  }

  /**
   * Write a serialized entry and keep the authoritative size counter in
   * sync, incrementing it only for genuine inserts (not overwrites).
   *
   * When the client exposes `setNx`, insert detection is ATOMIC with the
   * write: the NX reply itself says whether the key was created, so two
   * concurrent writers racing on the same new key increment the counter
   * exactly once. Clients without it fall back to dispatching EXISTS before
   * the SET on the same connection — correct for a single call, but two
   * concurrent inserts of the same key both observe 0 and both increment,
   * drifting the reported size upward with no reconciliation path.
   *
   * The counter update is fire-and-forget so it never adds latency; failures
   * surface through `RedisCacheConfig.onError`.
   *
   * Note: Leaven performs NO eviction when `maxSize` is exceeded — the
   * counter below exists purely for stats/size reporting. Bounding the
   * keyspace must be done via Redis's own `maxmemory-policy` (see
   * `RedisCacheConfig.maxSize`).
   *
   * `ttlSeconds` defaults to the configured TTL; `setValidation` overrides it
   * with the entry's remaining lifetime so refreshing a verdict does not
   * extend the entry.
   */
  private async writeEntry(
    key: string,
    serialized: string,
    ttlSeconds: number = this.ttl
  ): Promise<void> {
    const setNx = this.client.setNx?.bind(this.client);

    if (setNx) {
      const reply = await setNx(key, serialized, ttlSeconds);
      const inserted = reply !== null && reply !== undefined && reply !== false;

      if (inserted) {
        this.track(this.client.incr(this.sizeKey), this.sizeKey);
        return;
      }

      // The key already existed, so this is an overwrite: write the new value
      // unconditionally and leave the counter alone.
      await this.writeValue(key, serialized, ttlSeconds);
      return;
    }

    // The rejection handler is attached HERE, at creation, not after the
    // awaited write below: if `writeValue` throws first, nothing would ever
    // chain onto this promise and an EXISTS failure would surface as an
    // unhandled rejection. A failed lookup reports `null`, which is neither
    // "existed" nor "inserted", so the counter is left alone.
    const existed = this.client.exists(key).catch((error): number | null => {
      this.onError?.(error, this.sizeKey);
      return null;
    });

    await this.writeValue(key, serialized, ttlSeconds);

    this.track(
      existed.then((count) => (count === 0 ? this.client.incr(this.sizeKey) : undefined)),
      this.sizeKey
    );
  }

  /**
   * Get a document from the cache.
   * Returns null on a miss or when the stored entry is unreadable (see
   * `RedisCacheConfig.onError`).
   */
  public async get(query: string): Promise<DocumentNode | null> {
    const key = this.generateKey(query);
    const data = await this.client.get(key);

    if (!data) {
      return null;
    }

    const result = this.deserialize(data, key, query);
    if (result) {
      this.recordHit();
      return result.document;
    }

    return null;
  }

  /**
   * Set a document in the cache
   */
  public async set(query: string, document: DocumentNode): Promise<void> {
    const key = this.generateKey(query);
    await this.writeEntry(key, this.serialize(query, document));
  }

  /**
   * Get a document with its validation result from the cache.
   * Returns null on a miss or when the stored entry is unreadable (see
   * `RedisCacheConfig.onError`).
   */
  public async getWithValidation(
    query: string
  ): Promise<{ document: DocumentNode; validation?: CachedValidation } | null> {
    const key = this.generateKey(query);
    const data = await this.client.get(key);

    if (!data) {
      return null;
    }

    const result = this.deserialize(data, key, query);
    if (result) {
      this.recordHit();
      return result;
    }

    return null;
  }

  /**
   * Set validation result for a cached document.
   *
   * Prefer {@link RedisDocumentCache.setWithValidation} when the document is
   * already in hand: this method re-reads and re-serializes it.
   */
  public async setValidation(query: string, validation: CachedValidation): Promise<void> {
    const key = this.generateKey(query);
    // Fetch the entry and its remaining TTL concurrently (one awaited round
    // trip instead of two sequential ones)
    const [data, currentTtl] = await Promise.all([this.client.get(key), this.client.ttl(key)]);

    if (!data) {
      return;
    }

    const result = this.deserialize(data, key, query);
    if (result) {
      const serialized = this.serialize(query, result.document, validation);

      // Preserve the entry's remaining lifetime so refreshing a verdict does
      // not extend it. A non-positive TTL means the key carries no expiry, or
      // expired between the GET and the TTL above; falling back to the
      // configured TTL keeps this from writing an immortal key into a cache
      // whose whole eviction story is expiry.
      const ttlSeconds = currentTtl > 0 ? currentTtl : this.ttl;

      // Routed through writeEntry so a key that expired mid-call is counted as
      // the insert it now is, instead of drifting the size counter down.
      await this.writeEntry(key, serialized, ttlSeconds);
    }
  }

  /**
   * Set document with validation result in a single operation
   */
  public async setWithValidation(
    query: string,
    document: DocumentNode,
    validation: CachedValidation
  ): Promise<void> {
    const key = this.generateKey(query);
    await this.writeEntry(key, this.serialize(query, document, validation));
  }

  /**
   * Check if a query is in the cache
   */
  public async has(query: string): Promise<boolean> {
    const key = this.generateKey(query);
    const exists = await this.client.exists(key);
    return exists > 0;
  }

  /**
   * Remove a query from the cache
   */
  public async delete(query: string): Promise<boolean> {
    const key = this.generateKey(query);
    const deleted = await this.client.del(key);

    if (deleted > 0) {
      // Keep the authoritative size counter in sync (fire-and-forget)
      this.track(this.client.incrby(this.sizeKey, -1), this.sizeKey);
    }

    return deleted > 0;
  }

  /**
   * Delete a batch of keys, reporting how far the sweep got when the delete
   * itself fails so the caller is not left guessing.
   */
  private async deleteBatch(keys: string[], alreadyDeleted: number): Promise<number> {
    try {
      return await this.client.del(keys);
    } catch (error) {
      throw new Error(`Cache clear failed after deleting ${alreadyDeleted} keys`, {
        cause: error,
      });
    }
  }

  /**
   * Clear the entire cache.
   *
   * Uses cursor-based SCAN when the client supports it; falls back to the
   * blocking KEYS command only for clients without `scan`. Stats counters
   * live under the same prefix, so they are reset as part of the sweep.
   *
   * The SCAN loop is capped at {@link MAX_SCAN_ITERATIONS} round trips rather
   * than trusting a server-returned cursor to eventually reach 0, and a
   * mid-sweep delete failure reports how many keys were already removed.
   */
  public async clear(): Promise<void> {
    const pattern = `${this.prefix}*`;
    const scan = this.client.scan?.bind(this.client);

    if (scan) {
      let cursor: string | number = '0';
      let iterations = 0;
      let deleted = 0;

      do {
        if (++iterations > MAX_SCAN_ITERATIONS) {
          throw new Error(
            `Cache clear aborted after ${MAX_SCAN_ITERATIONS} SCAN iterations ` +
              `(${deleted} keys deleted); the client never returned a terminating cursor`
          );
        }

        const result = await scan(cursor, 'MATCH', pattern, 'COUNT', 250);
        const { cursor: next, keys } = normalizeScanReply(result);
        // Re-filter defensively in case the client ignored the MATCH args
        const matching = keys.filter((k) => k.startsWith(this.prefix));
        if (matching.length > 0) {
          deleted += await this.deleteBatch(matching, deleted);
        }
        cursor = next;
      } while (String(cursor) !== '0');
      return;
    }

    const keys = await this.client.keys(pattern);
    if (keys.length > 0) {
      await this.deleteBatch(keys, 0);
    }
  }

  /**
   * Get the current cache size
   */
  public get size(): Promise<number> {
    return this.getSize();
  }

  /**
   * Read the authoritative size counter maintained on writes/deletes.
   * O(1) — avoids the blocking `KEYS <prefix>*` scan of the whole keyspace.
   * The counter cannot observe Redis-side TTL expirations, so it may
   * overcount entries that have expired but were never explicitly deleted.
   * A corrupt counter is reported through `onError` rather than silently
   * reading as an empty cache.
   */
  private async getSize(): Promise<number> {
    const size = this.readCounter(await this.client.get(this.sizeKey), this.sizeKey);
    // Guard against drift below zero
    return size > 0 ? size : 0;
  }

  /**
   * Get cache statistics
   *
   * Note: `hitRate` is the average number of hits per cached entry
   * (totalHits / size), NOT a hit/miss ratio — misses are not tracked and
   * the value can exceed 1.
   *
   * Note: `size`/`entries` come from a counter maintained on writes and
   * deletes. Redis expires keys on its own schedule and never tells the
   * counter, so on a cache with a TTL the reported size is an upper bound that
   * drifts above the number of keys actually present.
   *
   * Note: `totalHits` (and therefore `hitRate`) is 0 when the cache was
   * configured with `trackHits: false`.
   */
  public async getStats(): Promise<CacheStats> {
    const [size, hits] = await Promise.all([
      this.getSize(),
      this.client
        .get(this.hitsKey)
        .then((value) => this.readCounter(value, this.hitsKey)),
    ]);

    // Both counters are guarded against non-numeric values, so `hitRate`
    // can never come back as NaN.
    const totalHits = hits > 0 ? hits : 0;

    return {
      size,
      maxSize: this.maxSize,
      // Average hits per entry — not a hit/miss ratio (misses untracked)
      hitRate: size > 0 ? totalHits / size : 0,
      totalHits,
      entries: size,
    };
  }

  /**
   * Prune is not needed for Redis as TTL handles expiration
   */
  public async prune(): Promise<number> {
    // Redis handles TTL automatically
    return 0;
  }
}

/**
 * Create a new Redis document cache
 */
export function createRedisCache(config: RedisCacheConfig): RedisDocumentCache {
  return new RedisDocumentCache(config);
}
