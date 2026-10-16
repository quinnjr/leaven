/**
 * @leaven-graphql/core - Compiled query cache
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { estimateDocumentBytes } from './cache';
import type { CompiledQuery } from './compiler';

interface Slot {
  compiled: CompiledQuery;
  bytes: number;
}

/**
 * LRU cache of compiled query plans, bounded by entry count AND estimated
 * bytes.
 *
 * A plan retains its `DocumentNode`, so it is sized like a document-cache
 * entry: {@link estimateDocumentBytes} of the query text. Least recently used
 * plans are evicted until both limits hold, and a plan estimated above
 * `maxBytes / 10` is not cached at all.
 *
 * Internal to the executor; not part of the public API.
 */
export class CompiledQueryCache {
  private readonly slots = new Map<string, Slot>();
  private totalBytes = 0;

  constructor(
    public readonly maxSize: number,
    public readonly maxBytes: number
  ) {}

  /** Look up a plan, marking it most recently used */
  public get(key: string): CompiledQuery | undefined {
    const slot = this.slots.get(key);
    if (!slot) return undefined;
    // Map insertion order is the recency order
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot.compiled;
  }

  /**
   * Store a plan for `key`, sized from `query`, evicting as needed.
   * Oversized plans are silently refused.
   */
  public set(key: string, query: string, compiled: CompiledQuery): void {
    const bytes = estimateDocumentBytes(query);
    if (this.maxSize <= 0 || bytes > this.maxBytes / 10) return;

    const existing = this.slots.get(key);
    if (existing) {
      this.slots.delete(key);
      this.totalBytes -= existing.bytes;
    }

    while (
      this.slots.size > 0 &&
      (this.slots.size >= this.maxSize || this.totalBytes + bytes > this.maxBytes)
    ) {
      const oldest = this.slots.keys().next().value as string;
      this.totalBytes -= this.slots.get(oldest)!.bytes;
      this.slots.delete(oldest);
    }

    this.slots.set(key, { compiled, bytes });
    this.totalBytes += bytes;
  }

  /** Drop every plan */
  public clear(): void {
    this.slots.clear();
    this.totalBytes = 0;
  }

  /** Number of cached plans */
  public get size(): number {
    return this.slots.size;
  }

  /** Estimated bytes retained by the cached plans */
  public get bytes(): number {
    return this.totalBytes;
  }
}
