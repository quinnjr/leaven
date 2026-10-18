/**
 * @leaven-graphql/core - Executor tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import {
  buildSchema,
  getIntrospectionQuery,
  parse,
  GraphQLError,
  type GraphQLFormattedError,
} from 'graphql';
import {
  ComplexityError,
  ErrorCode,
  RateLimitError,
} from '@leaven-graphql/errors';
import { LeavenExecutor, createExecutor } from './executor';
import type { GraphQLResponse } from './types';
import { DocumentCache, AST_BYTES_PER_QUERY_CHAR, type IDocumentCache } from './cache';

const schema = buildSchema(`
  type Query {
    hello: String
    user(id: ID!): User
    error: String
  }
  type Mutation {
    createUser(name: String!): User
  }
  type Subscription {
    countdown(from: Int!): Int
    failing: Int
  }
  type User {
    id: ID!
    name: String
  }
`);

const rootValue = {
  hello: () => 'Hello, World!',
  user: ({ id }: { id: string }) => ({ id, name: 'Test User' }),
  createUser: ({ name }: { name: string }) => ({ id: '1', name }),
  error: () => {
    throw new Error('Test error');
  },
  countdown: async function* ({ from }: { from: number }) {
    for (let i = from; i >= 0; i--) {
      yield { countdown: i };
      await new Promise((r) => setTimeout(r, 10));
    }
  },
  failing: () => {
    throw new Error('Subscribe failed');
  },
};

describe('LeavenExecutor', () => {
  let executor: LeavenExecutor;

  beforeEach(() => {
    executor = new LeavenExecutor({ schema, rootValue });
  });

  describe('constructor', () => {
    test('should create executor with schema', () => {
      expect(executor).toBeDefined();
      expect(executor.getSchema()).toBe(schema);
    });

    test('should create executor with cache disabled', () => {
      const noCacheExecutor = new LeavenExecutor({
        schema,
        rootValue,
        cache: false,
      });
      expect(noCacheExecutor).toBeDefined();
    });

    test('should create executor with custom cache config', () => {
      const customCacheExecutor = new LeavenExecutor({
        schema,
        rootValue,
        cache: { maxSize: 100, ttl: 60000 },
      });
      expect(customCacheExecutor).toBeDefined();
    });
  });

  describe('execute', () => {
    test('should execute a simple query', async () => {
      const result = await executor.execute({ query: '{ hello }' });

      expect(result.response.data).toEqual({ hello: 'Hello, World!' });
      expect(result.response.errors).toBeUndefined();
    });

    test('should execute query with variables', async () => {
      const result = await executor.execute({
        query: 'query GetUser($id: ID!) { user(id: $id) { id name } }',
        variables: { id: '123' },
      });

      expect(result.response.data).toEqual({
        user: { id: '123', name: 'Test User' },
      });
    });

    test('should return validation errors', async () => {
      const result = await executor.execute({ query: '{ nonexistent }' });

      expect(result.response.errors).toBeDefined();
      expect(result.response.errors!.length).toBeGreaterThan(0);
    });

    test('should handle execution errors', async () => {
      const result = await executor.execute({ query: '{ error }' });

      expect(result.response.errors).toBeDefined();
      expect(result.response.errors![0]?.message).toBe('Test error');
    });

    test('should execute mutations', async () => {
      const result = await executor.execute({
        query: 'mutation { createUser(name: "John") { id name } }',
      });

      expect(result.response.data).toEqual({
        createUser: { id: '1', name: 'John' },
      });
    });

    test('should use cache for repeated queries', async () => {
      // Execute twice
      await executor.execute({ query: '{ hello }' });
      const result = await executor.execute({ query: '{ hello }' });

      expect(result.response.data).toEqual({ hello: 'Hello, World!' });
    });

    test('should not echo client extensions into the response', async () => {
      const result = await executor.execute({
        query: '{ hello }',
        extensions: { clientData: 'echo-me' },
      });

      expect(result.response.data).toEqual({ hello: 'Hello, World!' });
      expect(result.response.extensions).toBeUndefined();
    });

    test('should include context in execution', async () => {
      const contextExecutor = new LeavenExecutor({
        schema: buildSchema(`
          type Query {
            currentUser: String
          }
        `),
        rootValue: {
          currentUser: (_: unknown, context: { userId: string }) =>
            context.userId,
        },
      });

      const result = await contextExecutor.execute(
        { query: '{ currentUser }' },
        { userId: 'user-123' }
      );

      expect(result.response.data).toEqual({ currentUser: 'user-123' });
    });
  });

  describe('execute with metrics', () => {
    test('should include metrics when enabled', async () => {
      const metricsExecutor = new LeavenExecutor({
        schema,
        rootValue,
        metrics: true,
      });

      const result = await metricsExecutor.execute({ query: '{ hello }' });

      expect(result.metrics).toBeDefined();
      expect(result.metrics?.timing.totalTime).toBeGreaterThan(0);
    });

    test('should track document cache hits', async () => {
      const metricsExecutor = new LeavenExecutor({
        schema,
        rootValue,
        metrics: true,
      });

      await metricsExecutor.execute({ query: '{ hello }' });
      const result = await metricsExecutor.execute({ query: '{ hello }' });

      expect(result.metrics?.documentCached).toBe(true);
    });

    test('should report a consistent metrics shape on validation failure', async () => {
      const metricsExecutor = new LeavenExecutor({
        schema,
        rootValue,
        metrics: true,
      });

      const result = await metricsExecutor.execute({ query: '{ nonexistent }' });

      expect(result.metrics).toBeDefined();
      expect(result.metrics?.documentCached).toBe(false);
      expect(result.metrics?.validationCached).toBe(false);
      expect(result.metrics?.queryCached).toBe(false);
    });
  });

  describe('execute with introspection control', () => {
    test('should reject introspection queries when disabled', async () => {
      const noIntrospectionExecutor = new LeavenExecutor({
        schema,
        rootValue,
        introspection: false,
      });

      const result = await noIntrospectionExecutor.execute({
        query: '{ __schema { types { name } } }',
      });

      expect(result.response.data).toBeUndefined();
      expect(result.response.errors).toBeDefined();
      expect(result.response.errors!.length).toBeGreaterThan(0);
    });

    test('should allow introspection queries when enabled', async () => {
      const introspectionExecutor = new LeavenExecutor({
        schema,
        rootValue,
        introspection: true,
      });

      const result = await introspectionExecutor.execute({
        query: '{ __schema { types { name } } }',
      });

      expect(result.response.errors).toBeUndefined();
      expect(result.response.data).toBeDefined();
    });
  });

  describe('execute with complexity limits', () => {
    test('should reject queries exceeding max complexity', async () => {
      const limitedExecutor = new LeavenExecutor({
        schema,
        rootValue,
        compilerOptions: { calculateComplexity: true },
        maxComplexity: 1,
      });

      const result = await limitedExecutor.execute({
        query: '{ user(id: "1") { id name } }',
      });

      expect(result.response.errors).toBeDefined();
      expect(result.response.errors![0]?.message).toContain('complexity');
      // Without a code the HTTP layer cannot map the rejection and falls
      // through to a 500
      expect(result.response.errors![0]?.extensions?.code).toBe(
        ErrorCode.COMPLEXITY_LIMIT
      );
      expect(result.response.errors![0]?.extensions?.maxComplexity).toBe(1);
    });

    test('should enforce maxComplexity without explicit compilerOptions', async () => {
      const limitedExecutor = new LeavenExecutor({
        schema,
        rootValue,
        maxComplexity: 1,
      });

      const result = await limitedExecutor.execute({
        query: '{ user(id: "1") { id name } }',
      });

      expect(result.response.errors).toBeDefined();
      expect(result.response.errors![0]?.message).toContain('complexity');
      expect(result.response.errors![0]?.extensions?.code).toBe(
        ErrorCode.COMPLEXITY_LIMIT
      );
    });

    test('should treat maxComplexity: 0 as a limit that rejects everything', async () => {
      const zeroExecutor = new LeavenExecutor({
        schema,
        rootValue,
        maxComplexity: 0,
      });

      const result = await zeroExecutor.execute({ query: '{ hello }' });

      expect(result.response.data).toBeUndefined();
      expect(result.response.errors![0]?.message).toContain('complexity');
      expect(result.response.errors![0]?.extensions?.code).toBe(
        ErrorCode.COMPLEXITY_LIMIT
      );
    });
  });

  describe('compiled query cache identity', () => {
    test('should not reuse the complexity of a cheap query for another on hash collision', async () => {
      const limited = new LeavenExecutor({
        schema,
        rootValue,
        cache: false,
        maxComplexity: 2,
      });

      // Force any 64-bit Bun.hash-derived key to collide
      const spy = spyOn(Bun, 'hash').mockImplementation(() => 1n);
      try {
        const cheap = await limited.execute({ query: '{ hello }' });
        expect(cheap.response.errors).toBeUndefined();

        const expensive = await limited.execute({
          query: '{ a: hello b: hello c: hello d: hello e: hello }',
        });
        expect(expensive.response.data).toBeUndefined();
        expect(expensive.response.errors?.[0]?.extensions?.code).toBe(
          ErrorCode.COMPLEXITY_LIMIT
        );
      } finally {
        spy.mockRestore();
      }
    });

    test('should not confuse query/operationName pairs that concatenate identically', async () => {
      const limited = new LeavenExecutor({
        schema,
        rootValue,
        cache: false,
        maxComplexity: 2,
      });

      // `${query}:${operationName}` used to make these two requests share a key
      const first = await limited.execute({ query: 'query A { hello }', operationName: 'A' });
      expect(first.response.errors).toBeUndefined();

      const second = await limited.execute({
        query: 'query A { hello }:A',
      });
      // A syntax error, not a cached compiled plan
      expect(second.response.errors?.[0]?.message).toMatch(/Syntax Error/);
    });
  });

  describe('operation selection errors', () => {
    const compiled = new LeavenExecutor({ schema, rootValue, compilerOptions: {} });
    const plain = new LeavenExecutor({ schema, rootValue });

    for (const [label, executor] of [
      ['without the compiler', plain],
      ['with the compiler', compiled],
    ] as const) {
      test(`should report an unknown operation name as BAD_REQUEST ${label}`, async () => {
        const result = await executor.execute({
          query: 'query A { hello }',
          operationName: 'B',
        });

        expect(result.response.data).toBeUndefined();
        expect(result.response.errors).toEqual([
          { message: 'Unknown operation named "B".', extensions: { code: ErrorCode.BAD_REQUEST } },
        ]);
      });

      test(`should report a missing operation name as BAD_REQUEST ${label}`, async () => {
        const result = await executor.execute({ query: 'query A { hello } query B { hello }' });

        expect(result.response.errors).toEqual([
          {
            message: 'Must provide operation name if query contains multiple operations.',
            extensions: { code: ErrorCode.BAD_REQUEST },
          },
        ]);
      });
    }

    test('should report an unknown operation name on subscribe as BAD_REQUEST', async () => {
      const result = await plain.subscribe({
        query: 'subscription A { countdown(from: 1) }',
        operationName: 'B',
      });

      expect(Symbol.asyncIterator in result).toBe(false);
      expect((result as GraphQLResponse).errors?.[0]?.extensions?.code).toBe(ErrorCode.BAD_REQUEST);
      expect((result as GraphQLResponse).errors?.[0]?.message).toBe(
        'Unknown operation named "B".'
      );
    });

    test('should escape a client operation name in the error text', async () => {
      const result = await plain.execute({
        query: 'query A { hello }',
        operationName: 'Evil\r\nINFO forged',
      });

      expect(result.response.errors?.[0]?.message).toBe(
        'Unknown operation named "Evil\\r\\nINFO forged".'
      );
    });

    test('should not call onError for an operation selection error', async () => {
      let called = false;
      const hooked = new LeavenExecutor({
        schema,
        rootValue,
        hooks: {
          onError: () => {
            called = true;
          },
        },
      });

      await hooked.execute({ query: 'query A { hello }', operationName: 'B' });

      expect(called).toBe(false);
    });
  });

  describe('execute with depth limits', () => {
    test('should treat maxDepth: 0 as a limit that rejects everything', async () => {
      const zeroExecutor = new LeavenExecutor({ schema, rootValue, maxDepth: 0 });

      const result = await zeroExecutor.execute({ query: '{ hello }' });

      expect(result.response.data).toBeUndefined();
      expect(result.response.errors![0]?.message).toMatch(
        /exceeds maximum allowed depth/
      );
      expect(result.response.errors![0]?.extensions?.code).toBe('DEPTH_LIMIT');
    });

    test('should accept getIntrospectionQuery() under maxDepth 10 with maxIntrospectionDepth 20', async () => {
      const executor = new LeavenExecutor({
        schema,
        rootValue,
        maxDepth: 10,
        maxIntrospectionDepth: 20,
      });

      const result = await executor.execute({ query: getIntrospectionQuery() });

      expect(result.response.errors).toBeUndefined();
      expect(result.response.data).toHaveProperty('__schema');
    });

    test('should reject getIntrospectionQuery() under maxIntrospectionDepth 5', async () => {
      const executor = new LeavenExecutor({
        schema,
        rootValue,
        maxDepth: 10,
        maxIntrospectionDepth: 5,
      });

      const result = await executor.execute({ query: getIntrospectionQuery() });

      expect(result.response.data).toBeUndefined();
      expect(result.response.errors![0]?.extensions?.code).toBe(ErrorCode.DEPTH_LIMIT);
      expect(result.response.errors![0]?.extensions?.limit).toBe('maxIntrospectionDepth');
    });

    test('should keep counting introspection against maxDepth when maxIntrospectionDepth is unset', async () => {
      const executor = new LeavenExecutor({ schema, rootValue, maxDepth: 10 });

      const result = await executor.execute({ query: getIntrospectionQuery() });

      expect(result.response.errors![0]?.extensions?.code).toBe(ErrorCode.DEPTH_LIMIT);
    });

    test('should let maxIntrospectionDepth override parseOptions.maxIntrospectionDepth', async () => {
      const executor = new LeavenExecutor({
        schema,
        rootValue,
        maxDepth: 10,
        maxIntrospectionDepth: 20,
        parseOptions: { maxIntrospectionDepth: 1 },
      });

      const result = await executor.execute({ query: getIntrospectionQuery() });

      expect(result.response.errors).toBeUndefined();
    });

    test('should not serve a document cached under a looser maxIntrospectionDepth', async () => {
      const sharedCache = new DocumentCache();
      const query = getIntrospectionQuery();
      const permissive = new LeavenExecutor({
        schema,
        rootValue,
        cache: sharedCache,
        maxDepth: 10,
        maxIntrospectionDepth: 20,
      });
      const strict = new LeavenExecutor({
        schema,
        rootValue,
        cache: sharedCache,
        maxDepth: 10,
        maxIntrospectionDepth: 5,
      });

      expect((await permissive.execute({ query })).response.errors).toBeUndefined();

      const denied = await strict.execute({ query });
      expect(denied.response.data).toBeUndefined();
      expect(denied.response.errors![0]?.extensions?.limit).toBe('maxIntrospectionDepth');
    });

    test('should honour parseOptions.maxDepth when no executor maxDepth is set', async () => {
      const limitedExecutor = new LeavenExecutor({
        schema,
        rootValue,
        parseOptions: { maxDepth: 1 },
      });

      const result = await limitedExecutor.execute({
        query: '{ user(id: "1") { id } }',
      });

      expect(result.response.errors![0]?.message).toMatch(
        /exceeds maximum allowed depth/
      );
    });
  });

  describe('validation cache identity', () => {
    const introspectionQuery = '{ __schema { types { name } } }';

    test('should not share validation verdicts across different rule sets', async () => {
      // Both executors share one cache, as two processes sharing one Redis do
      const sharedCache = new DocumentCache();

      const permissive = new LeavenExecutor({
        schema,
        rootValue,
        introspection: true,
        cache: sharedCache,
      });
      const restricted = new LeavenExecutor({
        schema,
        rootValue,
        introspection: false,
        cache: sharedCache,
      });

      const allowed = await permissive.execute({ query: introspectionQuery });
      expect(allowed.response.errors).toBeUndefined();

      // The restricted executor must re-validate rather than reuse the cached
      // "valid" verdict, or the whole schema leaks through the shared cache.
      const denied = await restricted.execute({ query: introspectionQuery });
      expect(denied.response.data).toBeUndefined();
      expect(denied.response.errors).toBeDefined();
      expect(denied.response.errors!.length).toBeGreaterThan(0);
    });

    test('should not share validation verdicts across different schemas', async () => {
      const sharedCache = new DocumentCache();
      const query = '{ hello }';

      const withHello = new LeavenExecutor({ schema, rootValue, cache: sharedCache });
      const withoutHello = new LeavenExecutor({
        schema: buildSchema('type Query { goodbye: String }'),
        cache: sharedCache,
      });

      const valid = await withHello.execute({ query });
      expect(valid.response.errors).toBeUndefined();

      // A document validated against schema A must not execute unvalidated
      // against schema B.
      const invalid = await withoutHello.execute({ query });
      expect(invalid.response.errors).toBeDefined();
      expect(invalid.response.errors!.length).toBeGreaterThan(0);
    });

    test('should still reuse a cached verdict within one executor', async () => {
      const metricsExecutor = new LeavenExecutor({
        schema,
        rootValue,
        metrics: true,
      });

      await metricsExecutor.execute({ query: '{ hello }' });
      const result = await metricsExecutor.execute({ query: '{ hello }' });

      expect(result.metrics?.validationCached).toBe(true);
    });

    test('should not serve a permissively parsed document to a stricter maxDepth', async () => {
      // Two executors sharing one cache, as two processes sharing one Redis do
      const sharedCache = new DocumentCache();
      const deepQuery = '{ user(id: "1") { id } }';

      const permissive = new LeavenExecutor({
        schema,
        rootValue,
        maxDepth: 100,
        cache: sharedCache,
      });
      const strict = new LeavenExecutor({
        schema,
        rootValue,
        maxDepth: 1,
        cache: sharedCache,
      });

      const allowed = await permissive.execute({ query: deepQuery });
      expect(allowed.response.errors).toBeUndefined();

      // A cache hit skips parsing, and the depth check only runs at parse
      // time — so without the parser options in the cache key the strict
      // executor's depth limit silently stops applying.
      const denied = await strict.execute({ query: deepQuery });
      expect(denied.response.data).toBeUndefined();
      expect(denied.response.errors![0]?.message).toMatch(
        /exceeds maximum allowed depth/
      );
      expect(denied.response.errors![0]?.extensions?.code).toBe(
        ErrorCode.DEPTH_LIMIT
      );
    });

    test('should not serve a document parsed under different parseOptions', async () => {
      const sharedCache = new DocumentCache();
      const query = '{ user(id: "1") { id name } }';

      const permissive = new LeavenExecutor({
        schema,
        rootValue,
        parseOptions: { maxTokens: 1000 },
        cache: sharedCache,
      });
      const strict = new LeavenExecutor({
        schema,
        rootValue,
        parseOptions: { maxTokens: 3 },
        cache: sharedCache,
      });

      expect((await permissive.execute({ query })).response.errors).toBeUndefined();

      const denied = await strict.execute({ query });
      expect(denied.response.data).toBeUndefined();
      expect(denied.response.errors![0]?.message).toMatch(/token/i);
    });

    test('should share a cache entry between identically configured executors', async () => {
      const sharedCache = new DocumentCache();
      const config = {
        schema,
        rootValue,
        cache: sharedCache,
        metrics: true,
        maxDepth: 10,
        // Property order must not matter to the fingerprint
        parseOptions: { maxTokens: 500, maxDepth: 10 },
      };

      const first = new LeavenExecutor(config);
      const second = new LeavenExecutor({
        ...config,
        parseOptions: { maxDepth: 10, maxTokens: 500 },
      });

      await first.execute({ query: '{ hello }' });
      const result = await second.execute({ query: '{ hello }' });

      expect(result.metrics?.documentCached).toBe(true);
      expect(result.metrics?.validationCached).toBe(true);
    });
  });

  describe('cold-query cache writes', () => {
    test('should store document and verdict in a single setWithValidation call', async () => {
      const calls: string[] = [];
      const backing = new DocumentCache();

      const recordingCache: IDocumentCache = {
        get: (q) => backing.get(q),
        set: (q, d) => {
          calls.push('set');
          backing.set(q, d);
        },
        getWithValidation: (q) => backing.getWithValidation(q),
        setValidation: (q, v) => {
          calls.push('setValidation');
          backing.setValidation(q, v);
        },
        setWithValidation: (q, d, v) => {
          calls.push('setWithValidation');
          backing.setWithValidation(q, d, v);
        },
        has: (q) => backing.has(q),
        delete: (q) => backing.delete(q),
        clear: () => backing.clear(),
        get size() {
          return backing.size;
        },
        getStats: () => backing.getStats(),
      };

      const recordingExecutor = new LeavenExecutor({
        schema,
        rootValue,
        cache: recordingCache,
        metrics: true,
      });

      const cold = await recordingExecutor.execute({ query: '{ hello }' });
      expect(cold.response.data).toEqual({ hello: 'Hello, World!' });

      // One write, not set() + setValidation(): on Redis the two-call form is
      // SET + GET + TTL + SET and re-serializes the document already in hand.
      expect(calls).toEqual(['setWithValidation']);

      // ...and the single write really did persist the verdict
      const warm = await recordingExecutor.execute({ query: '{ hello }' });
      expect(warm.metrics?.documentCached).toBe(true);
      expect(warm.metrics?.validationCached).toBe(true);
      expect(calls).toEqual(['setWithValidation']);
    });
  });

  describe('invalid document caching', () => {
    test('should not cache a document that fails validation', async () => {
      const cache = new DocumentCache();
      const strict = new LeavenExecutor({ schema, rootValue, cache });

      const result = await strict.execute({ query: '{ doesNotExist }' });
      expect(result.response.errors).toBeDefined();

      // Junk queries must not be able to fill (and evict real entries from)
      // the document cache.
      expect(cache.size).toBe(0);
    });

    test('should still cache a document that passes validation', async () => {
      const cache = new DocumentCache();
      const strict = new LeavenExecutor({ schema, rootValue, cache });

      await strict.execute({ query: '{ hello }' });
      expect(cache.size).toBe(1);
    });

    test('should not attach an invalid verdict to an already cached document', async () => {
      const writes: string[] = [];
      // A backend holding the document but no verdict, as `set()` leaves it
      const documentOnly: IDocumentCache = {
        get: () => null,
        set: () => undefined,
        getWithValidation: (key) => ({
          document: parse(key.slice(key.indexOf('\x00') + 1)),
        }),
        setValidation: () => {
          writes.push('setValidation');
        },
        setWithValidation: () => {
          writes.push('setWithValidation');
        },
        has: () => false,
        delete: () => false,
        clear: () => undefined,
        size: 0,
        getStats: () => ({ size: 0, maxSize: 0, hitRate: 0, totalHits: 0, entries: 0 }),
      };

      const recorder = new LeavenExecutor({ schema, rootValue, cache: documentOnly });
      const result = await recorder.execute({ query: '{ doesNotExist }' });
      expect(result.response.errors).toBeDefined();
      expect(writes).toEqual([]);

      // A valid document still gets its verdict recorded
      await recorder.execute({ query: '{ hello }' });
      expect(writes).toEqual(['setValidation']);
    });
  });

  describe('caching only after every check passes', () => {
    /** Entries in the executor's private compiled-query cache */
    const compiledCount = (executor: LeavenExecutor): number =>
      (executor as unknown as { compiledQueries: { size: number } }).compiledQueries.size;

    const limited = (cache: IDocumentCache): LeavenExecutor =>
      new LeavenExecutor({ schema, rootValue, cache, maxComplexity: 2, maxDepth: 3 });

    test('should cache neither the document nor the plan of an invalid query', async () => {
      const cache = new DocumentCache();
      const executor = limited(cache);

      const result = await executor.execute({ query: '{ doesNotExist }' });
      expect(result.response.errors).toBeDefined();

      expect(cache.size).toBe(0);
      expect(compiledCount(executor)).toBe(0);
    });

    test('should cache neither the document nor the plan of an over-complexity query', async () => {
      const cache = new DocumentCache();
      const executor = limited(cache);

      const result = await executor.execute({
        query: '{ a: hello b: hello c: hello d: hello e: hello }',
      });
      expect(result.response.errors?.[0]?.extensions?.code).toBe(ErrorCode.COMPLEXITY_LIMIT);

      expect(cache.size).toBe(0);
      expect(compiledCount(executor)).toBe(0);
    });

    test('should reject an over-complexity query again on repeat, still uncached', async () => {
      const cache = new DocumentCache();
      const executor = limited(cache);
      const query = '{ a: hello b: hello c: hello d: hello e: hello }';

      for (let i = 0; i < 3; i++) {
        const result = await executor.execute({ query });
        expect(result.response.errors?.[0]?.extensions?.code).toBe(ErrorCode.COMPLEXITY_LIMIT);
      }
      expect(cache.size).toBe(0);
      expect(compiledCount(executor)).toBe(0);
    });

    test('should cache neither the document nor the plan of an over-depth query', async () => {
      const cache = new DocumentCache();
      const executor = new LeavenExecutor({ schema, rootValue, cache, maxComplexity: 100, maxDepth: 1 });

      const result = await executor.execute({ query: '{ user(id: "1") { id } }' });
      expect(result.response.errors).toBeDefined();

      expect(cache.size).toBe(0);
      expect(compiledCount(executor)).toBe(0);
    });

    test('should not attach a verdict to a cached document when complexity fails', async () => {
      const writes: string[] = [];
      const documentOnly: IDocumentCache = {
        get: () => null,
        set: () => undefined,
        getWithValidation: (key) => ({
          document: parse(key.slice(key.indexOf('\x00') + 1)),
        }),
        setValidation: () => {
          writes.push('setValidation');
        },
        setWithValidation: () => {
          writes.push('setWithValidation');
        },
        has: () => false,
        delete: () => false,
        clear: () => undefined,
        size: 0,
        getStats: () => ({ size: 0, maxSize: 0, hitRate: 0, totalHits: 0, entries: 0 }),
      };
      const executor = limited(documentOnly);

      await executor.execute({ query: '{ a: hello b: hello c: hello d: hello e: hello }' });
      expect(writes).toEqual([]);
      expect(compiledCount(executor)).toBe(0);
    });

    test('should cache both once a query passes validation and complexity', async () => {
      const cache = new DocumentCache();
      const executor = limited(cache);

      const result = await executor.execute({ query: '{ hello }' });
      expect(result.response.errors).toBeUndefined();

      expect(cache.size).toBe(1);
      expect(compiledCount(executor)).toBe(1);
    });

    test('should not create entries for an operationName the document lacks', async () => {
      const executor = limited(new DocumentCache());

      for (let i = 0; i < 20; i++) {
        const result = await executor.execute({
          query: 'query A { hello }',
          operationName: `Nope${i}`,
        });
        expect(result.response.errors).toBeDefined();
      }
      expect(compiledCount(executor)).toBe(0);
    });

    test('should not create entries when no operation can be selected', async () => {
      const executor = limited(new DocumentCache());

      const result = await executor.execute({ query: 'query A { hello } query B { hello }' });
      expect(result.response.errors).toBeDefined();
      expect(compiledCount(executor)).toBe(0);
    });

    test('should share one entry between a named and an implicit selection of one operation', async () => {
      const executor = limited(new DocumentCache());

      await executor.execute({ query: 'query A { hello }', operationName: 'A' });
      await executor.execute({ query: 'query A { hello }' });
      const third = await executor.execute({ query: 'query A { hello }', operationName: 'A' });

      expect(third.response.errors).toBeUndefined();
      expect(compiledCount(executor)).toBe(1);
    });

    test('should keep separate entries for different operations of one document', async () => {
      const executor = limited(new DocumentCache());
      const query = 'query A { hello } query B { b: hello }';

      const a = await executor.execute({ query, operationName: 'A' });
      const b = await executor.execute({ query, operationName: 'B' });

      expect(a.response.data).toEqual({ hello: 'Hello, World!' });
      expect(b.response.data).toEqual({ b: 'Hello, World!' });
      expect(compiledCount(executor)).toBe(2);
    });

    test('should not cache the plan of a query above the per-entry byte cap', async () => {
      const executor = limited(new DocumentCache());
      const padding = '#'.padEnd(
        Math.ceil(LeavenExecutor.MAX_COMPILED_BYTES / 10 / AST_BYTES_PER_QUERY_CHAR),
        'x'
      );

      const result = await executor.execute({ query: `{ hello }\n${padding}` });
      expect(result.response.errors).toBeUndefined();
      expect(compiledCount(executor)).toBe(0);
    });

    test('should report compiled-cache bytes and limits', async () => {
      const executor = limited(new DocumentCache());
      await executor.execute({ query: '{ hello }' });

      const { compiled } = await executor.getCacheStats();
      expect(compiled.size).toBe(1);
      expect(compiled.maxSize).toBe(1000);
      expect(compiled.bytes).toBe('{ hello }'.length * AST_BYTES_PER_QUERY_CHAR);
      expect(compiled.maxBytes).toBe(32 * 1024 * 1024);
    });

    test('should apply the same rule to subscriptions', async () => {
      const cache = new DocumentCache();
      const executor = new LeavenExecutor({ schema, rootValue, cache, maxComplexity: 0 });

      const result = await executor.subscribe({ query: 'subscription { countdown(from: 1) }' });
      expect((result as GraphQLResponse).errors?.[0]?.extensions?.code).toBe(
        ErrorCode.COMPLEXITY_LIMIT
      );
      expect(cache.size).toBe(0);
      expect(compiledCount(executor)).toBe(0);
    });
  });

  describe('caught error formatting', () => {
    /** Force the executor's catch path by throwing from a lifecycle hook */
    const executorThrowing = (error: unknown): LeavenExecutor =>
      new LeavenExecutor({
        schema,
        rootValue,
        hooks: {
          onParse: () => {
            throw error;
          },
        },
      });

    test('should preserve a LeavenError subclass extensions', async () => {
      const result = await executorThrowing(
        new RateLimitError('Too many requests', { retryAfter: 30 })
      ).execute({ query: '{ hello }' });

      const error = result.response.errors![0];
      expect(error?.message).toBe('Too many requests');
      expect(error?.extensions?.code).toBe(ErrorCode.RATE_LIMITED);
      // The detail that makes the error actionable must survive
      expect(error?.extensions?.retryAfter).toBe(30);
    });

    test('should preserve a ComplexityError limits', async () => {
      const result = await executorThrowing(new ComplexityError(120, 50)).execute({
        query: '{ hello }',
      });

      const error = result.response.errors![0];
      expect(error?.extensions?.code).toBe(ErrorCode.COMPLEXITY_LIMIT);
      expect(error?.extensions?.complexity).toBe(120);
      expect(error?.extensions?.maxComplexity).toBe(50);
    });

    test('should fall back to INTERNAL_ERROR for a plain Error', async () => {
      const result = await executorThrowing(new Error('boom')).execute({
        query: '{ hello }',
      });

      const error = result.response.errors![0];
      expect(error?.message).toBe('boom');
      expect(error?.extensions?.code).toBe(ErrorCode.INTERNAL_ERROR);
    });

    test('should fall back to INTERNAL_ERROR for a non-Error throw', async () => {
      const result = await executorThrowing('not an error').execute({
        query: '{ hello }',
      });

      const error = result.response.errors![0];
      expect(error?.message).toBe('Internal server error');
      expect(error?.extensions?.code).toBe(ErrorCode.INTERNAL_ERROR);
    });
  });

  describe('formatExecutionError', () => {
    /**
     * A framework-style exception: it carries no `extensions`, so graphql-js
     * has nothing to adopt and the serialized error would be codeless. This is
     * exactly the case (a NestJS `HttpException`) the hook exists for.
     */
    class HttpishException extends Error {
      public constructor(
        message: string,
        public readonly status: number
      ) {
        super(message);
        this.name = 'HttpishException';
      }
    }

    const throwingSchema = buildSchema(`
      type Query { boom: String }
      type Subscription { ticks: Tick, failing: Int }
      type Tick { boom: String }
    `);

    const throwingRoot = {
      boom: () => {
        throw new HttpishException('Forbidden resource', 403);
      },
      failing: () => {
        throw new HttpishException('Forbidden resource', 403);
      },
      ticks: async function* () {
        yield {
          ticks: {
            boom: () => {
              throw new HttpishException('Forbidden resource', 403);
            },
          },
        };
      },
    };

    /** Maps the framework exception the way a transport driver would. */
    const formatExecutionError = (error: GraphQLError): GraphQLFormattedError => {
      const formatted = error.toJSON();
      const original = error.originalError;
      if (!(original instanceof HttpishException)) {
        return formatted;
      }
      return {
        ...formatted,
        extensions: { ...formatted.extensions, code: ErrorCode.FORBIDDEN },
      };
    };

    test('should receive a GraphQLError whose originalError is intact', async () => {
      const seen: GraphQLError[] = [];

      const result = await new LeavenExecutor({
        schema: throwingSchema,
        rootValue: throwingRoot,
        formatExecutionError: (error) => {
          seen.push(error);
          return error.toJSON();
        },
      }).execute({ query: '{ boom }' });

      expect(result.response.errors).toHaveLength(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(GraphQLError);
      expect(seen[0]?.originalError).toBeInstanceOf(HttpishException);
      expect((seen[0]?.originalError as HttpishException).status).toBe(403);
      // The detail the hook exists to recover: `path` is still there too.
      expect(seen[0]?.path).toEqual(['boom']);
    });

    test("should use the hook's return value in the response", async () => {
      const result = await new LeavenExecutor({
        schema: throwingSchema,
        rootValue: throwingRoot,
        formatExecutionError,
      }).execute({ query: '{ boom }' });

      const error = result.response.errors![0];
      expect(error?.message).toBe('Forbidden resource');
      expect(error?.extensions?.code).toBe(ErrorCode.FORBIDDEN);
      expect(error?.path).toEqual(['boom']);
    });

    test('should leave the response unchanged when no hook is configured', async () => {
      const result = await new LeavenExecutor({
        schema: throwingSchema,
        rootValue: throwingRoot,
      }).execute({ query: '{ boom }' });

      const error = result.response.errors![0];
      expect(error?.message).toBe('Forbidden resource');
      // Without the hook the framework exception is codeless — the very
      // limitation the hook works around.
      expect(error?.extensions?.code).toBeUndefined();
    });

    test('should apply to a subscription that fails before streaming', async () => {
      const result = await new LeavenExecutor({
        schema: throwingSchema,
        rootValue: throwingRoot,
        formatExecutionError,
      }).subscribe({ query: 'subscription { failing }' });

      expect(Symbol.asyncIterator in result).toBe(false);
      const response = result as GraphQLResponse;
      expect(response.errors![0]?.extensions?.code).toBe(ErrorCode.FORBIDDEN);
    });

    test('should apply to errors carried by a streamed subscription payload', async () => {
      const result = await new LeavenExecutor({
        schema: throwingSchema,
        rootValue: throwingRoot,
        formatExecutionError,
      }).subscribe({ query: 'subscription { ticks { boom } }' });

      expect(Symbol.asyncIterator in result).toBe(true);
      const iterator = result as AsyncIterableIterator<GraphQLResponse>;
      const { value } = await iterator.next();

      expect(value.errors![0]?.message).toBe('Forbidden resource');
      expect(value.errors![0]?.extensions?.code).toBe(ErrorCode.FORBIDDEN);
      await iterator.return?.();
    });

    test('should not be applied to validation errors', async () => {
      let called = 0;

      const result = await new LeavenExecutor({
        schema: throwingSchema,
        rootValue: throwingRoot,
        formatExecutionError: (error) => {
          called += 1;
          return error.toJSON();
        },
      }).execute({ query: '{ nonexistent }' });

      expect(result.response.errors!.length).toBeGreaterThan(0);
      expect(called).toBe(0);
    });
  });

  describe('execute with hooks', () => {
    test('should call lifecycle hooks', async () => {
      const hookCalls: string[] = [];

      const hookedExecutor = new LeavenExecutor({
        schema,
        rootValue,
        hooks: {
          onParse: () => {
            hookCalls.push('onParse');
          },
          onParsed: () => {
            hookCalls.push('onParsed');
          },
          onValidate: () => {
            hookCalls.push('onValidate');
          },
          onValidated: () => {
            hookCalls.push('onValidated');
          },
          onExecute: () => {
            hookCalls.push('onExecute');
          },
          onExecuted: () => {
            hookCalls.push('onExecuted');
          },
        },
      });

      await hookedExecutor.execute({ query: '{ hello }' });

      expect(hookCalls).toContain('onParse');
      expect(hookCalls).toContain('onParsed');
      expect(hookCalls).toContain('onValidate');
      expect(hookCalls).toContain('onValidated');
      expect(hookCalls).toContain('onExecute');
      expect(hookCalls).toContain('onExecuted');
    });

    test('should call onError hook when the operation itself fails', async () => {
      const caught: Error[] = [];
      const thrown = new Error('pipeline exploded');

      const hookedExecutor = new LeavenExecutor({
        schema,
        rootValue,
        hooks: {
          // Throwing from onParse drives the executor's catch path, the same
          // way a syntax error or a depth-limit rejection does
          onParse: () => {
            throw thrown;
          },
          onError: (error) => {
            caught.push(error);
          },
        },
      });

      const result = await hookedExecutor.execute({ query: '{ hello }' });

      expect(caught).toEqual([thrown]);
      expect(result.response.errors![0]?.message).toBe('pipeline exploded');
    });

    test('should NOT call onError hook for resolver-level errors', async () => {
      const caught: Error[] = [];

      const hookedExecutor = new LeavenExecutor({
        schema,
        rootValue,
        hooks: {
          onError: (error) => {
            caught.push(error);
          },
        },
      });

      const result = await hookedExecutor.execute({ query: '{ error }' });

      // graphql-js collects resolver failures into the result rather than
      // throwing, so the request never reaches the executor's catch path.
      // Documented on ExecutionHooks.onError — observe these via onExecuted.
      expect(result.response.errors![0]?.message).toBe('Test error');
      expect(caught).toEqual([]);
    });
  });

  describe('getCacheStats', () => {
    test('should return cache statistics', async () => {
      await executor.execute({ query: '{ hello }' });

      const stats = await executor.getCacheStats();

      expect(stats.document).toBeDefined();
      expect(stats.compiled).toBeDefined();
      expect(stats.compiled.maxSize).toBe(1000);
    });
  });

  describe('cache error handling', () => {
    test('should report cache write failures via onCacheError without failing the request', async () => {
      const cacheErrors: Error[] = [];

      const failingCache: IDocumentCache = {
        get: () => null,
        set: () => Promise.reject(new Error('cache write failed')),
        getWithValidation: () => null,
        setValidation: () => Promise.reject(new Error('cache write failed')),
        setWithValidation: () => Promise.reject(new Error('cache write failed')),
        has: () => false,
        delete: () => false,
        clear: () => {},
        size: 0,
        getStats: () => ({
          size: 0,
          maxSize: 0,
          hitRate: 0,
          totalHits: 0,
          entries: 0,
        }),
      };

      const failingCacheExecutor = new LeavenExecutor({
        schema,
        rootValue,
        cache: failingCache,
        hooks: {
          onCacheError: (error) => {
            cacheErrors.push(error);
          },
        },
      });

      const result = await failingCacheExecutor.execute({ query: '{ hello }' });

      expect(result.response.data).toEqual({ hello: 'Hello, World!' });
      expect(result.response.errors).toBeUndefined();

      // Cache writes are fire-and-forget; give the rejections a tick to surface
      await new Promise((r) => setTimeout(r, 0));
      expect(cacheErrors.length).toBeGreaterThan(0);
      expect(cacheErrors[0]?.message).toBe('cache write failed');
    });
  });

  describe('clearCaches', () => {
    test('should clear all caches', async () => {
      await executor.execute({ query: '{ hello }' });
      await executor.clearCaches();

      const stats = await executor.getCacheStats();
      expect(stats.document?.size).toBe(0);
      expect(stats.compiled.size).toBe(0);
    });
  });

  describe('getSchema', () => {
    test('should return the schema', () => {
      expect(executor.getSchema()).toBe(schema);
    });
  });

  describe('parse', () => {
    test('should parse a query', async () => {
      const document = await executor.parse('{ hello }');
      expect(document.kind).toBe('Document');
    });

    test('should apply the configured parse limits', async () => {
      const limited = new LeavenExecutor({ schema, rootValue, parseOptions: { maxTokens: 3 } });
      await expect(limited.parse('{ hello hello hello }')).rejects.toThrow(/tokens/i);
    });

    test('should apply maxDepth', async () => {
      const limited = new LeavenExecutor({ schema, rootValue, maxDepth: 1 });
      await expect(limited.parse('{ user(id: "1") { id } }')).rejects.toThrow(/depth/i);
    });

    test('should reuse a cached document without writing to the cache', async () => {
      const cache = new DocumentCache();
      const cached = new LeavenExecutor({ schema, rootValue, cache });

      await cached.parse('{ hello }');
      expect(cache.size).toBe(0);

      await cached.execute({ query: '{ hello }' });
      const getSpy = spyOn(cache, 'get');
      await cached.parse('{ hello }');
      expect(getSpy.mock.results[0]?.value).not.toBeNull();
      getSpy.mockRestore();
    });
  });

  describe('subscribe', () => {
    test('should handle subscriptions', async () => {
      const result = await executor.subscribe({
        query: 'subscription { countdown(from: 2) }',
      });

      // A valid subscription must produce an async iterator, not an error result
      expect(Symbol.asyncIterator in result).toBe(true);

      const iterator = result as AsyncIterableIterator<{ data?: unknown }>;
      const values: number[] = [];

      for await (const value of iterator) {
        if (value.data) {
          values.push((value.data as { countdown: number }).countdown);
        }
        if (values.length >= 3) break;
      }

      expect(values.length).toBeGreaterThan(0);
    });

    test('should return an error response when the subscribe resolver throws', async () => {
      const result = await executor.subscribe({
        query: 'subscription { failing }',
      });

      // Must be a GraphQLResponse, not an async iterator
      expect(Symbol.asyncIterator in result).toBe(false);

      const response = result as GraphQLResponse;
      expect(response.errors).toBeDefined();
      expect(response.errors!.length).toBeGreaterThan(0);
      expect(response.errors![0]?.message).toBe('Subscribe failed');
    });

    test('should return errors for invalid subscription', async () => {
      const result = await executor.subscribe({
        query: 'subscription { nonexistent }',
      });

      expect(result).toHaveProperty('errors');
    });

    test('should support iterator return method', async () => {
      const result = await executor.subscribe({
        query: 'subscription { countdown(from: 5) }',
      });

      // A valid subscription must produce an async iterator, not an error result
      expect(Symbol.asyncIterator in result).toBe(true);

      const iterator = result as AsyncIterableIterator<{ data?: unknown }>;

      // Get one value then return
      await iterator.next();
      const returnResult = await iterator.return?.();

      expect(returnResult?.done).toBe(true);
    });

    test('should support iterator throw method', async () => {
      const result = await executor.subscribe({
        query: 'subscription { countdown(from: 5) }',
      });

      // A valid subscription must produce an async iterator, not an error result
      expect(Symbol.asyncIterator in result).toBe(true);

      const iterator = result as AsyncIterableIterator<{ data?: unknown }>;

      // Get one value then throw
      await iterator.next();

      // The throw method may propagate the error, so we wrap in try-catch
      try {
        const throwResult = await iterator.throw?.(new Error('Test error'));
        expect(throwResult?.done).toBe(true);
      } catch {
        // Some implementations may throw the error
        // The important thing is that the iterator is closed
        const nextResult = await iterator.next();
        expect(nextResult.done).toBe(true);
      }
    });

    test('should enforce maxComplexity on subscriptions', async () => {
      const zeroExecutor = new LeavenExecutor({
        schema,
        rootValue,
        maxComplexity: 0,
      });

      const result = await zeroExecutor.subscribe({
        query: 'subscription { countdown(from: 2) }',
      });

      // Subscriptions are the longest-lived operations; an unenforced budget
      // here is the worst place for a gap
      expect(Symbol.asyncIterator in result).toBe(false);

      const response = result as GraphQLResponse;
      expect(response.errors![0]?.message).toContain('complexity');
      expect(response.errors![0]?.extensions?.code).toBe(
        ErrorCode.COMPLEXITY_LIMIT
      );
    });

    test('should return, not throw, when a subscription exceeds maxDepth', async () => {
      const shallowExecutor = new LeavenExecutor({ schema, rootValue, maxDepth: 0 });

      // The declared return type is `iterator | GraphQLResponse`; a caller
      // branching on `Symbol.asyncIterator in result` must never be handed a
      // rejected promise instead.
      const result = await shallowExecutor.subscribe({
        query: 'subscription { countdown(from: 2) }',
      });

      expect(Symbol.asyncIterator in result).toBe(false);

      const response = result as GraphQLResponse;
      expect(response.errors![0]?.message).toMatch(/exceeds maximum allowed depth/);
      expect(response.errors![0]?.extensions?.code).toBe(ErrorCode.DEPTH_LIMIT);
    });

    test('should return, not throw, on a subscription syntax error', async () => {
      const result = await executor.subscribe({ query: 'subscription {' });

      expect(Symbol.asyncIterator in result).toBe(false);
      expect((result as GraphQLResponse).errors!.length).toBeGreaterThan(0);
    });

    test('should run lifecycle hooks for subscriptions', async () => {
      const hookCalls: string[] = [];

      const hookedExecutor = new LeavenExecutor({
        schema,
        rootValue,
        hooks: {
          onParse: () => {
            hookCalls.push('onParse');
          },
          onParsed: () => {
            hookCalls.push('onParsed');
          },
          onValidate: () => {
            hookCalls.push('onValidate');
          },
          onValidated: () => {
            hookCalls.push('onValidated');
          },
          onExecute: () => {
            hookCalls.push('onExecute');
          },
        },
      });

      const result = await hookedExecutor.subscribe({
        query: 'subscription { countdown(from: 1) }',
      });
      await (result as AsyncIterableIterator<unknown>).return?.();

      expect(hookCalls).toEqual([
        'onParse',
        'onParsed',
        'onValidate',
        'onValidated',
        'onExecute',
      ]);
    });

    test('should report a throwing hook through onError instead of rejecting', async () => {
      const caught: Error[] = [];

      const hookedExecutor = new LeavenExecutor({
        schema,
        rootValue,
        hooks: {
          onParse: () => {
            throw new RateLimitError('Too many subscriptions', { retryAfter: 5 });
          },
          onError: (error) => {
            caught.push(error);
          },
        },
      });

      const result = await hookedExecutor.subscribe({
        query: 'subscription { countdown(from: 1) }',
      });

      expect(Symbol.asyncIterator in result).toBe(false);

      const response = result as GraphQLResponse;
      expect(response.errors![0]?.extensions?.code).toBe(ErrorCode.RATE_LIMITED);
      expect(response.errors![0]?.extensions?.retryAfter).toBe(5);
      expect(caught.length).toBe(1);
    });
  });
});

describe('createExecutor', () => {
  test('should create a LeavenExecutor', () => {
    const executor = createExecutor({ schema });
    expect(executor).toBeInstanceOf(LeavenExecutor);
  });
});
