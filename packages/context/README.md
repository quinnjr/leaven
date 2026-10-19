# @leaven-graphql/context

Request context management for Leaven: an HTTP request context, an
`AsyncLocalStorage`-backed store, and a typed context builder.

## Installation

```bash
bun add @leaven-graphql/context
```

## Quick Start

```typescript
import { createRequestContext } from '@leaven-graphql/context';

const ctx = createRequestContext(request);

ctx.requestId;          // 'a3f1...' - a crypto.randomUUID()
ctx.startTime;          // Date.now() at construction
ctx.request.method;     // 'POST'
ctx.request.url;        // 'http://localhost:3000/graphql'
ctx.getHeader('Content-Type'); // 'application/json' (case-insensitive)
ctx.getElapsedTime();   // ms since startTime
```

HTTP details live under `ctx.request`, not on the context itself. There is no
`ctx.url`, `ctx.method`, `ctx.headers`, `ctx.ip` or `ctx.userAgent`.

## `BaseContext`

Everything in this package is built on a two-field base:

```typescript
interface BaseContext {
  /** Request ID for tracing */
  requestId: string;
  /** Timestamp when the request started */
  startTime: number;
}
```

## Request Context

### `createRequestContext(request, config?, ip?)`

```typescript
function createRequestContext(
  request: Request,
  config?: RequestContextConfig,
  ip?: string
): RequestContext;

interface RequestContextConfig {
  /** Supply your own request IDs (default: crypto.randomUUID()) */
  generateRequestId?: () => string;
  /** Trust proxy headers when resolving the client IP */
  trustProxy?: boolean;
  /** Headers to consult when trustProxy is on
   *  (default: x-forwarded-for, x-real-ip, cf-connecting-ip) */
  proxyHeaders?: string[];
}
```

A `Request` does not carry the peer address, so the HTTP layer has to pass it
as the third argument:

```typescript
Bun.serve({
  fetch(request, server) {
    const ctx = createRequestContext(
      request,
      { trustProxy: true },
      server.requestIP(request)?.address
    );
    return handle(ctx);
  },
});
```

### `RequestContext`

```typescript
class RequestContext implements BaseContext {
  readonly requestId: string;
  readonly startTime: number;
  readonly request: RequestInfo;

  constructor(request: RequestInfo, config?: RequestContextConfig);

  /** Case-insensitive header lookup */
  getHeader(name: string): string | undefined;
  /** Client IP, honouring proxy headers when trustProxy is on */
  getClientIp(config?: RequestContextConfig): string | undefined;
  /** Milliseconds since startTime */
  getElapsedTime(): number;
  /** Child context with extra own properties, prototype preserved */
  extend<T extends Record<string, unknown>>(properties: T): RequestContext & T;
  /** { requestId, startTime, method, url } */
  toJSON(): { requestId: string; startTime: number; method: string; url: string };
}

interface RequestInfo {
  method: string;
  url: string;
  headers: Record<string, string>;
  ip?: string;
  userAgent?: string;
}
```

`RequestContext` can also be constructed directly from a `RequestInfo`, which
is convenient in tests:

```typescript
import { RequestContext } from '@leaven-graphql/context';

const ctx = new RequestContext(
  {
    method: 'POST',
    url: 'http://localhost:3000/graphql',
    headers: { 'user-agent': 'Test/1.0', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    ip: '10.0.0.1',
  },
  { trustProxy: true }
);

ctx.getHeader('User-Agent'); // 'Test/1.0'
ctx.getClientIp();           // '203.0.113.7' - first hop of x-forwarded-for
```

Without `trustProxy`, `getClientIp()` returns `request.ip` verbatim. The
config passed to `getClientIp()` overrides the constructor config for that
call only.

### `extend`

`extend` returns a new object with the same prototype, so the class methods
survive — unlike an object spread:

```typescript
const withUser = ctx.extend({ user, permissions: ['read'] });

withUser.user;                 // the user
withUser.getHeader('accept');  // still works
withUser instanceof RequestContext; // true
```

## Context Store

`ContextStore` wraps `node:async_hooks`' `AsyncLocalStorage`. Contexts must
satisfy `BaseContext`, because the store keys its active-context registry on
`requestId`.

```typescript
import { createContextStore, type BaseContext } from '@leaven-graphql/context';

interface AppContext extends BaseContext {
  userId: string;
  role: string;
}

const store = createContextStore<AppContext>();

const context: AppContext = {
  requestId: crypto.randomUUID(),
  startTime: Date.now(),
  userId: '123',
  role: 'admin',
};
```

### `run` is synchronous, `runAsync` is for promises

`run` removes the context from the active registry as soon as the callback
*returns*. Handing it an `async` callback means the entry is dropped before
the promise settles, so `getByRequestId`/`activeCount` go stale mid-request.
Use `runAsync` for anything asynchronous:

```typescript
// Synchronous work
const role = store.run(context, () => store.requireContext().role); // 'admin'

// Asynchronous work
await store.runAsync(context, async () => {
  const ctx = store.getContext();      // available anywhere in this async scope
  await someNestedFunction();
  return ctx?.userId;
});

async function someNestedFunction(): Promise<void> {
  console.log(store.requireContext().role); // 'admin'
}
```

### `getContext` vs `requireContext`

`getContext()` returns `undefined` outside a `run`/`runAsync` scope — it never
throws. `requireContext()` is the throwing variant. There is no
`getContextOrNull()` and no `hasContext()`.

```typescript
store.getContext();      // AppContext | undefined
store.requireContext();  // AppContext, throws 'No context available. Are you running inside a request?'

// The `hasContext` equivalent:
if (store.getContext() !== undefined) { /* ... */ }
```

