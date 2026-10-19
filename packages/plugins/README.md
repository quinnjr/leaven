# @leaven-graphql/plugins

Plugin system for extending Leaven with caching, logging, tracing, and more.

## Installation

```bash
bun add @leaven-graphql/plugins
```

## Quick Start

> **Wiring is manual today.** `ExecutorConfig` has no `plugins` option, and no
> package in Leaven — core, http, ws, or nestjs — dispatches plugin hooks for
> you. To run plugins you construct a `PluginManager` yourself and call its
> hooks around `executor.execute`, as shown below.

```typescript
import { parse } from 'graphql';
import { LeavenExecutor, type GraphQLRequest } from '@leaven-graphql/core';
import {
  createPluginManager,
  createLoggingPlugin,
  createDepthLimitPlugin,
} from '@leaven-graphql/plugins';

const executor = new LeavenExecutor({ schema });

const plugins = createPluginManager({
  schema,
  plugins: [
    createLoggingPlugin({ level: 'info' }),
    createDepthLimitPlugin({ maxDepth: 10 }),
  ],
});

// Optional: run the deferred `onRegister` hooks up front so initialization
// failures surface here instead of on the first request.
await plugins.init();

async function handleRequest(request: GraphQLRequest, context: unknown) {
  const pluginContext = plugins.createContext(request, context);

  try {
    const query = await plugins.beforeParse(request.query, pluginContext);
    const document = await plugins.afterParse(parse(query), pluginContext);

    // A `beforeExecute` hook may return a response to short-circuit execution
    // (this is how the caching plugin serves a hit).
    const cached = await plugins.beforeExecute(document, pluginContext);
    if (cached) {
      return await plugins.afterExecute(cached, pluginContext);
    }

    const { response } = await executor.execute({ ...request, query }, context);
    return await plugins.afterExecute(response, pluginContext);
  } catch (error) {
    throw await plugins.onError(error as Error, pluginContext);
  }
}
```

Two caveats of this arrangement:

- `LeavenExecutor.execute` parses and validates internally, so the document you
  hand to `afterParse` is parsed a second time by the executor. Hooks that
  *rewrite* the document (`afterParse` returning a new `DocumentNode`) cannot
  reach the executor this way; hooks that *inspect and reject* it — depth limit,
  complexity — work exactly as intended.
- `beforeValidate` / `afterValidate` are only dispatched if you validate the
  document yourself. The pipeline above skips them.

## Built-in Plugins

### Logging Plugin

```typescript
import { createLoggingPlugin } from '@leaven-graphql/plugins';

const loggingPlugin = createLoggingPlugin({
  // Minimum severity to emit (default: 'info')
  level: 'info',
  // Any object with debug/info/warn/error methods (default: console)
  logger: console,
});
```

`level` is the only filter; there are no options for including variables or
results. Messages are emitted with a structured payload as the second argument:

```typescript
// level: 'debug' — before execution
logger.debug('Executing GraphQL operation', {
  operationName: 'getUser',
  query: '{ user(id: "1") { name } }',
});

// level: 'info' or lower — after a successful execution
logger.info('GraphQL operation completed', {
  operationName: 'getUser',
  duration: '15.23ms',
});

// `duration` is 'unknown' when beforeExecute did not run, for example when
// an earlier plugin short-circuited execution with a cached response

// after an execution that produced errors
logger.error('GraphQL operation completed with errors', {
  operationName: 'getUser',
  duration: '15.23ms',
  errors: [/* ... */],
});

// from the onError hook
logger.error('GraphQL operation failed', {
  operationName: 'getUser',
  error: 'Something went wrong',
});
```

### Tracing Plugin

```typescript
import { createTracingPlugin } from '@leaven-graphql/plugins';

const tracingPlugin = createTracingPlugin();
```

Takes no options. It measures each phase from its own hooks, so a phase whose
hooks were never dispatched is omitted rather than reported as a false zero.
Durations and offsets are nanoseconds, Apollo Tracing style:

