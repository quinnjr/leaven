# @leaven-graphql/core

The core GraphQL execution engine for Leaven - a high-performance GraphQL library for Bun.

## Installation

```bash
bun add @leaven-graphql/core graphql
```

## Quick Start

```typescript
import { LeavenExecutor } from '@leaven-graphql/core';
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from 'graphql';

// Create a simple schema
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: {
        type: GraphQLString,
        resolve: () => 'Hello, world!',
      },
    },
  }),
});

// Create the executor
const executor = new LeavenExecutor({
  schema,
  cache: true,
});

// Execute a query
const result = await executor.execute({
  query: '{ hello }',
});

console.log(result.response.data);
// { hello: "Hello, world!" }
```

## Features

### Document Caching

Cache parsed documents and validation results for improved performance:

```typescript
const executor = new LeavenExecutor({
  schema,
  cache: {
    maxSize: 1000,      // Maximum cached documents
    maxBytes: 32 << 20, // Estimated memory budget (default: 32 MiB)
    ttl: 3600000,       // TTL in milliseconds (1 hour)
  },
});

// Check cache statistics (async — a Redis-backed cache answers over the wire)
const stats = await executor.getCacheStats();
console.log(stats);
// {
//   document: {
//     size: 42,        // entries currently cached
//     maxSize: 1000,
//     hitRate: 3.71,   // AVERAGE HITS PER ENTRY, not a hit/miss ratio
//     totalHits: 156,
//     entries: 42,     // alias for `size`
//     bytes: 2_016_000, // estimated retained bytes
//     maxBytes: 33_554_432
//   },
//   compiled: { size: 38, maxSize: 1000 }
// }
```

`stats.document` is `null` when the executor was created with `cache: false`.

**Memory is bounded, not just entry count.** Each entry is estimated at
`query.length * AST_BYTES_PER_QUERY_CHAR` (300) bytes: a parsed document with
graphql-js location info retains roughly 50-140 bytes per character of
pretty-printed query text and up to ~280 for minified text, so 300 errs high.
Least recently used entries are evicted whenever `maxSize` or `maxBytes` would
be exceeded, and a single entry estimated above `maxBytes / 10` (about 11,000
characters at the 32 MiB default) is never cached, so one oversized query
cannot flush the cache. Raise `maxBytes` if you rely on caching larger
documents.

**`hitRate` is not a percentage.** It is `totalHits / size` — the average number
of times each cached entry has been reused. Misses are not tracked at all, so
the value is unbounded and routinely exceeds `1` on a warm cache.

Only documents that pass validation are cached, so rejected queries cannot
fill the cache. Queries longer than `directKeyMaxLength` (default 256) are
keyed by SHA-256; every entry also keeps its full query and a lookup only hits
on an exact match, so a key collision is a miss, never another query's
document or verdict. Pass `hashKey` to `DocumentCache` or `createRedisCache`
to replace the hash. The compiled-query cache, which holds complexity
results, is keyed by the full query string and operation name.

`size` (and its alias `entries`) is exact for the in-memory cache. The Redis
cache maintains it as a counter updated on writes and deletes and cannot
observe server-side TTL expirations, so there it is an upper bound that drifts
upward.

### Redis Cache (Distributed)

For distributed deployments, use Redis as a cache backend:

```typescript
import { LeavenExecutor, createRedisCache } from '@leaven-graphql/core';
import Redis from 'ioredis';

const redis = new Redis();

const executor = new LeavenExecutor({
  schema,
  cache: createRedisCache({
    client: redis,
    prefix: 'gql:doc:',     // Redis key prefix
    ttl: 3600,              // TTL in seconds
    compress: true,         // Enable gzip compression
    compressionThreshold: 1024, // Compress documents > 1KB
    trackHits: false,       // Skip the per-hit INCR on a hot deployment
  }),
});
```

The Redis cache supports:
- **Distributed caching** across multiple server instances
- **Automatic TTL** handled by Redis
- **Gzip compression** for large documents
- **Validation caching** for faster repeated queries

