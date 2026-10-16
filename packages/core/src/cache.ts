/**
 * @leaven-graphql/core - Document caching
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { DocumentNode } from 'graphql';
import type { IDocumentCache, CachedValidation, CacheStats } from './cache-interface';

// Re-export interface types
export type { IDocumentCache, CachedValidation, CacheStats } from './cache-interface';
export { isPromise, resolveValue } from './cache-interface';

/**
 * Configuration for the document cache
 */
export interface DocumentCacheConfig {
  /**
   * Maximum number of entries to cache (default: 1000).
   * `0` (or any non-positive value) disables caching entirely — nothing is
   * stored, so every lookup is a miss.
   */
  maxSize?: number;
  /** TTL for cache entries in milliseconds (default: 0 = no expiry) */
  ttl?: number;
  /**
   * Enable LRU eviction (default: true).
   * When false, `maxSize` is still enforced but entries are evicted in
   * FIFO (insertion) order instead of least-recently-used order.
   */
  lru?: boolean;
  /** Maximum query length to use as direct key (avoids hashing, default: 256) */
  directKeyMaxLength?: number;
  /**
   * Hash used to key queries longer than `directKeyMaxLength`
   * (default: SHA-256, hex).
   *
   * Entries keep their full query string and a lookup only hits when it
   * matches, so even a colliding hash can never serve one query's document or
   * validation verdict for another; a collision is just a miss.
   */
  hashKey?: (query: string) => string;
}

/**
 * Default key hash for long queries: SHA-256, hex encoded.
 */
export function sha256Hex(input: string): string {
  return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}

/**
 * A cached document entry
 */
export interface CacheEntry {
  /** The full query string this entry was stored for */
  query: string;
  /** The parsed document */
  document: DocumentNode;
  /** Cached validation result (if validated) */
  validation?: CachedValidation;
  /** When this entry was created */
  createdAt: number;
  /**
   * Last access time (informational only — eviction order is tracked via
   * the cache Map's insertion order, not this field)
   */
  lastAccess: number;
  /** Number of times this entry was accessed */
  hits: number;
}

/**
 * In-memory document cache for storing parsed GraphQL documents
 * Implements the IDocumentCache interface for interchangeability with Redis
 */
export class DocumentCache implements IDocumentCache {
  private readonly cache: Map<string, CacheEntry>;
  private readonly maxSize: number;
  private readonly ttl: number;
  private readonly lru: boolean;
  private readonly directKeyMaxLength: number;
  private readonly hashKey: (query: string) => string;

  constructor(config: DocumentCacheConfig = {}) {
    this.cache = new Map();
    this.maxSize = config.maxSize ?? 1000;
    this.ttl = config.ttl ?? 0;
    this.lru = config.lru ?? true;
    this.directKeyMaxLength = config.directKeyMaxLength ?? 256;
    this.hashKey = config.hashKey ?? sha256Hex;
  }

  /**
   * Generate a cache key for a query string.
   * Uses the string directly for small queries and `hashKey` (SHA-256 by
   * default) for larger ones. Direct keys are prefixed `d:` so they can never
   * clash with a hashed `h:` key.
   */
  private generateKey(query: string): string {
    // For small queries, use the query string directly (avoids hashing overhead)
    if (query.length <= this.directKeyMaxLength) {
      return `d:${query}`;
    }
    return `h:${this.hashKey(query)}`;
  }

  /**
   * Look up the live entry stored for exactly this query.
   *
   * Returns undefined on a miss, on an expired entry (which is removed) and
   * on a key collision, where the slot holds a different query.
   */
  private lookup(key: string, query: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry || entry.query !== query) {
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return undefined;
    }