```typescript
// {
//   extensions: {
//     tracing: {
//       version: 1,
//       startTime: '2026-01-01T12:00:00.000Z',
//       endTime: '2026-01-01T12:00:00.015Z',
//       duration: 15000000,
//       parsing: { startOffset: 1000, duration: 250000 },
//       validation: { startOffset: 260000, duration: 400000 },
//       execution: { startOffset: 680000, duration: 14300000 },
//     },
//   },
// }
```

### Depth Limit Plugin

```typescript
import { createDepthLimitPlugin } from '@leaven-graphql/plugins';

// Bare number form
const depthLimitPlugin = createDepthLimitPlugin(10);

// Equivalent options-object form
const alsoDepthLimit = createDepthLimitPlugin({ maxDepth: 10 });
```

`maxDepth` is the only setting — there is no `ignoreIntrospection`. Only field
selections add a level of depth. Fragment spreads are resolved through their
definitions and each fragment is measured once per document, so repeated spreads
cannot fan out exponentially and recursive fragments terminate.

Throws `DepthLimitError` (HTTP 400, `extensions.code: 'DEPTH_LIMIT'`) when a
query is too deep, or when analyzing the document would exceed the 100,000-node
analysis budget (`extensions.reason: 'ANALYSIS_BUDGET_EXCEEDED'`).

### Complexity Plugin

```typescript
import { createComplexityPlugin } from '@leaven-graphql/plugins';

const complexityPlugin = createComplexityPlugin({
  // Required: reject operations scoring above this
  maxComplexity: 1000,
  // Cost of a single field (default: 1)
  defaultComplexity: 1,
  // Page size assumed for a first/last/limit argument whose value cannot be
  // determined — an unsupplied variable that also declares no default.
  // Deliberately pessimistic, since the value is client-controlled (default: 100)
  unknownMultiplier: 100,
});
```

By default a field scores `defaultComplexity` plus its children, and the whole
subtree is multiplied by any `first` / `last` / `limit` page size, resolved from
a literal, the request variables, or the operation's declared variable default.

Supply a `calculator` to score fields yourself. Its return value is the field's
**total** complexity, so incorporate `childComplexity` explicitly:

```typescript
const customComplexity = createComplexityPlugin({
  maxComplexity: 1000,
  calculator: (node, childComplexity) => {
    const name = (node as { name?: { value: string } }).name?.value;
    return (name === 'search' ? 10 : 1) + childComplexity;
  },
});
```

Throws `ComplexityError` (HTTP 400, `extensions.code: 'COMPLEXITY_LIMIT'`) when
an operation exceeds `maxComplexity`, or when analysis exceeds the node budget.
The operation `operationName` selects is scored; without a unique match (no
name, or a name matching zero or several operations), the most complex
operation is. Every operation shares one analysis budget.

### Caching Plugin

```typescript
import { createCachingPlugin } from '@leaven-graphql/plugins';

const cachingPlugin = createCachingPlugin({
  ttl: 60000,           // Cache TTL in ms (default: 60000)
  maxSize: 100,         // Max cached responses, LRU-evicted (default: 100)
  // Derives the cache key. Incorporate the caller's identity here so
  // responses are never served across users. `keyFn` replaces the whole
  // default key (query + operationName + variables), so include
  // `operationName` and `variables` yourself.
  keyFn: (context) => {
    const userId = (context.context as { user?: { id: string } })?.user?.id ?? 'anonymous';
    return JSON.stringify([
      userId,
      context.request.query,
      context.request.operationName ?? null,
      context.request.variables ?? null,
    ]);
  },
});
```

`createCachingPlugin` requires either a `keyFn` or an explicit
`allowSharedCache: true`. Without a `keyFn` the cache key contains no user or
tenant identity, so entries are shared across every caller — opt in only for
data that is genuinely public:

```typescript
const publicCache = createCachingPlugin({ ttl: 60000, allowSharedCache: true });
```

Only `query` operations are cached; mutations and subscriptions always execute.

A cache hit short-circuits `beforeExecute`, so resolvers — and any field-level
authorization they perform — do not run.

## Creating Custom Plugins

`createPlugin` takes **two** arguments: the metadata, then the hooks.