### Lifecycle Hooks

Hook into the execution lifecycle:

```typescript
const executor = new LeavenExecutor({
  schema,
  hooks: {
    onParse(query) {
      console.log('Parsing query:', query);
    },
    onValidated(result) {
      if (!result.valid) {
        console.error('Validation errors:', result.errors);
      }
    },
    // `context` is your context value, typed by the executor's type
    // parameter — it is not the GraphQL request, so operation details come
    // from the document.
    async onExecute(context, document) {
      console.log('Executing:', document.definitions.length, 'definition(s)');
    },
    async onExecuted(result) {
      console.log('Execution completed');
    },
    onError(error) {
      console.error('Execution error:', error);
    },
  },
});
```

`subscribe` runs the same hooks up to and including `onExecute`. It does not
call `onExecuted`, because a subscription yields a stream rather than one
response.

`onError` fires when the operation itself fails — a parse error, a
depth/token/complexity rejection, or anything thrown by an earlier hook. It
does **not** fire for resolver-level errors: graphql-js collects those into
`result.errors` and returns a normal (possibly partial) response. Inspect
`result.errors` in `onExecuted` to observe them.

### Execution Metrics

Track execution performance:

```typescript
const executor = new LeavenExecutor({
  schema,
  metrics: true,
});

const result = await executor.execute({ query: '{ users { name } }' });

console.log(result.metrics);
// {
//   timing: {
//     parseTime: 0.5,
//     validationTime: 1.2,
//     executionTime: 3.8,
//     totalTime: 5.5
//   },
//   documentCached: true,
//   validationCached: true,
//   queryCached: false
// }
```

### Context Support

Pass context to resolvers:

```typescript
interface AppContext {
  user: User | null;
  db: Database;
}

const result = await executor.execute<QueryData>(
  { query: '{ me { name } }' },
  {
    user: authenticatedUser,
    db: databaseConnection,
  }
);
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schema` | `GraphQLSchema` | Required | Your GraphQL schema |
| `rootValue` | `unknown` | `undefined` | Root resolver value |
| `cache` | `DocumentCacheConfig \| boolean \| IDocumentCache` | `true` | Document cache configuration or custom cache |
| `parseOptions` | `ParseOptions` | `{}` | Parser options: `maxDepth`, `maxTokens`, and raw `graphqlOptions` |
| `compilerOptions` | `CompilerOptions` | `undefined` | Query compiler options |
| `maxDepth` | `number` | `undefined` | Maximum query depth (overrides `parseOptions.maxDepth`) |
| `maxComplexity` | `number` | `undefined` | Maximum query complexity (implies `compilerOptions.calculateComplexity`) |
| `hooks` | `ExecutionHooks` | `undefined` | Lifecycle hooks |
| `metrics` | `boolean` | `false` | Enable execution metrics (reported by `execute` only) |
| `introspection` | `boolean` | `true` | Enable introspection queries |
| `formatExecutionError` | `(error: GraphQLError) => GraphQLFormattedError` | `error.toJSON()` | Serialize an execution error while the graphql-js `GraphQLError` is still intact |

`maxDepth`, `maxComplexity` and `hooks` apply to subscriptions as well as
queries and mutations — `execute` and `subscribe` share one
parse/validate/compile pipeline.

### `formatExecutionError`

The executor otherwise reports execution errors as `error.toJSON()`, which emits
only `{ message, locations, path, extensions }` and **drops `originalError`**.
That loss matters for a transport built on a framework with its own error
currency: graphql-js sets `extensions = extensions ?? originalError?.extensions
?? {}`, so a `LeavenError` (which carries `extensions`) survives serialization
with its `code`, but a framework exception with no `extensions` property — a
NestJS `HttpException`, say — arrives with `extensions: {}` and is
indistinguishable from a crash. This hook runs *before* `toJSON()`, so it is the
only place such an error can still be recognised and mapped to an `ErrorCode`.

