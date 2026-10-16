/**
 * @leaven-graphql/core - Document cache tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { parse } from 'graphql';
import {
  DocumentCache,
  createDocumentCache,
  estimateDocumentBytes,
  AST_BYTES_PER_QUERY_CHAR,
  DEFAULT_CACHE_MAX_BYTES,
} from './cache';

describe('DocumentCache', () => {
  let cache: DocumentCache;

  beforeEach(() => {
    cache = new DocumentCache();
  });

  describe('constructor', () => {
    test('should create cache with default options', () => {
      expect(cache.size).toBe(0);
    });

    test('should create cache with custom options', () => {
      const customCache = new DocumentCache({
        maxSize: 500,
        ttl: 30000,
        lru: false,
      });
      expect(customCache.size).toBe(0);
    });
  });

  describe('set and get', () => {
    test('should store and retrieve a document', () => {
      const query = '{ hello }';
      const document = parse(query);

      cache.set(query, document);
      const retrieved = cache.get(query);

      expect(retrieved).toBeDefined();
      expect(retrieved?.definitions.length).toBe(document.definitions.length);
    });

    test('should return null for non-existent query', () => {
      const result = cache.get('{ nonexistent }');
      expect(result).toBeNull();
    });

    test('should update access time on get', () => {
      const query = '{ hello }';
      const document = parse(query);

      cache.set(query, document);

      // Get the document multiple times
      cache.get(query);
      cache.get(query);

      const stats = cache.getStats();
      expect(stats.totalHits).toBeGreaterThan(0);
    });
  });

  describe('has', () => {
    test('should return true for cached query', () => {
      const query = '{ hello }';
      cache.set(query, parse(query));

      expect(cache.has(query)).toBe(true);
    });

    test('should return false for non-cached query', () => {
      expect(cache.has('{ missing }')).toBe(false);
    });
  });

  describe('delete', () => {
    test('should remove a cached document', () => {
      const query = '{ hello }';
      cache.set(query, parse(query));

      const deleted = cache.delete(query);

      expect(deleted).toBe(true);
      expect(cache.has(query)).toBe(false);
    });

    test('should return false when deleting non-existent entry', () => {
      const deleted = cache.delete('{ nonexistent }');
      expect(deleted).toBe(false);
    });
  });

  describe('clear', () => {
    test('should remove all cached documents', () => {
      cache.set('{ a }', parse('{ a }'));
      cache.set('{ b }', parse('{ b }'));
      cache.set('{ c }', parse('{ c }'));

      cache.clear();

      expect(cache.size).toBe(0);
    });
  });

  describe('size', () => {
    test('should return correct cache size', () => {
      expect(cache.size).toBe(0);

      cache.set('{ a }', parse('{ a }'));
      expect(cache.size).toBe(1);

      cache.set('{ b }', parse('{ b }'));
      expect(cache.size).toBe(2);
    });
  });

  describe('LRU eviction', () => {
    test('should evict the least recently accessed entry when at capacity', () => {
      const smallCache = new DocumentCache({ maxSize: 2, lru: true });

      smallCache.set('{ a }', parse('{ a }'));
      smallCache.set('{ b }', parse('{ b }'));

      // Access 'a' so that 'b' becomes the least recently used entry
      smallCache.get('{ a }');

      // Adding a third entry must evict 'b', not 'a'
      smallCache.set('{ c }', parse('{ c }'));

      expect(smallCache.size).toBe(2);
      expect(smallCache.has('{ a }')).toBe(true);
      expect(smallCache.has('{ b }')).toBe(false);
      expect(smallCache.has('{ c }')).toBe(true);
    });

    test('getWithValidation should refresh recency for eviction', () => {
      const smallCache = new DocumentCache({ maxSize: 2, lru: true });

      smallCache.set('{ a }', parse('{ a }'));
      smallCache.set('{ b }', parse('{ b }'));

      // Access 'a' via getWithValidation so 'b' is least recently used
      smallCache.getWithValidation('{ a }');

      smallCache.set('{ c }', parse('{ c }'));

      expect(smallCache.has('{ a }')).toBe(true);
      expect(smallCache.has('{ b }')).toBe(false);
    });
  });

  describe('FIFO eviction (lru: false)', () => {
    test('should keep size bounded when inserting maxSize + 1 entries', () => {
      const fifoCache = new DocumentCache({ maxSize: 5, lru: false });

      for (let i = 0; i <= 5; i++) {
        const query = `{ q${i} }`;
        fifoCache.set(query, parse(query));
      }

      expect(fifoCache.size).toBe(5);
    });

    test('should evict the oldest inserted entry regardless of access', () => {
      const fifoCache = new DocumentCache({ maxSize: 2, lru: false });

      fifoCache.set('{ a }', parse('{ a }'));
      fifoCache.set('{ b }', parse('{ b }'));

      // Access 'a' — FIFO must NOT protect it from eviction
      fifoCache.get('{ a }');

      fifoCache.set('{ c }', parse('{ c }'));

      expect(fifoCache.size).toBe(2);
      expect(fifoCache.has('{ a }')).toBe(false);
      expect(fifoCache.has('{ b }')).toBe(true);
      expect(fifoCache.has('{ c }')).toBe(true);
    });
  });

  describe('maxSize: 0 (caching disabled)', () => {
    test('should store nothing via set', () => {
      const disabled = new DocumentCache({ maxSize: 0 });

      disabled.set('{ a }', parse('{ a }'));

      expect(disabled.size).toBe(0);
      expect(disabled.getStats().size).toBe(0);
      expect(disabled.get('{ a }')).toBeNull();
      expect(disabled.has('{ a }')).toBe(false);
    });

    test('should store nothing via setWithValidation', () => {
      const disabled = new DocumentCache({ maxSize: 0 });

      disabled.setWithValidation('{ a }', parse('{ a }'), {
        valid: true,
        errors: [],
      });

      expect(disabled.size).toBe(0);
      expect(disabled.getWithValidation('{ a }')).toBeNull();
    });

    test('should treat a negative maxSize the same way', () => {
      const disabled = new DocumentCache({ maxSize: -1 });

      disabled.set('{ a }', parse('{ a }'));

      expect(disabled.size).toBe(0);
    });
  });

  describe('byte budget (maxBytes)', () => {
    const doc = parse('{ a }');
    /** A distinct cache key of exactly `length` characters */
    const key = (id: number, length: number): string =>
      `${id}:`.padEnd(length, 'x');
    const valid = { valid: true, errors: [] };

    test('should default to 32 MiB and the documented AST factor', () => {
      expect(DEFAULT_CACHE_MAX_BYTES).toBe(32 * 1024 * 1024);
      expect(estimateDocumentBytes('x'.repeat(10))).toBe(10 * AST_BYTES_PER_QUERY_CHAR);
      const stats = new DocumentCache().getStats();
      expect(stats.maxBytes).toBe(DEFAULT_CACHE_MAX_BYTES);
      expect(stats.bytes).toBe(0);
    });

    test('should track the estimated bytes of stored entries', () => {
      const sized = new DocumentCache();
      sized.set(key(1, 20), doc);
      sized.setWithValidation(key(2, 30), doc, valid);
      expect(sized.bytes).toBe(50 * AST_BYTES_PER_QUERY_CHAR);
      expect(sized.getStats().bytes).toBe(50 * AST_BYTES_PER_QUERY_CHAR);
    });

    test('should evict least recently used entries once maxBytes would be exceeded', () => {
      const budget = 100 * AST_BYTES_PER_QUERY_CHAR;
      const sized = new DocumentCache({ maxBytes: budget, maxSize: 1000 });

      for (let i = 0; i < 10; i++) sized.set(key(i, 10), doc);
      expect(sized.size).toBe(10);
      expect(sized.bytes).toBe(budget);

      // Touch the oldest so the second-oldest is the LRU victim
      sized.get(key(0, 10));
      sized.set(key(10, 10), doc);

      expect(sized.size).toBe(10);
      expect(sized.bytes).toBe(budget);
      expect(sized.has(key(0, 10))).toBe(true);
      expect(sized.has(key(1, 10))).toBe(false);
      expect(sized.has(key(10, 10))).toBe(true);
    });

    test('should evict as many entries as a larger one needs', () => {
      const budget = 100 * AST_BYTES_PER_QUERY_CHAR;
      const sized = new DocumentCache({ maxBytes: budget });

      for (let i = 0; i < 20; i++) sized.set(key(i, 5), doc);
      sized.setWithValidation(key(99, 10), doc, valid);

      expect(sized.bytes).toBeLessThanOrEqual(budget);
      expect(sized.size).toBe(19);
      expect(sized.has(key(0, 5))).toBe(false);
      expect(sized.has(key(1, 5))).toBe(false);
      expect(sized.has(key(2, 5))).toBe(true);
    });

    test('should not cache a single entry larger than maxBytes / 10', () => {
      const budget = 100 * AST_BYTES_PER_QUERY_CHAR;
      const sized = new DocumentCache({ maxBytes: budget });
      sized.set(key(1, 10), doc);

      sized.set(key(2, 11), doc);
      sized.setWithValidation(key(3, 11), doc, valid);

      expect(sized.has(key(2, 11))).toBe(false);
      expect(sized.has(key(3, 11))).toBe(false);
      // ...and refusing it evicts nothing
      expect(sized.has(key(1, 10))).toBe(true);
      expect(sized.bytes).toBe(10 * AST_BYTES_PER_QUERY_CHAR);
    });

    test('should refuse oversized entries under the default budget', () => {
      const sized = new DocumentCache();
      const limit = Math.floor(DEFAULT_CACHE_MAX_BYTES / 10 / AST_BYTES_PER_QUERY_CHAR);

      sized.set('x'.repeat(limit), doc);
      sized.set('y'.repeat(limit + 1), doc);

      expect(sized.has('x'.repeat(limit))).toBe(true);
      expect(sized.has('y'.repeat(limit + 1))).toBe(false);
    });

    test('should still enforce maxSize under a roomy byte budget', () => {
      const sized = new DocumentCache({ maxSize: 3 });
      for (let i = 0; i < 5; i++) sized.set(key(i, 10), doc);
      expect(sized.size).toBe(3);
      expect(sized.bytes).toBe(30 * AST_BYTES_PER_QUERY_CHAR);
    });

    test('should keep the byte count exact through overwrite, delete, clear and expiry', async () => {
      const sized = new DocumentCache({ ttl: 30 });
      sized.set(key(1, 10), doc);
      sized.set(key(1, 10), doc);
      sized.setWithValidation(key(1, 10), doc, valid);
      expect(sized.bytes).toBe(10 * AST_BYTES_PER_QUERY_CHAR);

      sized.set(key(2, 20), doc);
      expect(sized.delete(key(2, 20))).toBe(true);
      expect(sized.bytes).toBe(10 * AST_BYTES_PER_QUERY_CHAR);

      sized.clear();
      expect(sized.bytes).toBe(0);

      sized.set(key(3, 10), doc);
      sized.set(key(4, 10), doc);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(sized.get(key(3, 10))).toBeNull();
      expect(sized.bytes).toBe(10 * AST_BYTES_PER_QUERY_CHAR);
      expect(sized.prune()).toBe(1);
      expect(sized.bytes).toBe(0);
    });

    test('should keep a rewritten slot in FIFO position and the count exact', () => {
      const fifo = new DocumentCache({ maxSize: 2, lru: false });
      fifo.set(key(1, 10), doc);
      fifo.set(key(2, 10), doc);
      fifo.setWithValidation(key(1, 10), doc, valid);
      expect(fifo.bytes).toBe(20 * AST_BYTES_PER_QUERY_CHAR);

      // Slot 1 is still the oldest insertion, so it is the one evicted
      fifo.set(key(3, 10), doc);
      expect(fifo.has(key(1, 10))).toBe(false);
      expect(fifo.has(key(2, 10))).toBe(true);
      expect(fifo.bytes).toBe(20 * AST_BYTES_PER_QUERY_CHAR);
    });

    test('should store nothing when maxBytes is 0', () => {
      const disabled = new DocumentCache({ maxBytes: 0 });
      disabled.set('{ a }', doc);
      disabled.setWithValidation('{ b }', doc, valid);
      expect(disabled.size).toBe(0);
      expect(disabled.bytes).toBe(0);
    });
  });

  describe('TTL expiry', () => {
    test('should expire entries after TTL', async () => {
      const ttlCache = new DocumentCache({ ttl: 50 });

      ttlCache.set('{ a }', parse('{ a }'));
      expect(ttlCache.has('{ a }')).toBe(true);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(ttlCache.has('{ a }')).toBe(false);
      expect(ttlCache.get('{ a }')).toBeNull();
    });
  });

  describe('prune', () => {
    test('should remove expired entries', async () => {
      const ttlCache = new DocumentCache({ ttl: 50 });

      ttlCache.set('{ a }', parse('{ a }'));
      ttlCache.set('{ b }', parse('{ b }'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      const pruned = ttlCache.prune();
      expect(pruned).toBe(2);
      expect(ttlCache.size).toBe(0);
    });
  });

  describe('getStats', () => {
    test('should return correct statistics', () => {
      cache.set('{ a }', parse('{ a }'));
      cache.get('{ a }');
      cache.get('{ a }');

      const stats = cache.getStats();

      expect(stats.size).toBe(1);
      expect(stats.entries).toBe(1);
      expect(stats.totalHits).toBe(2);
      // hitRate is the average number of hits per cached entry
      // (totalHits / size), not a hit/miss ratio — misses are not tracked,
      // so the value can exceed 1 (here: 2 hits / 1 entry = 2)
      expect(stats.hitRate).toBe(2);
    });

    test('should return zero hit rate for empty cache', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('validation caching', () => {
    test('should store and retrieve document with validation', () => {
      const query = '{ hello }';
      const document = parse(query);
      const validation = { valid: true, errors: [] as const };

      cache.setWithValidation(query, document, validation);
      const retrieved = cache.getWithValidation(query);

      expect(retrieved).toBeDefined();
      expect(retrieved?.document.definitions.length).toBe(document.definitions.length);
      expect(retrieved?.validation?.valid).toBe(true);
      expect(retrieved?.validation?.errors).toHaveLength(0);
    });

    test('should return null for non-existent query with getWithValidation', () => {
      const result = cache.getWithValidation('{ nonexistent }');
      expect(result).toBeNull();
    });

    test('should set validation on existing cached document', () => {
      const query = '{ hello }';
      const document = parse(query);

      // First, cache document without validation
      cache.set(query, document);

      // Then add validation
      const validation = { valid: true, errors: [] as const };
      cache.setValidation(query, validation);

      // Retrieve with validation
      const retrieved = cache.getWithValidation(query);
      expect(retrieved?.validation?.valid).toBe(true);
    });

    test('should handle invalid validation result', () => {
      const query = '{ hello }';
      const document = parse(query);
      const mockError = { message: 'Invalid field' } as unknown;
      const validation = { valid: false, errors: [mockError] as const };

      cache.setWithValidation(query, document, validation);
      const retrieved = cache.getWithValidation(query);

      expect(retrieved?.validation?.valid).toBe(false);
      expect(retrieved?.validation?.errors).toHaveLength(1);
    });

    test('setValidation should do nothing for non-cached query', () => {
      const validation = { valid: true, errors: [] as const };
      // Should not throw
      cache.setValidation('{ nonexistent }', validation);
    });

    test('getWithValidation should update LRU tracking', () => {
      const query = '{ hello }';
      cache.set(query, parse(query));

      // Get multiple times
      cache.getWithValidation(query);
      cache.getWithValidation(query);

      const stats = cache.getStats();
      expect(stats.totalHits).toBeGreaterThan(0);
    });

    test('getWithValidation should return null for expired entry', async () => {
      const ttlCache = new DocumentCache({ ttl: 50 });
      const query = '{ hello }';
      const validation = { valid: true, errors: [] as const };

      ttlCache.setWithValidation(query, parse(query), validation);
      expect(ttlCache.getWithValidation(query)).not.toBeNull();

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(ttlCache.getWithValidation(query)).toBeNull();
    });
  });

  describe('direct key optimization', () => {
    test('should use direct key for small queries', () => {
      // Small query should use direct key (no hashing)
      const smallQuery = '{ hello }';
      cache.set(smallQuery, parse(smallQuery));
      expect(cache.has(smallQuery)).toBe(true);
    });

    test('should hash large queries', () => {
      // Large query should be hashed
      const largeQuery = `{
        ${'user'.repeat(100)} {
          id
          name
          email
        }
      }`;
      cache.set(largeQuery, parse(largeQuery));
      expect(cache.has(largeQuery)).toBe(true);
    });

    test('should respect custom directKeyMaxLength', () => {
      const customCache = new DocumentCache({ directKeyMaxLength: 5 });
      const query = '{ hello }'; // Longer than 5 chars
      customCache.set(query, parse(query));
      expect(customCache.has(query)).toBe(true);
    });
  });

  describe('hashed key collisions', () => {
    const longA = `{ user(id: "a") { id name } } # ${'a'.repeat(300)}`;
    const longB = `{ hello } # ${'b'.repeat(300)}`;

    test('should never serve the entry of one query for another, even when hashes collide', () => {
      // Force every hashed key to collide
      const colliding = new DocumentCache({ hashKey: () => 'collide' });

      colliding.setWithValidation(longA, parse(longA), { valid: true, errors: [] });

      expect(colliding.get(longB)).toBeNull();
      expect(colliding.getWithValidation(longB)).toBeNull();
      expect(colliding.has(longB)).toBe(false);
      expect(colliding.delete(longB)).toBe(false);

      // setValidation for B must not overwrite A's verdict
      colliding.setValidation(longB, { valid: false, errors: [] });
      expect(colliding.getWithValidation(longA)?.validation?.valid).toBe(true);

      // A real write of B replaces the slot; A is then a miss, never B's data
      colliding.set(longB, parse(longB));
      expect(colliding.get(longA)).toBeNull();
      expect(colliding.get(longB)).not.toBeNull();
    });

    test('should not key long queries by the 64-bit Bun.hash', () => {
      const spy = spyOn(Bun, 'hash').mockImplementation(() => 1n);
      try {
        const fresh = new DocumentCache();
        fresh.set(longA, parse(longA));
        fresh.set(longB, parse(longB));

        expect(fresh.size).toBe(2);
        expect(fresh.get(longA)).not.toBe(fresh.get(longB));
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('createDocumentCache', () => {
    test('should create a DocumentCache instance', () => {
      const cache = createDocumentCache();
      expect(cache).toBeInstanceOf(DocumentCache);
    });

    test('should create cache with custom config', () => {
      const cache = createDocumentCache({ maxSize: 100 });
      expect(cache).toBeInstanceOf(DocumentCache);
    });
  });
});