### API

```typescript
class ContextStore<TContext extends BaseContext> {
  constructor(config?: ContextStoreConfig);

  run<T>(context: TContext, fn: () => T): T;
  runAsync<T>(context: TContext, fn: () => Promise<T>): Promise<T>;

  getContext(): TContext | undefined;
  requireContext(): TContext;

  getByRequestId(requestId: string): TContext | undefined;
  get activeCount(): number;
  getActiveRequestIds(): string[];

  /** Removes entries older than maxAge (default 300000 ms), including in-flight runs; returns the count */
  cleanup(maxAge?: number): number;
  dispose(): void;
}

interface ContextStoreConfig {
  /** Periodic cleanup (default: off); every cleanupInterval, reaps runs older than 5 minutes, including in-flight ones */
  autoCleanup?: boolean;
  /** Cleanup interval in ms (default: 60000) */
  cleanupInterval?: number;
}

interface StoredContext<TContext extends BaseContext> {
  context: TContext;
  storedAt: number;
  requestId: string;
}

function createContextStore<TContext extends BaseContext>(
  config?: ContextStoreConfig
): ContextStore<TContext>;
```

`dispose()` clears the cleanup timer and the active registry; call it when
tearing a server down.

## Context Builder

`createContextBuilder` takes the base factory as its **required argument**.
`extend` returns a *new* builder (builders are immutable), and `build` is
async.

```typescript
import { createContextBuilder, type BaseContext } from '@leaven-graphql/context';

interface AppContext extends BaseContext {
  user: User | null;
}

const builder = createContextBuilder<Request, AppContext>(() => ({
  requestId: crypto.randomUUID(),
  startTime: Date.now(),
  user: null,
}))
  .extend(async () => ({ user: await authenticate() }))
  .extend(() => ({ db: database, cache: cacheClient }));

const context = await builder.build(request);
context.user;
context.db;
```

There is no fluent `withRequest` / `withUser` / `withDatabase` / `withLogger`
/ `withTracing`. The whole surface is `extend`, `build` and `withInput`.

Extensions are applied in order to a single copy of the factory result, which
keeps the prototype of the context the factory produced — so a class-based
context such as `RequestContext` keeps its methods. Every extension receives
that same object, so it must not keep a reference to it after its own call.
With no extensions the factory result is returned as-is:

```typescript
import {
  RequestContext,
  createContextBuilder,
  createRequestContext,
} from '@leaven-graphql/context';

const builder = createContextBuilder<Request, RequestContext>((request) =>
  createRequestContext(request)
).extend(async (ctx) => ({ user: await authenticate(ctx.getHeader('authorization')) }));

const ctx = await builder.build(request);
ctx instanceof RequestContext; // true
ctx.getElapsedTime();          // still callable
ctx.user;
```

### `withInput`

Adapts a builder to a different input type:

```typescript
// Bun's `ServerWebSocket`, not the DOM `WebSocket` — the per-connection
// payload lives on `.data`, which the DOM type does not have.
const fromSocket = builder.withInput<{ socket: { data: { request: Request } } }>(
  ({ socket }) => socket.data.request
);

const context = await fromSocket.build({ socket });
```

### API

```typescript
type ContextFactory<TInput, TContext extends BaseContext> = (
  input: TInput
) => TContext | Promise<TContext>;

type ContextExtension<TContext extends BaseContext, TExtension> = (
  context: TContext
) => TExtension | Promise<TExtension>;

interface ContextBuilderConfig<TInput, TContext extends BaseContext> {
  factory: ContextFactory<TInput, TContext>;
  extensions?: Array<ContextExtension<TContext, Record<string, unknown>>>;
}

class ContextBuilder<TInput, TContext extends BaseContext> {
  constructor(config: ContextBuilderConfig<TInput, TContext>);

  extend<TExtension extends Record<string, unknown>>(
    extension: ContextExtension<TContext, TExtension>
  ): ContextBuilder<TInput, TContext & TExtension>;

  build(input: TInput): Promise<TContext>;

  withInput<TNewInput>(
    transform: (input: TNewInput) => TInput | Promise<TInput>
  ): ContextBuilder<TNewInput, TContext>;
}

function createContextBuilder<TInput, TContext extends BaseContext>(
  factory: ContextFactory<TInput, TContext>
): ContextBuilder<TInput, TContext>;
```

## Integration with `@leaven-graphql/http`

`createServer` builds a `RequestContext` for you when no `context` factory is
configured; pass `requestContext` to configure it:

```typescript
import { createServer } from '@leaven-graphql/http';

const server = createServer({
  schema,
  requestContext: { trustProxy: true },
});
```

With a custom factory, use `extend` rather than a spread so the
`RequestContext` methods survive:

```typescript
import { createServer } from '@leaven-graphql/http';
import { createRequestContext } from '@leaven-graphql/context';

const server = createServer({
  schema,
  context: async (request) => {
    const base = createRequestContext(request, { trustProxy: true });
    return base.extend({
      user: await authenticateRequest(request),
      db: await getDatabase(),
    });
  },
});
```

## Custom Context Types

Any object satisfying `BaseContext` works with the store and the builder:

```typescript
import type { BaseContext } from '@leaven-graphql/context';

interface AppContext extends BaseContext {
  user: User | null;
  db: Database;
  cache: CacheClient;
  permissions: string[];
}

function createAppContext(): AppContext {
  return {
    requestId: crypto.randomUUID(),
    startTime: Date.now(),
    user: null,
    db: database,
    cache: cacheClient,
    permissions: [],
  };
}
```

## License

Apache 2.0 - Joseph Quinn
</content>
