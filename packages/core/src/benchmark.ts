/**
 * @leaven-graphql/core - Performance benchmarks
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID,
} from 'graphql';

import { LeavenExecutor } from './executor';
import { parseDocument, validateDocument } from './parser';
import { DocumentCache } from './cache';

// Create a realistic test schema
const UserType: GraphQLObjectType = new GraphQLObjectType({
  name: 'User',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    email: { type: GraphQLString },
    age: { type: GraphQLInt },
    friends: {
      type: new GraphQLList(UserType),
      resolve: () => generateUsers(5),
    },
    posts: {
      type: new GraphQLList(PostType),
      resolve: () => generatePosts(10),
    },
  }),
});

const PostType = new GraphQLObjectType({
  name: 'Post',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    content: { type: GraphQLString },
    author: {
      type: UserType,
      resolve: () => generateUsers(1)[0],
    },
  }),
});

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: {
        type: GraphQLString,
        resolve: () => 'Hello, World!',
      },
      user: {
        type: UserType,
        args: { id: { type: new GraphQLNonNull(GraphQLID) } },
        resolve: (_, { id }) => ({ id, name: `User ${id}`, email: `user${id}@example.com`, age: 25 }),
      },
      users: {
        type: new GraphQLList(UserType),
        args: { limit: { type: GraphQLInt } },
        resolve: (_, { limit = 10 }) => generateUsers(limit),
      },
      posts: {
        type: new GraphQLList(PostType),
        args: { limit: { type: GraphQLInt } },
        resolve: (_, { limit = 10 }) => generatePosts(limit),
      },
    },
  }),
});

function generateUsers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    name: `User ${i + 1}`,
    email: `user${i + 1}@example.com`,
    age: 20 + (i % 50),
  }));
}

function generatePosts(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    title: `Post ${i + 1}`,
    content: `Content for post ${i + 1}`,
  }));
}

// Test queries
const SIMPLE_QUERY = '{ hello }';
const USER_QUERY = '{ user(id: "1") { id name email } }';
const LIST_QUERY = '{ users(limit: 10) { id name email age } }';
const NESTED_QUERY = `{
  users(limit: 5) {
    id
    name
    friends {
      id
      name
    }
    posts {
      id
      title
      author {
        id
        name
      }
    }
  }
}`;
const COMPLEX_QUERY = `{
  users(limit: 10) {
    id
    name
    email
    age
    friends {
      id
      name
      email
      friends {
        id
        name
      }
    }
    posts {
      id
      title
      content
      author {
        id
        name
        email
      }
    }
  }
}`;

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  opsPerSecond: number;
}

async function benchmark(
  name: string,
  fn: () => unknown | Promise<unknown>,
  iterations: number = 1000
): Promise<BenchmarkResult> {
  // Warmup
  for (let i = 0; i < Math.min(100, iterations / 10); i++) {
    await fn();
  }

  let sumTime = 0;
  let minTime = Infinity;
  let maxTime = -Infinity;
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    const iterStart = performance.now();
    await fn();
    const elapsed = performance.now() - iterStart;
    sumTime += elapsed;
    if (elapsed < minTime) minTime = elapsed;
    if (elapsed > maxTime) maxTime = elapsed;
  }

  const totalTime = performance.now() - start;
  // Average of the measured iteration times, excluding the timing
  // bookkeeping itself, which would otherwise inflate sub-microsecond cases.
  const avgTime = sumTime / iterations;

  return {
    name,
    iterations,
    totalTime,
    avgTime,
    minTime,
    maxTime,
    opsPerSecond: 1000 / avgTime,
  };
}

function formatResult(result: BenchmarkResult): string {
  return [
    `${result.name}:`,
    `  Iterations: ${result.iterations.toLocaleString()}`,
    `  Total time: ${result.totalTime.toFixed(2)}ms`,
    `  Avg time: ${result.avgTime.toFixed(4)}ms`,
    `  Min/Max: ${result.minTime.toFixed(4)}ms / ${result.maxTime.toFixed(4)}ms`,
    `  Ops/sec: ${Number(result.opsPerSecond.toFixed(0)).toLocaleString()}`,
  ].join('\n');
}

async function runBenchmarks() {
  console.log('='.repeat(60));
  console.log('LEAVEN GRAPHQL PERFORMANCE BENCHMARKS');
  console.log('='.repeat(60));
  console.log();

  const results: BenchmarkResult[] = [];

  // 1. Parse benchmarks
  console.log('📝 PARSING BENCHMARKS');
  console.log('-'.repeat(40));

  results.push(await benchmark('Parse simple query', () => parseDocument(SIMPLE_QUERY), 10000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Parse user query', () => parseDocument(USER_QUERY), 10000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Parse nested query', () => parseDocument(NESTED_QUERY), 5000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Parse complex query', () => parseDocument(COMPLEX_QUERY), 5000));
  console.log(formatResult(results[results.length - 1]));
  console.log();

  // 2. Validation benchmarks
  console.log('✅ VALIDATION BENCHMARKS');
  console.log('-'.repeat(40));

  const simpleDoc = parseDocument(SIMPLE_QUERY);
  const userDoc = parseDocument(USER_QUERY);
  const nestedDoc = parseDocument(NESTED_QUERY);
  const complexDoc = parseDocument(COMPLEX_QUERY);

  results.push(await benchmark('Validate simple query', () => validateDocument(schema, simpleDoc), 10000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Validate user query', () => validateDocument(schema, userDoc), 10000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Validate nested query', () => validateDocument(schema, nestedDoc), 5000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Validate complex query', () => validateDocument(schema, complexDoc), 5000));
  console.log(formatResult(results[results.length - 1]));
  console.log();

  // 3. Cache benchmarks
  console.log('💾 CACHE BENCHMARKS');
  console.log('-'.repeat(40));

  const cache = new DocumentCache({ maxSize: 1000 });

  results.push(await benchmark('Cache set', () => {
    const key = `query_${Math.random()}`;
    cache.set(key, simpleDoc);
  }, 10000));
  console.log(formatResult(results[results.length - 1]));

  cache.set(SIMPLE_QUERY, simpleDoc);
  results.push(await benchmark('Cache get (hit)', () => cache.get(SIMPLE_QUERY), 10000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Cache get (miss)', () => cache.get('nonexistent_query'), 10000));
  console.log(formatResult(results[results.length - 1]));
  console.log();

  // 4. Executor benchmarks (without cache)
  console.log('⚡ EXECUTOR BENCHMARKS (no cache)');
  console.log('-'.repeat(40));

  const executorNoCache = new LeavenExecutor({ schema, cache: false });

  results.push(await benchmark('Execute simple query', () => executorNoCache.execute({ query: SIMPLE_QUERY }), 5000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Execute user query', () => executorNoCache.execute({ query: USER_QUERY }), 5000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Execute list query', () => executorNoCache.execute({ query: LIST_QUERY }), 2000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Execute nested query', () => executorNoCache.execute({ query: NESTED_QUERY }), 1000));
  console.log(formatResult(results[results.length - 1]));
  console.log();

  // 5. Executor benchmarks (with cache)
  console.log('🚀 EXECUTOR BENCHMARKS (with cache)');
  console.log('-'.repeat(40));

  const executorWithCache = new LeavenExecutor({ schema, cache: true });

  // Prime the cache
  await executorWithCache.execute({ query: SIMPLE_QUERY });
  await executorWithCache.execute({ query: USER_QUERY });
  await executorWithCache.execute({ query: LIST_QUERY });
  await executorWithCache.execute({ query: NESTED_QUERY });

  results.push(await benchmark('Execute simple (cached)', () => executorWithCache.execute({ query: SIMPLE_QUERY }), 5000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Execute user (cached)', () => executorWithCache.execute({ query: USER_QUERY }), 5000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Execute list (cached)', () => executorWithCache.execute({ query: LIST_QUERY }), 2000));
  console.log(formatResult(results[results.length - 1]));

  results.push(await benchmark('Execute nested (cached)', () => executorWithCache.execute({ query: NESTED_QUERY }), 1000));
  console.log(formatResult(results[results.length - 1]));
  console.log();

  // Summary
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log();

  const cacheStats = await executorWithCache.getCacheStats();
  console.log('Cache Stats:', cacheStats);
  console.log();

  // Calculate speedup from caching
  const noCacheSimple = results.find(r => r.name === 'Execute simple query')!;
  const cachedSimple = results.find(r => r.name === 'Execute simple (cached)')!;
  const speedup = noCacheSimple.avgTime / cachedSimple.avgTime;
  console.log(`Cache speedup (simple query): ${speedup.toFixed(2)}x faster`);

  const noCacheNested = results.find(r => r.name === 'Execute nested query')!;
  const cachedNested = results.find(r => r.name === 'Execute nested (cached)')!;
  const nestedSpeedup = noCacheNested.avgTime / cachedNested.avgTime;
  console.log(`Cache speedup (nested query): ${nestedSpeedup.toFixed(2)}x faster`);

  console.log();
  console.log('📊 PERFORMANCE IMPROVEMENTS:');
  console.log('-'.repeat(40));
  console.log('✓ Validation caching: Skip GraphQL validation for cached documents');
  console.log('✓ Collision-safe keys: SHA-256 for long queries, verified on lookup');
  console.log('✓ Direct keys: Small queries use string directly (no hashing)');
  console.log('✓ Lazy timing: Only measure performance when metrics enabled');
  console.log('✓ Optimized hooks: Check existence before async calls');
  console.log();
  console.log(`Simple query throughput: ${cachedSimple.opsPerSecond.toLocaleString()} ops/sec`);
  console.log(`User query throughput: ${results.find(r => r.name === 'Execute user (cached)')!.opsPerSecond.toLocaleString()} ops/sec`);
  console.log(`List query throughput: ${results.find(r => r.name === 'Execute list (cached)')!.opsPerSecond.toLocaleString()} ops/sec`);
  console.log(`Nested query throughput: ${cachedNested.opsPerSecond.toLocaleString()} ops/sec`);
}

// Export for use in other benchmarks
export {
  schema,
  SIMPLE_QUERY,
  USER_QUERY,
  LIST_QUERY,
  NESTED_QUERY,
  COMPLEX_QUERY,
  benchmark,
  formatResult,
};

// Run if executed directly
if (import.meta.main) {
  runBenchmarks().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
