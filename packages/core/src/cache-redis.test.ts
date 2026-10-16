/**
 * @leaven-graphql/core - Redis document cache tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { parse, GraphQLError } from 'graphql';
import { RedisDocumentCache, createRedisCache, type RedisClient } from './cache-redis';

/**
 * Mock Redis client for testing
 */
function createMockRedis(): RedisClient & { data: Map<string, { value: string; ttl?: number }> } {
  const data = new Map<string, { value: string; ttl?: number }>();

  return {
    data,
    async get(key: string) {
      const entry = data.get(key);
      return entry?.value ?? null;
    },
    async set(key: string, value: string, ...args: unknown[]) {
      const ttl = args[0] === 'EX' ? (args[1] as number) : undefined;
      data.set(key, { value, ttl });
      return 'OK';
    },
    async setNx(key: string, value: string, ttlSeconds: number) {
      // Atomic check-and-set, exactly as Redis's SET ... NX behaves
      if (data.has(key)) return null;
      data.set(key, { value, ttl: ttlSeconds > 0 ? ttlSeconds : undefined });
      return 'OK';
    },
    async del(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      let deleted = 0;
      for (const k of keys) {
        if (data.delete(k)) deleted++;
      }
      return deleted;
    },
    async exists(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      return keys.filter((k) => data.has(k)).length;
    },
    async keys(pattern: string) {
      const prefix = pattern.replace('*', '');
      return Array.from(data.keys()).filter((k) => k.startsWith(prefix));
    },
    async incr(key: string) {
      const current = parseInt(data.get(key)?.value ?? '0', 10);
      data.set(key, { value: String(current + 1) });
      return current + 1;
    },
    async incrby(key: string, increment: number) {
      const current = parseInt(data.get(key)?.value ?? '0', 10);
      data.set(key, { value: String(current + increment) });
      return current + increment;
    },
    async expire(_key: string, _seconds: number) {
      return 1;
    },
    async ttl(key: string) {
      const entry = data.get(key);
      return entry?.ttl ?? -1;
    },
    async scan(_cursor: string | number, ...args: unknown[]) {
      // Single-pass SCAN (ioredis shape): all matching keys, terminating cursor
      const matchIndex = args.indexOf('MATCH');
      const pattern = matchIndex >= 0 ? String(args[matchIndex + 1]) : '*';
      const prefix = pattern.replace('*', '');
      const keys = Array.from(data.keys()).filter((k) => k.startsWith(prefix));
      return ['0', keys] as [string, string[]];
    },
  };
}

/**
 * Mock whose commands complete on a later tick, the way a real client's
 * round trips do. Needed to expose write races that a synchronous mock hides.
 */
function createLatentRedis(options: { nx: boolean }): RedisClient {
  const base = createMockRedis();
  const delay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

  const client: RedisClient = {
    async get(key) {
      await delay();
      return base.get(key);
    },
    async set(key, value, ...args) {
      await delay();
      return base.set(key, value, ...args);
    },
    async del(key) {
      await delay();
      return base.del(key);
    },
    async exists(key) {
      await delay();
      return base.exists(key);
    },
    async keys(pattern) {
      await delay();
      return base.keys(pattern);
    },
    async incr(key) {
      await delay();
      return base.incr(key);
    },
    async incrby(key, increment) {
      await delay();
      return base.incrby(key, increment);
    },
    async expire(key, seconds) {
      await delay();
      return base.expire(key, seconds);
    },
    async ttl(key) {
      await delay();
      return base.ttl(key);
    },
  };

  if (options.nx) {
    client.setNx = async (key, value, ttlSeconds) => {
      // The delay is BEFORE the check-and-set, which itself stays atomic
      await delay();
      return base.setNx!(key, value, ttlSeconds);
    };
  }

  return client;
}