```typescript
import { createPlugin } from '@leaven-graphql/plugins';

const metricsPlugin = createPlugin(
  {
    name: 'metrics',
    version: '1.0.0',
    description: 'Records operation timings',
  },
  {
    beforeParse: (query, context) => {
      // Per-request scratch space lives on `context.state`, a Map
      context.state.set('startTime', performance.now());
      return query;
    },

    afterExecute: (response, context) => {
      const startTime = context.state.get('startTime') as number;

      metrics.record({
        operation: context.request.operationName,
        duration: performance.now() - startTime,
        errors: response.errors?.length ?? 0,
      });

      return response;
    },

    onError: (error, context) => {
      metrics.recordError({
        operation: context.request.operationName,
        error: error.message,
      });
      return error;
    },
  }
);
```

A plugin is a plain object, so you can also write one by hand:

```typescript
import type { Plugin } from '@leaven-graphql/plugins';

const auditPlugin: Plugin = {
  metadata: { name: 'audit', version: '1.0.0' },
  onRegister: async (schema) => {
    await auditLog.open(schema);
  },
  onUnregister: async () => {
    await auditLog.close();
  },
  afterExecute: (response) => response,
};
```

## Plugin Manager

```typescript
import {
  createPluginManager,
  createLoggingPlugin,
  createTracingPlugin,
  createDepthLimitPlugin,
} from '@leaven-graphql/plugins';

const manager = createPluginManager({
  schema,
  plugins: [
    createLoggingPlugin({ level: 'info' }),
    createTracingPlugin(),
    createDepthLimitPlugin(10),
  ],
});

// Constructor plugins are inserted synchronously (duplicate names and
// unsatisfied dependencies throw from the constructor), but their async
// `onRegister` hooks are deferred. `init()` runs them; the manager also awaits
// it lazily before the first registration change or hook dispatch.
await manager.init();

// Register additional plugins — async, and rejects if `onRegister` throws
await manager.register(myCustomPlugin);

// Unregister — resolves to false if no such plugin is registered
const removed = await manager.unregister('logging'); // true

// Inspect
manager.has('tracing');       // boolean
manager.get('tracing');       // Plugin | undefined
manager.getPluginNames();     // string[], in registration order
manager.size;                 // number

// Remove everything, in reverse registration order
await manager.clear();
```

Registration is transactional: if a plugin's `onRegister` rejects, the plugin is
removed from the registry and every hook index before the error propagates, so
its request hooks never run and the registration can be retried.

`init()` is likewise all-or-nothing — a failing deferred `onRegister` unwinds
the hooks that already succeeded, and the failure is not cached, so a later call
retries the whole run.

## Composing Plugins

`composePlugins` is **name-first and variadic** — the composite needs its own
name, since it is registered like any other plugin.

```typescript
import {
  composePlugins,
  createPluginManager,
  createLoggingPlugin,
  createTracingPlugin,
  createDepthLimitPlugin,
  createComplexityPlugin,
} from '@leaven-graphql/plugins';

const combinedPlugin = composePlugins(
  'guardrails',
  createLoggingPlugin({ level: 'info' }),
  createTracingPlugin(),
  createDepthLimitPlugin(10),
  createComplexityPlugin({ maxComplexity: 500 })
);

const manager = createPluginManager({ schema, plugins: [combinedPlugin] });
```

The composite delegates every hook, plus `onRegister` / `onUnregister`, to its
members in order — except `afterExecute`, which runs in reverse, mirroring
`PluginManager`. Passing an array instead of spread arguments does **not** work:
the array becomes the composite's `name` and no plugin is delegated to.

## Plugin Hooks

| Hook | Signature | Return |
|------|-----------|--------|
| `beforeParse` | `(query: string, context)` | new query string, or nothing |
| `afterParse` | `(document: DocumentNode, context)` | new document, or nothing |
| `beforeValidate` | `(document: DocumentNode, context)` | nothing |
| `afterValidate` | `(result: { valid, errors }, context)` | nothing |
| `beforeExecute` | `(document: DocumentNode, context)` | a `GraphQLResponse` to short-circuit execution, or nothing |
| `afterExecute` | `(response: GraphQLResponse, context)` | replacement response, or nothing |
| `onError` | `(error: Error, context)` | replacement error, or nothing |

