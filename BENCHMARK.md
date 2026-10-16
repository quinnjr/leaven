# Leaven GraphQL Performance Benchmarks

This document outlines the performance characteristics and optimizations of the Leaven GraphQL execution engine.

## Running Benchmarks

```bash
bun run packages/core/src/benchmark.ts
```

## Performance Overview

Leaven is optimized for high-throughput GraphQL execution on the Bun runtime. Key performance metrics:

| Query Type | Uncached | Cached | Cache Speedup |
|------------|----------|--------|---------------|
| Simple (`{ hello }`) | 0.058ms | **0.0015ms** | ~40x faster |
| User query | 0.075ms | **0.0036ms** | ~20x faster |
| List query (10 items) | 0.118ms | **0.015ms** | ~8x faster |
| Nested query | 0.196ms | **0.10ms** | ~2x faster |

### Throughput (Cached Queries)

| Query Type | Operations/Second |
|------------|-------------------|
| Simple query | ~680,000 ops/sec |
| User query | ~280,000 ops/sec |
| List query | ~65,000 ops/sec |
| Nested query | ~10,000 ops/sec |

## Optimizations

### 1. Validation Caching

GraphQL validation is expensive (~0.05-0.1ms per query). Leaven caches validation results alongside parsed documents, allowing subsequent executions of the same query to skip validation entirely.

```typescript
// First execution: parse + validate + execute
await executor.execute({ query: '{ users { id name } }' });

// Subsequent executions: execute only (skip parse + validate)
await executor.execute({ query: '{ users { id name } }' });
```

### 2. Collision-Safe Hashing

Long queries are keyed by SHA-256 (`Bun.CryptoHasher`). A cache hit skips
parsing and validation, so a key collision would let one query run under
another query's verdict; a 64-bit non-cryptographic hash is not safe for that.
Each entry also stores its full query and a lookup only hits on an exact
match, so a collision (or a custom `hashKey`) can only cause a miss. The
compiled-query cache, which holds complexity verdicts, is keyed by the full
query string and is never hashed.

### 3. Direct Key Optimization

For small queries (≤256 characters), the query string is used directly as the cache key, avoiding hashing overhead entirely.

```typescript
// Small query: uses query string directly as key
'{ hello }' → key: 'd:{ hello }'

// Large query: uses SHA-256
'{ users { id name email ... } }' → key: 'h:3f2a…'
```

### 4. Lazy Timing

Performance timing (`performance.now()`) is only measured when metrics are explicitly enabled:

```typescript
// No timing overhead
const executor = new LeavenExecutor({ schema });

// Timing enabled (slight overhead)
const executor = new LeavenExecutor({ schema, metrics: true });
```

### 5. Optimized Hook Execution

Lifecycle hooks check for existence before creating async contexts:

```typescript
// Before: Always creates async context
await this.hooks?.onParse?.(query);

// After: Only creates context if hook exists
if (this.hooks?.onParse) {
  await this.hooks.onParse(query);
}
```

## Benchmark Breakdown

### Parsing Performance

| Query Complexity | Time | Ops/Second |
|------------------|------|------------|
| Simple | 0.0014ms | 711,000 |
| With arguments | 0.0023ms | 430,000 |
| Nested (3 levels) | 0.0035ms | 285,000 |
| Complex (5+ types) | 0.004ms | 250,000 |

### Validation Performance

| Query Complexity | Time | Ops/Second |
|------------------|------|------------|
| Simple | 0.048ms | 21,000 |
| With arguments | 0.060ms | 16,500 |
| Nested | 0.079ms | 12,600 |
| Complex | 0.109ms | 9,100 |

### Cache Performance

| Operation | Time | Ops/Second |
|-----------|------|------------|
| Cache set | 0.019ms | 52,000 |
| Cache get (hit) | 0.0002ms | 5,000,000 |
| Cache get (miss) | 0.0002ms | 5,100,000 |

## Configuration for Performance

### Maximum Cache Performance

```typescript
import { createExecutor } from '@leaven-graphql/core';

const executor = createExecutor({
  schema,
  cache: {
    maxSize: 10000,        // Larger cache for more queries
    directKeyMaxLength: 512, // Hash fewer queries
  },
  metrics: false,          // Disable timing overhead
});
```

### Production Settings

```typescript
const executor = createExecutor({
  schema,
  cache: true,             // Enable document + validation caching
  introspection: false,    // Disable in production
  maxDepth: 10,            // Prevent deep queries
  maxComplexity: 1000,     // Prevent expensive queries
});
```

## Comparison with Other Libraries

Leaven is designed to be competitive with the fastest GraphQL execution libraries:

| Library | Simple Query | Notes |
|---------|--------------|-------|
| Leaven (cached) | ~0.0015ms | Bun-optimized, validation caching |
| graphql-js | ~0.05ms | Reference implementation |
| Mercurius | ~0.02ms | Fastify-optimized |

*Note: Benchmarks are environment-dependent. Run your own tests for accurate comparisons.*

## Redis Cache

For distributed deployments, Leaven supports Redis as a cache backend:

```typescript
import { createExecutor, createRedisCache } from '@leaven-graphql/core';
import Redis from 'ioredis';

const redis = new Redis();

const executor = createExecutor({
  schema,
  cache: createRedisCache({
    client: redis,
    prefix: 'gql:doc:',
    ttl: 3600,           // 1 hour TTL
    compress: true,      // Enable gzip compression
    compressionThreshold: 1024, // Compress documents > 1KB
  }),
});
```

### Redis Cache Features

- **Distributed caching**: Share cache across multiple server instances
- **TTL support**: Automatic expiration handled by Redis
- **Compression**: Optional gzip compression for large documents
- **Validation caching**: Stores validation results alongside documents

### Redis Cache Performance

| Operation | Time |
|-----------|------|
| Cache set | ~1-2ms (network dependent) |
| Cache get (hit) | ~0.5-1ms (network dependent) |
| Compression overhead | ~0.1ms for 10KB document |

*Note: Redis performance depends heavily on network latency and Redis server configuration.*

## Memory Usage

The in-memory document cache uses an LRU eviction strategy to manage memory:

```typescript
const executor = createExecutor({
  schema,
  cache: {
    maxSize: 1000,   // Maximum cached documents
    ttl: 3600000,    // 1 hour TTL (optional)
    lru: true,       // LRU eviction (default)
  },
});
```

Cache statistics are available at runtime:

```typescript
const stats = executor.getCacheStats();
// {
//   document: { size: 150, maxSize: 1000, hitRate: 0.95, totalHits: 15000 },
//   compiled: { size: 50 }
// }
```

## Best Practices

1. **Enable caching** - Always use `cache: true` in production
2. **Reuse executors** - Create one executor per schema, not per request
3. **Limit query complexity** - Use `maxDepth` and `maxComplexity`
4. **Disable introspection** - Set `introspection: false` in production
5. **Monitor cache stats** - Track hit rates to tune cache size

## Test Environment

Benchmarks were run on:
- **Runtime**: Bun 1.3.5
- **OS**: Linux (WSL2)
- **Architecture**: x64

Results will vary based on hardware, query complexity, and schema size.