```typescript
import { LeavenExecutor } from '@leaven-graphql/core';

const executor = new LeavenExecutor({
  schema,
  formatExecutionError: (error) => {
    const cause = error.originalError;
    if (cause instanceof HttpException) {
      return {
        message: cause.message,
        path: error.path,
        locations: error.locations,
        extensions: { ...error.extensions, code: codeForStatus(cause.getStatus()) },
      };
    }
    return error.toJSON();
  },
});
```

It applies to the errors of an execution result and of both subscription paths —
the places where a resolver's `originalError` exists. It is deliberately *not*
applied to parse, validation or complexity rejections, which are synthesised by
Leaven, never carry a framework `originalError`, and already guarantee an
`ErrorCode`; nor to an error thrown out of the executor itself, which the errors
package formats.

Do not confuse it with a transport's `formatError` option (for example
`LeavenModuleOptions.formatError`), which is a final, response-level pass over an
already-serialized `GraphQLFormattedError`. `formatExecutionError` is
executor-level and receives the live `GraphQLError`.

## API Reference

### LeavenExecutor

The main executor class.

```typescript
class LeavenExecutor {
  constructor(config: ExecutorConfig);

  // Execute a query or mutation
  execute<TData = Record<string, unknown>, TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext
  ): Promise<ExecutionResult<TData>>;

  // Start a subscription. Resolves to an async iterator on success, or to a
  // GraphQLResponse carrying `errors` on any failure — it never rejects.
  subscribe<TData = Record<string, unknown>, TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext
  ): Promise<SubscriptionIterator<TData> | GraphQLResponse<TData>>;

  // Document and compiled-query cache statistics
  getCacheStats(): Promise<{
    document: CacheStats | null;
    compiled: { size: number; maxSize: number };
  }>;

  // Clear both the document cache and the compiled-query cache
  clearCaches(): Promise<void>;

  // The schema this executor was built with
  getSchema(): GraphQLSchema;

  // Parse under this executor's limits (maxTokens, maxDepth), reusing a
  // cached document; never writes to the cache
  parse(query: string): Promise<DocumentNode>;
}
```

Parsing and validation are internal to `execute`/`subscribe`. A transport
that must inspect a document first (to choose between them, say) should use
`executor.parse(query)` so the configured parse limits still apply. To do
both yourself, use the standalone `parseDocument(query, options)` and
`validateDocument(schema, document, options)` exports.

### GraphQLRequest

```typescript
interface GraphQLRequest {
  query: string;
  operationName?: string;
  variables?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}
```

### ExecutionResult

```typescript
interface ExecutionResult<TData = Record<string, unknown>> {
  response: GraphQLResponse<TData>;
  metrics?: ExecutionMetrics;
}

interface GraphQLResponse<TData = Record<string, unknown>> {
  data?: TData | null;
  // Already formatted for the wire — spec-shaped plain objects, not
  // GraphQLError instances
  errors?: readonly GraphQLFormattedError[];
  extensions?: Record<string, unknown>;
}
```

Rejections carry a machine-readable `extensions.code` from
`@leaven-graphql/errors` — `DEPTH_LIMIT`, `COMPLEXITY_LIMIT`, `RATE_LIMITED`,
`INTERNAL_ERROR` and so on — which the HTTP layer maps to a status code.

### CacheStats

```typescript
interface CacheStats {
  // Exact in memory; an upward-drifting upper bound on Redis, which cannot
  // observe TTL expirations
  size: number;
  maxSize: number;
  // Average hits per entry (totalHits / size) — NOT a hit/miss ratio
  hitRate: number;
  totalHits: number;
  // Alias for `size`
  entries: number;
  // Estimated retained bytes and the configured budget; reported by the
  // in-memory DocumentCache, omitted by backends that cannot estimate them
  bytes?: number;
  maxBytes?: number;
}
```

## License

Apache 2.0 - Joseph Quinn