    return entry;
  }

  /**
   * Check if an entry is expired
   */
  private isExpired(entry: CacheEntry): boolean {
    if (this.ttl === 0) return false;
    return Date.now() - entry.createdAt > this.ttl;
  }

  /**
   * Evict one entry to make room for a new one, in O(1).
   *
   * The cache Map's insertion order doubles as the eviction order: with LRU
   * enabled, hits re-insert entries at the end of the Map, so the first key
   * is the least recently used. With LRU disabled nothing is re-ordered, so
   * the first key is simply the oldest insertion (FIFO). Either way,
   * `maxSize` is always enforced.
   */
  private evictOldest(): void {
    if (this.cache.size === 0) return;

    const oldestKey = this.cache.keys().next().value;
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Move an entry to the end of the Map so insertion order reflects recency.
   * Only used when LRU eviction is enabled.
   */
  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  /**
   * Get a document from the cache
   */
  public get(query: string): DocumentNode | null {
    const key = this.generateKey(query);
    const entry = this.lookup(key, query);

    if (!entry) {
      return null;
    }

    // Update access tracking (Map insertion order tracks recency for LRU)
    entry.lastAccess = Date.now();
    entry.hits++;
    if (this.lru) {
      this.touch(key, entry);
    }

    return entry.document;
  }

  /**
   * Set a document in the cache.
   * A non-positive `maxSize` disables caching, so nothing is stored.
   */
  public set(query: string, document: DocumentNode): void {
    if (this.maxSize <= 0) return;

    const key = this.generateKey(query);

    if (this.cache.has(key)) {
      // Re-insert so Map order reflects recency when LRU is enabled
      if (this.lru) {
        this.cache.delete(key);
      }
    } else if (this.cache.size >= this.maxSize) {
      // Evict at capacity (LRU when enabled, FIFO otherwise)
      this.evictOldest();
    }

    const now = Date.now();
    this.cache.set(key, {
      query,
      document,
      createdAt: now,
      lastAccess: now,
      hits: 0,
    });
  }

  /**
   * Get a document with its validation result from the cache
   */
  public getWithValidation(query: string): { document: DocumentNode; validation?: CachedValidation } | null {
    const key = this.generateKey(query);
    const entry = this.lookup(key, query);

    if (!entry) {
      return null;
    }

    // Update access tracking (Map insertion order tracks recency for LRU)
    entry.lastAccess = Date.now();
    entry.hits++;
    if (this.lru) {
      this.touch(key, entry);
    }

    return { document: entry.document, validation: entry.validation };
  }

  /**
   * Set validation result for a cached document
   */
  public setValidation(query: string, validation: CachedValidation): void {
    const key = this.generateKey(query);
    const entry = this.lookup(key, query);

    if (entry) {
      entry.validation = validation;
    }
  }

  /**
   * Set document with validation result in a single operation.
   * A non-positive `maxSize` disables caching, so nothing is stored.
   */
  public setWithValidation(query: string, document: DocumentNode, validation: CachedValidation): void {
    if (this.maxSize <= 0) return;

    const key = this.generateKey(query);

    if (this.cache.has(key)) {
      // Re-insert so Map order reflects recency when LRU is enabled
      if (this.lru) {
        this.cache.delete(key);
      }
    } else if (this.cache.size >= this.maxSize) {
      // Evict at capacity (LRU when enabled, FIFO otherwise)
      this.evictOldest();
    }

    const now = Date.now();
    this.cache.set(key, {
      query,
      document,
      validation,
      createdAt: now,
      lastAccess: now,
      hits: 0,
    });
  }

  /**
   * Check if a query is in the cache
   */
  public has(query: string): boolean {
    return this.lookup(this.generateKey(query), query) !== undefined;
  }

  /**
   * Remove a query from the cache
   */
  public delete(query: string): boolean {
    const key = this.generateKey(query);
    // Only delete the slot when it really holds this query
    if (this.cache.get(key)?.query !== query) {
      return false;
    }
    return this.cache.delete(key);
  }

  /**
   * Clear the entire cache
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current cache size
   */
  public get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   *
   * Note: `hitRate` is the average number of hits per cached entry
   * (totalHits / size), NOT a hit/miss ratio — misses are not tracked and
   * the value can exceed 1.
   */
  public getStats(): CacheStats {
    let totalHits = 0;
    for (const entry of this.cache.values()) {
      totalHits += entry.hits;
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      // Average hits per entry — not a hit/miss ratio (misses untracked)
      hitRate: this.cache.size > 0 ? totalHits / this.cache.size : 0,
      totalHits,
      entries: this.cache.size,
    };
  }

  /**
   * Prune expired entries
   */
  public prune(): number {
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}

/**
 * Create a new document cache
 */
export function createDocumentCache(config?: DocumentCacheConfig): DocumentCache {
  return new DocumentCache(config);
}