/** Let fire-and-forget counter writes land */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('RedisDocumentCache', () => {
  let cache: RedisDocumentCache;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    cache = new RedisDocumentCache({
      client: mockRedis,
      prefix: 'test:doc:',
      ttl: 3600,
    });
  });

  describe('constructor', () => {
    test('should create cache with default options', () => {
      const defaultCache = new RedisDocumentCache({ client: mockRedis });
      expect(defaultCache).toBeInstanceOf(RedisDocumentCache);
    });

    test('should create cache with custom options', () => {
      const customCache = new RedisDocumentCache({
        client: mockRedis,
        prefix: 'custom:',
        ttl: 7200,
        maxSize: 5000,
      });
      expect(customCache).toBeInstanceOf(RedisDocumentCache);
    });
  });

  describe('set and get', () => {
    test('should store and retrieve a document', async () => {
      const query = '{ hello }';
      const document = parse(query);

      await cache.set(query, document);
      const retrieved = await cache.get(query);

      expect(retrieved).toBeDefined();
      expect(retrieved?.definitions.length).toBe(document.definitions.length);
    });

    test('should return null for non-existent query', async () => {
      const result = await cache.get('{ nonexistent }');
      expect(result).toBeNull();
    });

    test('should set TTL on entries', async () => {
      const query = '{ hello }';
      const document = parse(query);

      await cache.set(query, document);

      // Verify the key was set - exclude stats keys
      const keys = Array.from(mockRedis.data.keys()).filter(
        (k) => k.startsWith('test:doc:') && !k.includes('__stats__')
      );
      expect(keys.length).toBe(1);
    });
  });

  describe('getWithValidation', () => {
    test('should store and retrieve document with validation', async () => {
      const query = '{ hello }';
      const document = parse(query);
      const validation = { valid: true, errors: [] as const };

      await cache.setWithValidation(query, document, validation);
      const retrieved = await cache.getWithValidation(query);

      expect(retrieved).toBeDefined();
      expect(retrieved?.document.definitions.length).toBe(document.definitions.length);
      expect(retrieved?.validation?.valid).toBe(true);
    });

    test('should return null for non-existent query', async () => {
      const result = await cache.getWithValidation('{ nonexistent }');
      expect(result).toBeNull();
    });

    test('should handle validation errors with locations and paths', async () => {
      const query = '{ testQuery }';
      const document = parse('{ hello }');
      const mockError = {
        message: 'Field not found',
        locations: [{ line: 1, column: 3 }],
        path: ['hello'],
      } as unknown;
      const validation = { valid: false, errors: [mockError] as const };

      await cache.setWithValidation(query, document, validation);
      const retrieved = await cache.getWithValidation(query);

      expect(retrieved?.validation?.valid).toBe(false);
      expect(retrieved?.validation?.errors).toHaveLength(1);
      expect(retrieved?.validation?.errors[0].message).toBe('Field not found');
      expect(retrieved?.validation?.errors[0].locations).toEqual([{ line: 1, column: 3 }]);
      expect(retrieved?.validation?.errors[0].path).toEqual(['hello']);
    });

    test('should rebuild real GraphQLError instances and preserve extensions', async () => {
      const query = '{ badField }';
      const document = parse('{ hello }');
      const originalError = new GraphQLError('Cannot query field "badField"', {
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      });
      const validation = { valid: false, errors: [originalError] as const };

      await cache.setWithValidation(query, document, validation);
      const retrieved = await cache.getWithValidation(query);

      const revived = retrieved?.validation?.errors[0];
      expect(revived).toBeInstanceOf(GraphQLError);
      expect(revived?.message).toBe('Cannot query field "badField"');
      // extensions.code must survive a cache round trip
      expect(revived?.extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
      // toJSON must include extensions for downstream error formatting
      expect(revived?.toJSON().extensions?.code).toBe('GRAPHQL_VALIDATION_FAILED');
    });
  });

  describe('setValidation', () => {
    test('should update validation on existing cached document', async () => {
      const query = '{ hello }';
      const document = parse(query);

      // First, cache document without validation
      await cache.set(query, document);

      // Then add validation
      const validation = { valid: true, errors: [] as const };
      await cache.setValidation(query, validation);

      // Retrieve with validation
      const retrieved = await cache.getWithValidation(query);
      expect(retrieved?.validation?.valid).toBe(true);
    });

    test('should do nothing for non-cached query', async () => {
      const validation = { valid: true, errors: [] as const };
      // Should not throw
      await cache.setValidation('{ nonexistent }', validation);
    });

    test('should preserve the remaining lifetime of the entry', async () => {
      const query = '{ hello }';
      await cache.set(query, parse(query));

      // Redis reports the time left, not the original TTL
      mockRedis.ttl = async () => 120;
      await cache.setValidation(query, { valid: true, errors: [] as const });

      const entry = Array.from(mockRedis.data.entries()).find(
        ([k]) => k.startsWith('test:doc:') && !k.includes('__stats__')
      );
      expect(entry?.[1].ttl).toBe(120);
    });

    test('should fall back to the configured TTL when the key expired mid-call', async () => {
      const raceMock = createMockRedis();
      // GET returned the entry, then it expired before TTL ran: Redis answers
      // -2 for a key that no longer exists.
      raceMock.ttl = async () => -2;

      const raceCache = new RedisDocumentCache({
        client: raceMock,
        prefix: 'race:',
        ttl: 3600,
      });

      const query = '{ hello }';
      await raceCache.set(query, parse(query));
      await raceCache.setValidation(query, { valid: true, errors: [] as const });

      const entry = Array.from(raceMock.data.entries()).find(
        ([k]) => k.startsWith('race:') && !k.includes('__stats__')
      );
      // Writing with no expiry at all would leave a permanent key in a cache
      // whose entire eviction story is TTL
      expect(entry?.[1].ttl).toBe(3600);
      // ...and the size counter must not drift while doing it
      expect(await raceCache.size).toBe(1);
    });
  });

  describe('trackHits', () => {
    test('should record hits by default', async () => {
      const query = '{ hello }';
      await cache.set(query, parse(query));
      await cache.get(query);
      await cache.getWithValidation(query);
      await settle();

      expect(await cache.getStats()).toMatchObject({ totalHits: 2 });
    });

    test('should skip the hits counter when disabled', async () => {
      const quietMock = createMockRedis();
      const quietCache = new RedisDocumentCache({
        client: quietMock,
        prefix: 'quiet:',
        trackHits: false,
      });

      const query = '{ hello }';
      await quietCache.set(query, parse(query));
      expect(await quietCache.get(query)).not.toBeNull();
      expect(await quietCache.getWithValidation(query)).not.toBeNull();
      await settle();

      // Every hit would otherwise fire an INCR against one shared hotspot key
      expect(quietMock.data.has('quiet:__stats__:hits')).toBe(false);

      const stats = await quietCache.getStats();
      expect(stats.totalHits).toBe(0);
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('has', () => {
    test('should return true for cached query', async () => {
      const query = '{ hello }';
      await cache.set(query, parse(query));

      expect(await cache.has(query)).toBe(true);
    });

    test('should return false for non-cached query', async () => {
      expect(await cache.has('{ missing }')).toBe(false);
    });
  });

  describe('delete', () => {
    test('should remove a cached document', async () => {
      const query = '{ hello }';
      await cache.set(query, parse(query));

      const deleted = await cache.delete(query);

      expect(deleted).toBe(true);
      expect(await cache.has(query)).toBe(false);
    });

    test('should return false when deleting non-existent entry', async () => {
      const deleted = await cache.delete('{ nonexistent }');
      expect(deleted).toBe(false);
    });
  });

  describe('clear', () => {
    test('should remove all cached documents (via SCAN)', async () => {
      await cache.set('{ a }', parse('{ a }'));
      await cache.set('{ b }', parse('{ b }'));
      await cache.set('{ c }', parse('{ c }'));

      await cache.clear();

      expect(await cache.size).toBe(0);
      // All prefixed keys, including stats counters, are gone
      const remaining = Array.from(mockRedis.data.keys()).filter((k) => k.startsWith('test:doc:'));
      expect(remaining).toHaveLength(0);
    });

    test('should fall back to KEYS for clients without scan', async () => {
      const noScanMock = createMockRedis();
      delete (noScanMock as { scan?: unknown }).scan;
      const noScanCache = new RedisDocumentCache({
        client: noScanMock,
        prefix: 'noscan:',
      });

      await noScanCache.set('{ a }', parse('{ a }'));
      await noScanCache.set('{ b }', parse('{ b }'));

      await noScanCache.clear();

      expect(await noScanCache.size).toBe(0);
      const remaining = Array.from(noScanMock.data.keys()).filter((k) => k.startsWith('noscan:'));
      expect(remaining).toHaveLength(0);
    });
  });

  describe('size', () => {
    test('should return correct cache size', async () => {
      expect(await cache.size).toBe(0);

      await cache.set('{ a }', parse('{ a }'));
      expect(await cache.size).toBe(1);

      await cache.set('{ b }', parse('{ b }'));
      expect(await cache.size).toBe(2);
    });

    test('should not double-count overwrites of the same query', async () => {
      await cache.set('{ a }', parse('{ a }'));
      await cache.set('{ a }', parse('{ a }'));

      expect(await cache.size).toBe(1);
    });

    test('should decrement size when an entry is deleted', async () => {
      await cache.set('{ a }', parse('{ a }'));
      await cache.set('{ b }', parse('{ b }'));

      await cache.delete('{ a }');

      expect(await cache.size).toBe(1);
    });

    test('should count a racing pair of identical writes once (SET NX)', async () => {
      const client = createLatentRedis({ nx: true });
      const nxCache = new RedisDocumentCache({ client, prefix: 'nx:' });

      // Concurrent identical queries are the normal case for a document
      // cache; a non-atomic EXISTS-then-SET counts this insert twice.
      await Promise.all([
        nxCache.set('{ a }', parse('{ a }')),
        nxCache.set('{ a }', parse('{ a }')),
      ]);
      await settle();

      expect(await nxCache.size).toBe(1);
    });

    test('should still write and count for clients without NX support', async () => {
      const client = createLatentRedis({ nx: false });
      const fallbackCache = new RedisDocumentCache({ client, prefix: 'fallback:' });

      await fallbackCache.set('{ a }', parse('{ a }'));
      await settle();

      expect(await fallbackCache.get('{ a }')).not.toBeNull();
      expect(await fallbackCache.size).toBe(1);
    });

    test('should not scan the keyspace to compute size', async () => {
      await cache.set('{ a }', parse('{ a }'));

      // Reading the size must use the counter, not the blocking KEYS command
      const originalKeys = mockRedis.keys.bind(mockRedis);
      let keysCalled = false;
      mockRedis.keys = async (pattern: string) => {
        keysCalled = true;
        return originalKeys(pattern);
      };

      expect(await cache.size).toBe(1);
      const stats = await cache.getStats();
      expect(stats.size).toBe(1);
      expect(keysCalled).toBe(false);
    });

    test('should report an EXISTS failure even when the write itself throws', async () => {
      const errors: unknown[] = [];
      const brokenMock = createMockRedis();
      // Force the non-atomic EXISTS-then-SET path
      delete (brokenMock as { setNx?: unknown }).setNx;
      brokenMock.exists = async () => {
        throw new Error('EXISTS failed');
      };
      brokenMock.set = async () => {
        throw new Error('SET failed');
      };

      const brokenCache = new RedisDocumentCache({
        client: brokenMock,
        prefix: 'broken:',
        onError: (error) => errors.push(error),
      });

      await expect(brokenCache.set('{ a }', parse('{ a }'))).rejects.toThrow(
        'SET failed'
      );
      await settle();

      // The EXISTS rejection is handled at creation. Attaching the handler
      // only after the awaited write means a write that throws first leaves
      // the EXISTS rejection unhandled — which crashes the process.
      expect(
        errors.some((e) => (e as Error).message === 'EXISTS failed')
      ).toBe(true);
    });
  });

  describe('getStats', () => {
    test('should return statistics', async () => {
      await cache.set('{ a }', parse('{ a }'));
      await cache.get('{ a }');
      await cache.get('{ a }');

      const stats = await cache.getStats();

      expect(stats.size).toBe(1);
      expect(stats.entries).toBe(1);
      expect(stats.totalHits).toBeGreaterThan(0);
    });
  });

  describe('prune', () => {
    test('should return 0 (Redis handles TTL automatically)', async () => {
      const pruned = await cache.prune();
      expect(pruned).toBe(0);
    });
  });

  describe('compression', () => {
    test('should store compressed data when enabled', async () => {
      // Create a fresh mock Redis for compression tests
      const compressionMock = createMockRedis();
      const compressedCache = new RedisDocumentCache({
        client: compressionMock,
        prefix: 'compressed:',
        compress: true,
        compressionThreshold: 100,
      });

      // Create a large query that will trigger compression
      const largeQuery = `{
        users {
          id
          name
          email
          profile {
            avatar
            bio
            website
          }
        }
      }`;
      const document = parse(largeQuery);

      await compressedCache.set(largeQuery, document);

      // Verify something was stored
      const keys = Array.from(compressionMock.data.keys()).filter(
        (k) => k.startsWith('compressed:') && !k.includes('__stats__')
      );
      expect(keys.length).toBe(1);

      // Verify the stored data is compressed (contains z flag)
      const storedValue = compressionMock.data.get(keys[0])?.value;
      expect(storedValue).toBeDefined();
      const parsed = JSON.parse(storedValue!);
      expect(parsed.z).toBe(true); // Should be compressed
      expect(parsed.d).toBeDefined(); // Should have compressed data
    });

    test('should retrieve compressed documents', async () => {
      // Create a fresh mock Redis for compression tests
      const compressionMock = createMockRedis();
      const compressedCache = new RedisDocumentCache({
        client: compressionMock,
        prefix: 'compressed2:',
        compress: true,
        compressionThreshold: 100,
      });

      // Create a query that will be larger than 100 bytes when serialized
      const query = `{
        users {
          id
          name
          email
          age
          address {
            street
            city
          }
        }
      }`;
      const document = parse(query);

      await compressedCache.set(query, document);

      // Retrieve and verify
      const retrieved = await compressedCache.get(query);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.kind).toBe('Document');
      expect(retrieved?.definitions).toBeDefined();
    });

    test('should not compress small documents', async () => {
      const compressionMock = createMockRedis();
      const compressedCache = new RedisDocumentCache({
        client: compressionMock,
        prefix: 'small:',
        compress: true,
        compressionThreshold: 10000, // High threshold
      });

      const smallQuery = '{ hello }';
      const document = parse(smallQuery);

      await compressedCache.set(smallQuery, document);

      // Verify the stored data is NOT compressed
      const keys = Array.from(compressionMock.data.keys()).filter(
        (k) => k.startsWith('small:') && !k.includes('__stats__')
      );
      expect(keys.length).toBe(1);

      const storedValue = compressionMock.data.get(keys[0])?.value;
      const parsed = JSON.parse(storedValue!);
      expect(parsed.z).toBeUndefined(); // Should NOT be compressed

      // Retrieve and verify
      const retrieved = await compressedCache.get(smallQuery);
      expect(retrieved).toBeDefined();
    });
  });

  describe('corrupt entries', () => {
    test('should treat an unreadable entry as a miss and delete it', async () => {
      const errors: Array<{ error: unknown; key: string }> = [];
      const corruptMock = createMockRedis();
      const corruptCache = new RedisDocumentCache({
        client: corruptMock,
        prefix: 'corrupt:',
        onError: (error, key) => errors.push({ error, key }),
      });

      const query = '{ hello }';
      await corruptCache.set(query, parse(query));

      // Poison the stored value with invalid JSON
      const key = Array.from(corruptMock.data.keys()).find(
        (k) => k.startsWith('corrupt:') && !k.includes('__stats__')
      );
      expect(key).toBeDefined();
      corruptMock.data.set(key!, { value: 'not-json{{{' });

      // The corrupt entry reads as a normal miss
      expect(await corruptCache.get(query)).toBeNull();

      // The poisoned key is deleted so it cannot re-fail on every request
      expect(corruptMock.data.has(key!)).toBe(false);

      // The size counter stays in sync with the eviction
      expect(await corruptCache.size).toBe(0);

      // The failure surfaced through the onError hook with the offending key
      expect(errors).toHaveLength(1);
      expect(errors[0].key).toBe(key!);
      expect(errors[0].error).toBeInstanceOf(Error);
    });

    test('should stay silent by default when no onError hook is configured', async () => {
      const corruptMock = createMockRedis();
      const silentCache = new RedisDocumentCache({
        client: corruptMock,
        prefix: 'silent:',
      });

      const query = '{ hello }';
      await silentCache.set(query, parse(query));

      const key = Array.from(corruptMock.data.keys()).find(
        (k) => k.startsWith('silent:') && !k.includes('__stats__')
      );
      corruptMock.data.set(key!, { value: '\x00garbage' });

      // Must not throw — corruption is indistinguishable from a miss
      expect(await silentCache.get(query)).toBeNull();
      expect(await silentCache.getWithValidation(query)).toBeNull();
    });
  });

  describe('counter failures', () => {
    test('should report failed counter writes through onError', async () => {
      const errors: Array<{ error: unknown; key: string }> = [];
      const readOnlyMock = createMockRedis();
      readOnlyMock.incr = async () => {
        throw new Error('READONLY You cannot write against a read only replica');
      };
      readOnlyMock.incrby = async () => {
        throw new Error('READONLY You cannot write against a read only replica');
      };

      const readOnlyCache = new RedisDocumentCache({
        client: readOnlyMock,
        prefix: 'ro:',
        onError: (error, key) => errors.push({ error, key }),
      });

      // GET still succeeds, so requests look healthy while every counter
      // write is rejected — exactly the case that must not stay silent.
      await readOnlyCache.set('{ a }', parse('{ a }'));
      await readOnlyCache.get('{ a }');
      await readOnlyCache.delete('{ a }');
      await settle();

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.error instanceof Error)).toBe(true);
      expect(errors.map((e) => e.key)).toContain('ro:__stats__:size');
      expect(errors.map((e) => e.key)).toContain('ro:__stats__:hits');
    });

    test('should report non-numeric counters instead of reporting a cold cache', async () => {
      const errors: Array<{ error: unknown; key: string }> = [];
      const corruptMock = createMockRedis();
      corruptMock.data.set('bad:__stats__:size', { value: 'not-a-number' });
      corruptMock.data.set('bad:__stats__:hits', { value: 'nope' });

      const corruptCache = new RedisDocumentCache({
        client: corruptMock,
        prefix: 'bad:',
        onError: (error, key) => errors.push({ error, key }),
      });

      const stats = await corruptCache.getStats();

      expect(stats.size).toBe(0);
      expect(stats.totalHits).toBe(0);
      // The old `parseInt(v || '0', 10)` yielded NaN here
      expect(Number.isNaN(stats.hitRate)).toBe(false);
      expect(stats.hitRate).toBe(0);
      expect(errors.map((e) => e.key).sort()).toEqual([
        'bad:__stats__:hits',
        'bad:__stats__:size',
      ]);
    });

    test('should stay silent about counter failures with no onError hook', async () => {
      const readOnlyMock = createMockRedis();
      readOnlyMock.incr = async () => {
        throw new Error('READONLY');
      };

      const silentCache = new RedisDocumentCache({
        client: readOnlyMock,
        prefix: 'quiet:',
      });

      // Must not reject or produce an unhandled rejection
      await silentCache.set('{ a }', parse('{ a }'));
      await settle();
    });
  });

  describe('clear failure modes', () => {
    test('should cap the SCAN loop when the cursor never terminates', async () => {
      const loopingMock = createMockRedis();
      loopingMock.scan = async () => ['1', []] as [string, string[]];

      const loopingCache = new RedisDocumentCache({
        client: loopingMock,
        prefix: 'loop:',
      });

      await expect(loopingCache.clear()).rejects.toThrow(/SCAN iterations/);
    });

    test('should reject an unrecognised SCAN reply shape', async () => {
      const oddMock = createMockRedis();
      oddMock.scan = async () => 'nope' as unknown as [string, string[]];

      const oddCache = new RedisDocumentCache({ client: oddMock, prefix: 'odd:' });

      await expect(oddCache.clear()).rejects.toThrow(/unrecognised SCAN reply/);
    });

    test('should report progress when a mid-sweep delete fails', async () => {
      const failingMock = createMockRedis();
      failingMock.data.set('sweep:a', { value: 'x' });
      failingMock.data.set('sweep:b', { value: 'y' });

      let page = 0;
      failingMock.scan = async () =>
        (page++ === 0 ? ['1', ['sweep:a']] : ['0', ['sweep:b']]) as [string, string[]];

      const realDel = failingMock.del.bind(failingMock);
      let dels = 0;
      failingMock.del = async (key: string | string[]) => {
        if (++dels > 1) throw new Error('connection lost');
        return realDel(key);
      };

      const sweepCache = new RedisDocumentCache({
        client: failingMock,
        prefix: 'sweep:',
      });

      let thrown: unknown;
      try {
        await sweepCache.clear();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('Cache clear failed after deleting 1 keys');
      expect((thrown as Error).cause).toBeInstanceOf(Error);
    });
  });

  describe('key collisions', () => {
    const queryA = '{ user(id: "a") { id name } }';
    const queryB = '{ hello }';

    test('should never serve the entry of one query for another, even when hashes collide', async () => {
      const colliding = new RedisDocumentCache({
        client: mockRedis,
        prefix: 'test:doc:',
        hashKey: () => 'collide',
      });

      await colliding.setWithValidation(queryA, parse(queryA), { valid: true, errors: [] });

      expect(await colliding.get(queryB)).toBeNull();
      expect(await colliding.getWithValidation(queryB)).toBeNull();

      // setValidation for B must not rewrite A's entry with B's verdict
      await colliding.setValidation(queryB, { valid: false, errors: [] });
      expect((await colliding.getWithValidation(queryA))?.validation?.valid).toBe(true);
    });

    test('should key entries by SHA-256 rather than the 64-bit Bun.hash', async () => {
      const spy = spyOn(Bun, 'hash').mockImplementation(() => 1n);
      try {
        await cache.set(queryA, parse(queryA));
        await cache.set(queryB, parse(queryB));

        const keys = Array.from(mockRedis.data.keys()).filter(
          (k) => k.startsWith('test:doc:') && !k.includes('__stats__')
        );
        expect(keys.length).toBe(2);
        for (const key of keys) {
          expect(key).toMatch(/^test:doc:[0-9a-f]{64}$/);
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('createRedisCache', () => {
    test('should create a RedisDocumentCache instance', () => {
      const cache = createRedisCache({ client: mockRedis });
      expect(cache).toBeInstanceOf(RedisDocumentCache);
    });

    test('should create cache with custom config', () => {
      const cache = createRedisCache({
        client: mockRedis,
        prefix: 'custom:',
        ttl: 7200,
      });
      expect(cache).toBeInstanceOf(RedisDocumentCache);
    });
  });
});