Every hook may return a promise. `beforeExecute` receives the **document**, not
just the context.

## API Reference

### Plugin

```typescript
interface PluginMetadata {
  /** Unique plugin name */
  name: string;
  version?: string;
  description?: string;
  /** Names of plugins that must already be registered */
  dependencies?: string[];
}

interface PluginHooks {
  beforeParse?: BeforeParseHook;
  afterParse?: AfterParseHook;
  beforeValidate?: BeforeValidateHook;
  afterValidate?: AfterValidateHook;
  beforeExecute?: BeforeExecuteHook;
  afterExecute?: AfterExecuteHook;
  onError?: OnErrorHook;
}

interface Plugin extends PluginHooks {
  metadata: PluginMetadata;
  onRegister?: (schema: GraphQLSchema) => void | Promise<void>;
  onUnregister?: () => void | Promise<void>;
}
```

### PluginContext

```typescript
interface PluginContext<TContext = unknown> {
  schema: GraphQLSchema;
  request: GraphQLRequest;
  /** User context */
  context: TContext;
  /** Per-request scratch space shared between hooks */
  state: Map<string, unknown>;
}
```

### Hook types

```typescript
type BeforeParseHook = (
  query: string,
  context: PluginContext
) => string | void | Promise<string | void>;

type AfterParseHook = (
  document: DocumentNode,
  context: PluginContext
) => DocumentNode | void | Promise<DocumentNode | void>;

type BeforeValidateHook = (
  document: DocumentNode,
  context: PluginContext
) => void | Promise<void>;

type AfterValidateHook = (
  result: { valid: boolean; errors: readonly GraphQLError[] },
  context: PluginContext
) => void | Promise<void>;

type BeforeExecuteHook = (
  document: DocumentNode,
  context: PluginContext
) => GraphQLResponse | void | Promise<GraphQLResponse | void>;

type AfterExecuteHook = (
  response: GraphQLResponse,
  context: PluginContext
) => GraphQLResponse | void | Promise<GraphQLResponse | void>;

type OnErrorHook = (
  error: Error,
  context: PluginContext
) => Error | void | Promise<Error | void>;
```

### createPlugin

```typescript
function createPlugin(metadata: PluginMetadata, hooks: PluginHooks): Plugin;
```

### composePlugins

```typescript
function composePlugins(name: string, ...plugins: Plugin[]): Plugin;
```

### PluginManager

```typescript
interface PluginManagerConfig {
  schema: GraphQLSchema;
  plugins?: Plugin[];
}

class PluginManager {
  constructor(config: PluginManagerConfig);

  /** Run deferred constructor `onRegister` hooks. Idempotent; retries on failure. */
  init(): Promise<void>;

  register(plugin: Plugin): Promise<void>;
  /** Resolves false when no plugin by that name is registered. */
  unregister(name: string): Promise<boolean>;

  get(name: string): Plugin | undefined;
  has(name: string): boolean;
  getPluginNames(): string[];
  get size(): number;
  clear(): Promise<void>;

  createContext<TContext>(
    request: GraphQLRequest,
    userContext: TContext
  ): PluginContext<TContext>;

  // Hook dispatch — call these around your own execution pipeline
  beforeParse(query: string, context: PluginContext): Promise<string>;
  afterParse(document: DocumentNode, context: PluginContext): Promise<DocumentNode>;
  beforeValidate(document: DocumentNode, context: PluginContext): Promise<void>;
  afterValidate(
    result: { valid: boolean; errors: readonly GraphQLError[] },
    context: PluginContext
  ): Promise<void>;
  /** Resolves to a response when a hook short-circuits, otherwise undefined. */
  beforeExecute(
    document: DocumentNode,
    context: PluginContext
  ): Promise<GraphQLResponse | undefined>;
  afterExecute(
    response: GraphQLResponse,
    context: PluginContext
  ): Promise<GraphQLResponse>;
  onError(error: Error, context: PluginContext): Promise<Error>;
}

function createPluginManager(config: PluginManagerConfig): PluginManager;
```

There is no generic `execute(hookName, ...args)` method — each hook has its own
typed dispatch method above.

## License

Apache 2.0 - Joseph Quinn
