/**
 * @leaven-graphql/core - Cache interface definitions
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { DocumentNode, GraphQLError } from 'graphql';

/**
 * Validation result stored in cache
 */
export interface CachedValidation {
  /** Whether the document is valid */
  valid: boolean;
  /** Validation errors if invalid */
  errors: readonly GraphQLError[];
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /**
   * Current number of entries.
   *
   * NOTE: Exact only for backends that can count their own keyspace (the
   * in-memory `DocumentCache`). A distributed backend such as
   * `RedisDocumentCache` maintains this as a counter updated on writes and
   * deletes, and cannot observe server-side TTL expirations — so on a cache
   * with a TTL it is an upper bound that drifts upward.
   */
  size: number;
  /** Maximum allowed entries */
  maxSize: number;
  /**
   * Average number of hits per cached entry (totalHits / size).
   *
   * NOTE: This is NOT a hit/miss ratio — misses are not tracked at all, so
   * the value is unbounded and routinely exceeds 1 on a warm cache.
   */
  hitRate: number;
  /** Total number of cache hits */
  totalHits: number;
  /** Number of entries (alias for `size` — same accuracy caveat) */
  entries: number;
  /**
   * Estimated bytes retained by the cached entries. Reported by the
   * in-memory `DocumentCache`; backends that cannot estimate it omit it.
   */
  bytes?: number;
  /** Configured memory budget in bytes, when the backend has one */
  maxBytes?: number;
}

/**
 * Abstract cache interface for document caching
 * Implementations can be in-memory, Redis, or other storage backends
 */
export interface IDocumentCache {
  /**
   * Get a document from the cache
   */
  get(query: string): DocumentNode | null | Promise<DocumentNode | null>;

  /**
   * Set a document in the cache
   */
  set(query: string, document: DocumentNode): void | Promise<void>;

  /**
   * Get a document with its validation result from the cache
   */
  getWithValidation(
    query: string
  ): { document: DocumentNode; validation?: CachedValidation } | null | Promise<{ document: DocumentNode; validation?: CachedValidation } | null>;

  /**
   * Set validation result for a cached document
   */
  setValidation(query: string, validation: CachedValidation): void | Promise<void>;

  /**
   * Set document with validation result in a single operation.
   *
   * Preferred over `set()` followed by `setValidation()` on any cold path: a
   * remote backend would otherwise have to re-read the entry and re-serialize
   * the `DocumentNode` the caller already holds.
   */
  setWithValidation(
    query: string,
    document: DocumentNode,
    validation: CachedValidation
  ): void | Promise<void>;

  /**
   * Check if a query is in the cache
   */
  has(query: string): boolean | Promise<boolean>;

  /**
   * Remove a query from the cache
   */
  delete(query: string): boolean | Promise<boolean>;

  /**
   * Clear the entire cache
   */
  clear(): void | Promise<void>;

  /**
   * Get the current cache size
   */
  readonly size: number | Promise<number>;

  /**
   * Get cache statistics
   */
  getStats(): CacheStats | Promise<CacheStats>;

  /**
   * Prune expired entries (optional)
   */
  prune?(): number | Promise<number>;
}

/**
 * Type guard to check if a value is a Promise
 */
export function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value !== null && typeof value === 'object' && 'then' in value && typeof (value as Promise<T>).then === 'function';
}

/**
 * Ensure a value is resolved (handles both sync and async)
 */
export async function resolveValue<T>(value: T | Promise<T>): Promise<T> {
  return isPromise(value) ? await value : value;
}
