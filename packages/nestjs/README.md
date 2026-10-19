# @leaven-graphql/nestjs

NestJS integration for Leaven GraphQL - a high-performance GraphQL execution engine for Bun.

> **Note:** This package assumes you're using `@lexmata/nestjs-platform-bun` as your NestJS HTTP adapter for Bun runtime support.

## Installation

```bash
bun add @leaven-graphql/nestjs @leaven-graphql/core @leaven-graphql/errors @lexmata/nestjs-platform-bun
```

### Required TypeScript configuration

NestJS reads its metadata through `reflect-metadata`, and Bun only emits that
metadata when both decorator flags are on:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

Without them Bun fails at *import* time with an error that names neither
decorators nor NestJS:

```
TypeError: undefined is not an object (evaluating 'descriptor.value')
```

If you see that, check these two flags before anything else.

## Quick Start

### Bootstrap with Bun

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { BunAdapter } from '@lexmata/nestjs-platform-bun';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new BunAdapter());

  await app.listen(3000);
  console.log('🚀 Server running at http://localhost:3000/graphql');
}

bootstrap();
```

### Basic Setup

```typescript
import { Module } from '@nestjs/common';
import { LeavenModule } from '@leaven-graphql/nestjs';
import { makeExecutableSchema } from '@graphql-tools/schema';

const schema = makeExecutableSchema({
  typeDefs: `
    type Query {
      hello: String!
    }
  `,
  resolvers: {
    Query: {
      hello: () => 'Hello World!',
    },
  },
});

@Module({
  imports: [
    LeavenModule.forRoot({
      schema,
      playground: true,
      introspection: true,
    }),
  ],
})
export class AppModule {}
```

### Async Configuration

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LeavenModule } from '@leaven-graphql/nestjs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    LeavenModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        playground: configService.get('GRAPHQL_PLAYGROUND') === 'true',
        introspection: configService.get('GRAPHQL_INTROSPECTION') === 'true',
        maxComplexity: configService.get('GRAPHQL_MAX_COMPLEXITY', 100),
        maxDepth: configService.get('GRAPHQL_MAX_DEPTH', 10),
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
```

## Features

> ### ⚠️ Two paths, and only one of them runs the NestJS pipeline
>
> Read this before the sections below. Which path you pick decides whether the
> guards, interceptors and parameter decorators documented here execute.
>
> **`GraphQLModule.forRoot({ driver: LeavenGraphQLDriver })` — the pipeline runs.**
> `@nestjs/graphql` builds the schema from your `@Resolver()` classes and wraps
> every field resolver in NestJS's `ExternalContextCreator`, so `@UseGuards`,
> `@UseInterceptors`, pipes, filters and parameter decorators all fire; Leaven
> executes the finished schema. See
> [Integration with @nestjs/graphql](#integration-with-nestjsgraphql).
>
> **`LeavenModule.forRoot({ schema })` or `{ typeDefs, resolvers }` — it does not.**
> In that path **your resolvers are plain functions invoked directly by
> graphql-js.** They are not NestJS handlers, so nothing wraps them:
>
> - `@UseGuards(...)` — `AuthGuard`, `RolesGuard`, `PermissionsGuard`,
>   `ComplexityGuard`, `DepthGuard` — **does not fire.**
> - `@UseInterceptors(...)` — `LoggingInterceptor`, `MetricsInterceptor`,
>   `ComplexityInterceptor`, `CachingInterceptor`,
>   `ErrorFormattingInterceptor` — **does not fire.**
> - Parameter decorators — `@Args()`, `@Context()`, `@Info()`, `@Root()`,
>   `@Parent()`, and anything built with `createContextDecorator()` — **are not
>   applied**; your resolver receives the raw graphql-js
>   `(root, args, context, info)` positional arguments instead.
>
> Put authorization and argument handling inside your resolver functions or in
> the `context` factory on that path, or switch to the driver.
>
> What works on **both** paths: the schema build, the HTTP endpoint and
> playground, the `context` factory, `formatError`, the document cache, metrics,
> and — for `LeavenModule` — `@InjectPubSub` and `SubscriptionManager`'s
> graphql-ws protocol handling.
>
> **`ComplexityGuard` and `DepthGuard` are `LeavenModule`-only.** Their limit
> tokens (`LEAVEN_MAX_COMPLEXITY`, `LEAVEN_MAX_DEPTH`) and the `_queryComplexity`
> / `_queryDepth` values they compare come from `LeavenModule` and its
> `LeavenDriver`. Under `LeavenGraphQLDriver` they fail dependency injection, or
> reject every request when the token is provided by hand. On the driver path set
> the `maxComplexity` / `maxDepth` driver options instead, which the executor
> enforces before any resolver runs. Because NestJS enhancers don't fire on the
> `LeavenModule` path either, NestJS never runs these two guards for you on
> either path. They're only useful where you invoke them yourself against a
> `LeavenModule` app, for example in a custom pipeline or a unit test. For
> limits that apply automatically, use the `maxComplexity` / `maxDepth` options.
>
> The guards, interceptors, decorators and `GqlExecutionContext` documented below
> are also usable directly — they are ordinary NestJS classes and helpers, and
> they work in any NestJS pipeline you invoke them from, including unit tests.

### Decorators

#### Parameter Decorators

```typescript
import { Resolver, Query } from '@nestjs/graphql';
import { Context, Args, Info, Root, type GqlContext } from '@leaven-graphql/nestjs';

// `GqlContext` is generic over the request type. Parameterise it with whatever
// your authentication layer attaches to the request so `ctx.req` stays typed.
interface AuthenticatedRequest extends Request {
  user: User;
}

@Resolver()
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  @Query(() => User)
  async me(@Context() ctx: GqlContext<AuthenticatedRequest>) {
    return ctx.req.user;
  }

  @Query(() => User)
  async user(@Args('id') id: string) {
    return this.userService.findById(id);
  }
}
```

#### Method Decorators

```typescript
import { Resolver, Query } from '@nestjs/graphql';
import { Complexity, Description, CacheHint, Deprecated } from '@leaven-graphql/nestjs';

@Resolver()
export class PostResolver {
  constructor(private readonly postService: PostService) {}

  @Query(() => [Post])
  @Complexity(10)
  @Description('Fetch all posts')
  @CacheHint({ maxAge: 60, scope: 'PUBLIC' })
  async posts() {
    return this.postService.findAll();
  }

  @Query(() => [Post])
  @Deprecated('Use posts() instead')
  async allPosts() {
    return this.postService.findAll();
  }
}
```

`@Description` and `@Deprecated` are applied to the emitted schema when the
module builds it from `typeDefs` + `resolvers`: the annotated resolver's field
gets the description, and a deprecated field is printed with
`@deprecated(reason: ...)` so client tooling sees it. A pre-built `schema`
passed via the `schema` option is used exactly as given, so annotate its fields
there instead.

The other two carry caveats:

- **`@Complexity(n)` is observational only.** `ComplexityInterceptor` reads it
  and accumulates the total onto the request context's
  `_resolvedFieldComplexity` key. Nothing in this package reads that key back —
  in particular it is deliberately *not* `_queryComplexity`, the key the driver
  computes statically and `ComplexityGuard` enforces. NestJS runs guards before
  interceptors, so a value accumulated during a request could never gate that
  same request anyway. Consume `_resolvedFieldComplexity` yourself from logging
  or metrics after execution. To actually *reject* expensive queries, set
  `maxComplexity` — the executor enforces that one directly, before any resolver
  runs — rather than annotating fields.
- **`@CacheHint(...)` is a no-op.** `CachingInterceptor` forwards the hint to
  `info.cacheControl.setCacheHint(...)`, but `info.cacheControl` is an Apollo
  Server construct and Leaven never attaches it — so the guarded call is always
  skipped and no cache header or hint is ever produced. Treat it as deprecated:
  it is retained only so existing code keeps compiling. Set cache headers in
  your own middleware, or configure the `cache` option for Leaven's document
  cache (which caches parsed/compiled documents, not responses).

### Guards

See the note on `ComplexityGuard` and `DepthGuard` under
[Features](#features). The executor enforces `maxComplexity` and `maxDepth`
on both paths regardless.

#### Authentication Guard

```typescript
import { UseGuards } from '@nestjs/common';
import { Resolver, Query } from '@nestjs/graphql';
import { AuthGuard, Context, Public, type GqlContext } from '@leaven-graphql/nestjs';

@Resolver()
@UseGuards(AuthGuard)
export class UserResolver {
  @Query(() => User)
  async me(@Context() ctx: GqlContext) {
    return ctx.user;
  }

  @Query(() => String)
  @Public()  // No authentication required
  async publicInfo() {
    return 'This is public';
  }
}
```

#### Role-Based Access

```typescript
import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation } from '@nestjs/graphql';
import { AuthGuard, Args, RolesGuard, Roles } from '@leaven-graphql/nestjs';

@Resolver()
@UseGuards(AuthGuard, RolesGuard)
export class AdminResolver {
  constructor(private readonly userService: UserService) {}

  @Query(() => [User])
  @Roles('admin')
  async users() {
    return this.userService.findAll();
  }

  @Mutation(() => User)
  @Roles('admin', 'moderator')
  async banUser(@Args('id') id: string) {
    return this.userService.ban(id);
  }
}
```

#### Permission-Based Access

```typescript
import { UseGuards } from '@nestjs/common';
import { Resolver, Mutation } from '@nestjs/graphql';
import { AuthGuard, Args, PermissionsGuard, Permissions } from '@leaven-graphql/nestjs';

@Resolver()
@UseGuards(AuthGuard, PermissionsGuard)
export class PostResolver {
  constructor(private readonly postService: PostService) {}

  @Mutation(() => Post)
  @Permissions('posts:write')
  async createPost(@Args('input') input: CreatePostInput) {
    return this.postService.create(input);
  }

  @Mutation(() => Boolean)
  @Permissions('posts:delete')
  async deletePost(@Args('id') id: string) {
    return this.postService.delete(id);
  }
}
```

### Interceptors

#### Logging

```typescript
import { UseInterceptors } from '@nestjs/common';
import { Resolver } from '@nestjs/graphql';
import { LoggingInterceptor } from '@leaven-graphql/nestjs';

@Resolver()
@UseInterceptors(LoggingInterceptor)
export class UserResolver {
  // All resolvers in this class will be logged
}
```

#### Metrics

```typescript
import { UseInterceptors } from '@nestjs/common';
import { Resolver } from '@nestjs/graphql';
import { MetricsInterceptor } from '@leaven-graphql/nestjs';

@Resolver()
@UseInterceptors(MetricsInterceptor)
export class UserResolver {
  // Metrics will be collected for all resolvers
}
```

### Custom Context Decorator

```typescript
import { Resolver, Query } from '@nestjs/graphql';
import { createContextDecorator } from '@leaven-graphql/nestjs';

// Create a custom decorator for accessing the current user
export const CurrentUser = createContextDecorator<User>('user');

// Usage
@Resolver()
export class ProfileResolver {
  constructor(private readonly profileService: ProfileService) {}

  @Query(() => Profile)
  async profile(@CurrentUser() user: User) {
    return this.profileService.getByUserId(user.id);
  }
}
```

### GqlExecutionContext

Use `GqlExecutionContext` in guards, interceptors, and other NestJS constructs to access GraphQL-specific context.

It shares its name with `@nestjs/graphql`'s `GqlExecutionContext` but is a
read-only helper, **not** an `ExecutionContext`: it cannot be passed where Nest
expects one and has no `switchToHttp()` / `switchToWs()` / `getArgByIndex()`.
It reads the positional resolver arguments, and `getHost()` returns the
original context for anything else.

```typescript
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@leaven-graphql/nestjs';

@Injectable()
export class CustomGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const gqlContext = GqlExecutionContext.create(context);

    // Access GraphQL resolver arguments
    const ctx = gqlContext.getContext();   // The context object
    const args = gqlContext.getArgs();     // Resolver arguments
    const info = gqlContext.getInfo();     // GraphQL resolve info
    const root = gqlContext.getRoot();     // Parent/root value

    // Helper methods
    const fieldName = gqlContext.getFieldName();
    const operationType = gqlContext.getOperationType();
    const selectedFields = gqlContext.getSelectedFields();

    return !!ctx.user;
  }
}
```

### Subscriptions

> **`SubscriptionManager` speaks the graphql-ws protocol; it does not own a
> server.** Importing `LeavenModule` registers the manager but does **not** open
> a WebSocket endpoint — nothing here calls `server.upgrade()`, because the HTTP
> server belongs to your Nest adapter, not to this package. Configuring
> `subscriptions` alone gets you a configured object and no listening socket.
> You must wire the transport yourself, as shown below.

Configure the protocol behaviour on the module:

```typescript
import { Module } from '@nestjs/common';
import { LeavenModule, SubscriptionManager } from '@leaven-graphql/nestjs';

@Module({
  imports: [
    LeavenModule.forRoot({
      schema,
      subscriptions: {
        path: '/graphql',
        keepAlive: 12000,
        onConnect: (ctx) => {
          // Validate connection
          return !!ctx.connectionParams?.token;
        },
        onDisconnect: (ctx) => {
          console.log('Client disconnected');
        },
      },
    }),
  ],
})
export class AppModule {}
```

Errors sent over the WebSocket get the same formatting as HTTP responses. An
error thrown by the `context`, `onSubscribe` or `onOperation` hook, or by a
subscription's source stream, goes through `LeavenDriver.formatThrownError`:
unexpected errors are masked in production (unless
`includeStacktraceInErrorResponses` is set), Leaven errors and coded
`GraphQLError`s keep their message and `extensions.code`, and `formatError`
runs last. Execution errors inside each `next` payload go through
`formatError` too.

Close codes and limits follow graphql-ws:

- A connection rejected by `onConnect` (it returns `false`) closes with
  `4403 Forbidden`. `4401 Unauthorized` is used for a `subscribe` sent before
  the server acknowledged the connection.
- A query or mutation sent over the socket that fails before execution (it
  produces no `data`, for example a validation failure) gets a single `error`
  frame, not `next` + `complete`.
- In-flight queries and mutations count toward `maxSubscriptionsPerConnection`
  alongside streams, and reusing the id of any in-flight operation closes the
  connection with `4409`.

#### Same-origin sockets by default

A browser attaches the user's cookies to a cross-site WebSocket upgrade, and
WebSockets are not covered by CORS, so any page could otherwise open an
authenticated socket (cross-site WebSocket hijacking). The manager therefore
accepts only the server's own origin by default:

- A request with **no `Origin` header** (a non-browser client) is always allowed.
- An `Origin` whose host and port equal the upgrade request's `Host` header is
  allowed.
- `subscriptions.allowedOrigins: ['https://app.example.com']` allows those
  origins too, matched by scheme, host and port (default ports ignored);
  `allowedOrigins: '*'` allows every origin.

Origins compare case-insensitively, with default ports normalised
(`https://app.example.com:443` is `https://app.example.com`).
`SubscriptionManager.isOriginAllowed(request)` applies the rule; call it in your
upgrade route, as below. `handleOpen(socket, request)` and
`handleConnection(socket, request)` enforce it again whenever they are given the
upgrade request, closing a disallowed socket with `4403 Forbidden`.

> **Behaviour change:** a browser client served from another origin than the
> socket endpoint must now be listed in `allowedOrigins` (or use `'*'`).

Behind a reverse proxy that rewrites `Host` (nginx's default `$proxy_host`, say),
every genuine browser would be refused: forward the public host
(`proxy_set_header Host $host;`) or list the public origin in `allowedOrigins`.

#### Wiring the WebSocket transport

Two things are yours to do: **register the upgrade route**, and **hand each
socket to the manager**. `SubscriptionManager.getPath()` reports the path it was
configured for (`subscriptions.path`, falling back to `options.path`, then
`/graphql`), so route against that rather than a duplicated constant.

Under Bun, sockets arrive as `ServerWebSocket`, which has no `addEventListener`.
`getWebSocketConfig()` returns `open`/`message`/`close` handlers already bound to
the manager, ready to drop into `Bun.serve`:

```typescript
import { NestFactory } from '@nestjs/core';
import { BunAdapter } from '@lexmata/nestjs-platform-bun';
import { SubscriptionManager } from '@leaven-graphql/nestjs';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, new BunAdapter());
  await app.init();

  const subscriptions = app.get(SubscriptionManager);

  Bun.serve({
    port: 3000,
    // The upgrade route. The manager never calls server.upgrade() itself —
    // it does not have the Server instance.
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (
        pathname === subscriptions.getPath() &&
        request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        // Refuse cross-site WebSocket hijacking: getWebSocketConfig() never
        // sees the upgrade request, so this check is the one that applies.
        if (!subscriptions.isOriginAllowed(request)) {
          return new Response('Forbidden', { status: 403 });
        }
        // Bun requires the `data` option whenever the socket's data type is
        // not `undefined`; nothing is stashed here.
        return server.upgrade(request, { data: undefined })
          ? undefined
          : new Response('Upgrade failed', { status: 400 });
      }
      // Everything else stays on the Nest HTTP pipeline, including the
      // GraphQL POST endpoint served by GraphQLMiddleware.
      return app.getHttpAdapter().getInstance().fetch(request);
    },
    websocket: subscriptions.getWebSocketConfig(),
  });
}

bootstrap();
```

`subscriptions.path` defaults to `options.path`, so the GraphQL POST endpoint and
the WebSocket endpoint share `/graphql` by default — they are told apart by the
`Upgrade` header, as above. Set `subscriptions.path` to something else to
separate them.

**The upgrade request is not threaded through `getWebSocketConfig()`**, so
`ctx.request` is `undefined` inside `onConnect` / `context` hooks when you use it.
If a hook needs the original request (to read a cookie or the `Sec-WebSocket-Protocol`
header, say), skip the packaged config and call `handleOpen` yourself with the
request in hand:

<!-- doc-check: skip - object-literal excerpt, not a standalone module -->
```typescript
websocket: {
  open: (socket) => subscriptions.handleOpen(socket, socket.data.request),
  message: (socket, message) => void subscriptions.handleMessage(socket, message),
  close: (socket) => void subscriptions.handleClose(socket),
},
```

stashing it at upgrade time with `server.upgrade(request, { data: { request } })`.
Authenticating from `connectionParams` in `onConnect` avoids the problem entirely
and is the more common graphql-ws pattern.

If your sockets are DOM-shaped `WebSocket` objects instead (a `ws`-style server,
or a test harness), hand each one to `handleConnection` and the manager attaches
its own `message`/`close`/`error` listeners:

```typescript
await subscriptions.handleConnection(socket, request);
```

Inject the module's shared `PubSub` with `@InjectPubSub()`.

Leaven's own `@Subscription` decorator **only records metadata** (the return
type and options); it does not define a schema field. How a subscription field
is actually defined depends on the path:

- **`LeavenGraphQLDriver`:** use `@nestjs/graphql`'s own `@Subscription`, which
  `@nestjs/graphql` turns into a field of the generated schema. This driver
  ships no WebSocket transport and does not provide `@InjectPubSub()` (both
  come from `LeavenModule`): provide a `PubSub` yourself, and serve
  subscriptions from your own transport over `driver.getExecutor().subscribe()`.
- **`LeavenModule`:** define the field in your SDL and give it a plain
  `subscribe` resolver in the resolver map.

The payload a subscriber receives is whatever was published, so a filter must
read the field the event is wrapped in — `payload.messageAdded.roomId`, not
`payload.roomId`.

```typescript
import { Inject } from '@nestjs/common';
import { Resolver, Subscription, Args } from '@nestjs/graphql';
import type { PubSub } from '@leaven-graphql/ws';

// Your own token, registered in the module next to GraphQLModule.forRoot:
//   providers: [{ provide: PUB_SUB, useValue: createPubSub() }, MessageResolver]
export const PUB_SUB = Symbol('PUB_SUB');

// LeavenGraphQLDriver path: @nestjs/graphql's @Subscription defines the field
@Resolver()
export class MessageResolver {
  constructor(@Inject(PUB_SUB) private readonly pubSub: PubSub) {}

  @Subscription(() => Message, {
    filter: (
      payload: { messageAdded: { roomId: string } },
      variables: { roomId: string },
    ) => payload.messageAdded.roomId === variables.roomId,
  })
  messageAdded(@Args('roomId') _roomId: string) {
    return this.pubSub.asyncIterator('MESSAGE_ADDED');
  }

  publish(roomId: string, body: string) {
    this.pubSub.publish('MESSAGE_ADDED', { messageAdded: { roomId, body } });
  }
}
```

<!-- doc-check: skip - resolver-map excerpt; `pubSub` is the module's PubSub -->
```typescript
// LeavenModule path: SDL + a plain resolver map
import { InputError } from '@leaven-graphql/errors';

const typeDefs = `
  type Subscription { messageAdded(roomId: ID!): Message! }
`;

const resolvers = {
  Subscription: {
    messageAdded: {
      // Scope the topic per room; publish with
      // pubSub.publish(`MESSAGE_ADDED.${roomId}`, { messageAdded: message })
      subscribe: (_root: unknown, args: { roomId: string }) => {
        // The id becomes part of the topic name: on a wildcard-enabled
        // PubSub, "*" or "#" would match every room
        if (!/^[A-Za-z0-9_-]+$/.test(args.roomId)) {
          throw new InputError('Invalid roomId');
        }
        return pubSub.asyncIterator(`MESSAGE_ADDED.${args.roomId}`);
      },
    },
  },
};
```

Do not filter by wrapping the iterator in an `async function*` with a
`for await` loop. A generator's `return()` waits behind its pending `next()`,
so when a client cancels while the topic is quiet the PubSub subscription is
not released until the next event on that topic. The subscription manager
gives up after its teardown deadline and the topic subscription leaks. Narrow
by topic instead, as above, or use `@SubscriptionFilter` or the `filter`
option, which forward cancellation straight to the source. When a client
argument becomes part of a topic name, validate it, and check the caller may
read that topic, before subscribing.

`@InjectPubSub()` resolves the module's own in-memory instance by default, so a
publisher and a subscriber in different providers share the same topics. Pass a
`pubSub` option to `forRoot()`/`forRootAsync()` to supply your own — for example
a distributed engine, so events published on one server instance reach
subscribers on another.

Leaven's `@SubscriptionFilter` wraps the decorated method itself, so it narrows
the method's stream wherever that method is called, and preserves the
decorated method's return kind: a method returning an async iterable still
returns one, so `for await (const event of resolver.messageAdded())`
works in tests and direct callers.

It reads the variables and context from the raw `(root, args, context, info)`
resolver arguments the method is called with. Do not combine it with NestJS
parameter decorators such as `@Args`: NestJS then calls the method with only
the decorated values, so the filter sees no variables and drops every event.
On the code-first `LeavenGraphQLDriver` path, where `@Args` declares the
field's arguments, use the `filter` option of `@nestjs/graphql`'s
`@Subscription` instead, as in the `messageAdded` example above.

<!-- doc-check: skip - class-member excerpt, not a standalone module -->
```typescript
import { SubscriptionFilter } from '@leaven-graphql/nestjs';

// Called as a raw resolver: (root, args, context, info)
@SubscriptionFilter(
  (payload, variables) =>
    (payload as { commentAdded: { postId: string } }).commentAdded.postId ===
    (variables as { postId: string }).postId,
)
commentAdded(_root: unknown, _args: { postId: string }) {
  return this.pubSub.asyncIterator('COMMENT_ADDED');
}
```

### Schema Builder

For applications that need to build schemas from type definitions:

```typescript
import { Injectable } from '@nestjs/common';
import { SchemaBuilderService, generateSchemaFile } from '@leaven-graphql/nestjs';

@Injectable()
export class SchemaService {
  constructor(private schemaBuilder: SchemaBuilderService) {}

  async exportSchema() {
    const schema = this.schemaBuilder.getSchema();
    if (schema) {
      await generateSchemaFile(schema, {
        path: './schema.graphql',
        sortSchema: true,
      });
    }
  }
}
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | `string` | `/graphql` | GraphQL endpoint path |
| `schema` | `GraphQLSchema` | - | Pre-built GraphQL schema |
| `typeDefs` | `string \| DocumentNode \| Array<string \| DocumentNode>` | - | SDL type definitions |
| `resolvers` | `Record<string, unknown> \| Array<Record<string, unknown>>` | - | Resolver map merged into `typeDefs` |
| `subscriptions` | `SubscriptionConfig` | - | GraphQL-over-WebSocket configuration: lifecycle hooks (`onConnect`, `onDisconnect`, `onSubscribe`, `onOperation`, `onComplete`), per-connection context factory, keep-alive, connection-init timeout, max subscriptions per connection, and `allowedOrigins` (`readonly string[] \| '*'`; default: same-origin only, `'*'` allows any) |
| `pubSub` | `PubSub` | per-module in-memory instance | Instance resolved by `@InjectPubSub()`; supply your own to share it across modules or to use a distributed engine |
| `playground` | `boolean` | `true` (dev) | Enable GraphQL Playground |
| `introspection` | `boolean` | `true` (dev) | Enable introspection |
| `cache` | `DocumentCacheConfig \| boolean` | - | Document cache configuration |
| `maxComplexity` | `number` | - | Maximum query complexity. Enforced by the executor before any resolver runs — an over-budget document is rejected with a `ComplexityError` |
| `maxDepth` | `number` | - | Maximum query depth. Enforced by the executor on both paths — an over-deep document is rejected at parse time. See the note on `DepthGuard` under [Features](#features) |
| `parseOptions` | `ParseOptions` | `{ maxTokens: 10000 }` | Parser limits (core executor shape). Applied by the executor, the guard query analysis and the subscription transport's operation-type detection, so an oversized document is never parsed in full; over the limit it is rejected through the executor's normal error response. Set `maxTokens: Infinity` to opt out |
| `metrics` | `boolean` | `false` | Enable execution metrics |
| `context` | `ContextFactory` | - | Custom context factory |
| `formatError` | `FormatErrorFn` | - | Final pass over every error sent to a client: HTTP responses, and the `next` and `error` frames of the WebSocket transport |
| `publicUrl` | `string` | `http://localhost` | Canonical origin (scheme + authority) used to build `request.url` for the context factory. The `Host` header is client-controlled: when this is unset, a syntactically valid `Host` is used and anything else falls back to `http://localhost`. Set this when a factory resolves tenancy or issues redirects from `request.url` |
| `cors` | `boolean \| CorsOptions` | *unset — no CORS headers* | CORS handling. **Opt-in:** while unset the endpoint emits no `Access-Control-*` headers and delegates `OPTIONS` preflights to the next handler. `true` (or an options object without `origin`) enables `Access-Control-Allow-Origin: *`; set `origin` to narrow it. `false` is equivalent to unset. With `credentials: true`, only an origin that passed an explicit check (a string or an allowlist array) is sent, together with `Access-Control-Allow-Credentials`; a wildcard (`true`, `'*'` or an omitted `origin`) then emits neither header rather than echoing every caller's `Origin`. Unless `allowedHeaders` is set, `Access-Control-Allow-Headers` is `Content-Type, Authorization` plus the `csrfPrevention` header names |
| `includeStacktraceInErrorResponses` | `boolean` | `false` | Include stack traces in errors (also suppresses production masking — honored in every environment, not just development) |
| `maxBodySize` | `number` | `1000000` | Maximum POST body size in bytes accepted by `LeavenDriver.handleRequest`. Checked against `Content-Length` first and enforced while reading; a larger body is rejected with a `LeavenError` coded `PAYLOAD_TOO_LARGE` (413). The `LeavenModule` middleware reads the body your framework already parsed, so set the limit on your body parser for that path. `LeavenGraphQLDriver` has its own `maxBodySize` and `bodyReadTimeoutMs` (see [Driver options](#driver-options)) |
| `bodyReadTimeoutMs` | `number` | `30000` | Deadline in milliseconds for reading a whole POST body in `LeavenDriver.handleRequest`, as in `@leaven-graphql/http`. A read that misses it is cancelled and rejected with a `LeavenError` coded `BAD_REQUEST` (400); so is a read that fails (a client abort or socket reset, or a body already consumed). `Infinity` or `0` means no deadline, and a value over 2^31-1 is clamped to it. Like `maxBodySize`, it does not apply to the `LeavenModule` middleware |
| `csrfPrevention` | `boolean \| { requestHeaders?: string[] }` | `true` | CSRF prevention for the `LeavenModule` middleware and `LeavenDriver.handleRequest`. See [CSRF prevention](#csrf-prevention). `false` disables it |

### `LeavenDriver.handleRequest` and HTTP methods

`handleRequest` serves only `GET` and `POST`. Any other method (`HEAD`, `PUT`,
`DELETE`, `PATCH`, ...) is rejected before anything is read or executed, with a
`LeavenError` coded `BAD_REQUEST` with `statusCode` 405 and
`extensions.allow: 'GET, POST'` (send it as an `Allow: GET, POST` header).
`HEAD` is CORS-safelisted, so letting it run an operation from URL parameters
would open a CSRF hole. A mutation sent over `GET` is likewise rejected with
`statusCode` 405, but with `extensions.allow: 'POST'`.

### CSRF prevention

On by default on all three HTTP entry points (the `LeavenModule` middleware,
`LeavenDriver.handleRequest` and `LeavenGraphQLDriver`), as in
`@leaven-graphql/http`. A browser sends a "simple" POST cross-site, with
cookies, and without a CORS preflight, and NestJS's Express adapter parses
`application/x-www-form-urlencoded` bodies by default, so an HTML form on any
site could otherwise run a mutation as the signed-in user.

A POST whose `Content-Type` media type is missing or CORS-safelisted
(`text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`) is
therefore refused with a `400 BAD_REQUEST` error ("This request is blocked by
CSRF prevention: ...") before the context factory or any resolver runs,
whatever shape the body parser left `req.body` in, unless it carries one of
these headers with a non-empty value: `x-graphql-csrf`,
`apollo-require-preflight`, `x-apollo-operation-name`. A browser cannot send
any of them cross-site without a preflight. `application/json` and
`application/graphql` POSTs are never affected, nor is `GET`.

Form and multipart clients (an HTML form, `FormData` uploads, a `curl -d`
without `-H 'Content-Type: application/json'`) must now send one of the
headers, for example `x-graphql-csrf: 1`. Replace the header list with
`csrfPrevention: { requestHeaders: ['x-my-csrf'] }` (names are trimmed and
lowercased; an invalid header name throws a `TypeError` at construction), or
disable the check with `csrfPrevention: false`.

### Deprecated options

These are accepted so existing configurations keep compiling, but nothing reads
them. Removal target: 0.3.0.

| Option | Type | Status |
|--------|------|--------|
| `debug` | `boolean` | Not implemented; setting it has no effect |
| `sortSchema` | `boolean` | No effect — pass `sortSchema` to `generateSchemaFile` instead |
| `buildSchemaOptions` | `BuildSchemaOptions` | No effect — `LeavenModule` has no code-first pipeline. For code-first, use `LeavenGraphQLDriver` with `GraphQLModule.forRoot()`, which honors `@nestjs/graphql`'s own `buildSchemaOptions` |
| `plugins` | `LeavenPlugin[]` | No effect — use NestJS interceptors and guards |
| `autoSchemaFile` | `boolean \| string` | Not implemented by `LeavenModule`; configuring it without `schema` or `typeDefs` throws at bootstrap. `GraphQLModule.forRoot({ driver: LeavenGraphQLDriver, autoSchemaFile: true })` supports it fully |

## Integration with @nestjs/graphql

`LeavenGraphQLDriver` is a real `@nestjs/graphql` driver: it extends
`AbstractGraphQLDriver` and implements `start()` and `stop()`. Pass it to
`GraphQLModule.forRoot()` and your `@Resolver()` classes become NestJS
handlers, executed by Leaven.

**On this path guards, interceptors, pipes, filters and parameter decorators
all execute.**

```typescript
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { LeavenGraphQLDriver, type LeavenDriverConfig } from '@leaven-graphql/nestjs';
import { UserResolver } from './user.resolver';

@Module({
  imports: [
    GraphQLModule.forRoot<LeavenDriverConfig>({
      driver: LeavenGraphQLDriver,
      // Code-first. `true` keeps the generated schema in memory; pass a path
      // to also write it to disk.
      autoSchemaFile: true,
      playground: true,
      path: '/graphql',
      // Leaven executor options
      cache: { maxSize: 1000 },
      metrics: true,
      maxComplexity: 1000,
      maxDepth: 10,
      // Runs once per request; merged over the built-in `{ req, res }`
      context: ({ req }) => ({ req, user: req.user ?? null }),
    }),
  ],
  providers: [UserResolver],
})
export class AppModule {}
```

```typescript
import { Resolver, Query, Args } from '@nestjs/graphql';
import { UseGuards, UseInterceptors } from '@nestjs/common';
import {
  AuthGuard,
  RolesGuard,
  Roles,
  LoggingInterceptor,
  Context,
} from '@leaven-graphql/nestjs';

@Resolver()
@UseGuards(AuthGuard, RolesGuard)
@UseInterceptors(LoggingInterceptor)
export class UserResolver {
  @Query(() => String)
  @Roles('admin')
  public adminReport(
    @Args('id', { type: () => String }) id: string,
    @Context() ctx: { user: { id: string } },
  ): string {
    // The guards ran before this body. `id` and `ctx` were injected by the
    // parameter decorators.
    return `${id} for ${ctx.user.id}`;
  }
}
```

### Why it works

`GraphQLModule.onModuleInit` calls `generateSchema()` before `start()`.
`generateSchema()` is inherited from `AbstractGraphQLDriver` and delegates to
`GraphQLFactory`, which builds the schema from your `@Resolver()` classes and
wraps every field resolver in NestJS's `ExternalContextCreator` — the wrapper
that runs the execution pipeline. By the time `start()` receives
`options.schema`, that pipeline is already part of the schema; the driver
constructs a `LeavenExecutor` over it and serves `POST <path>` (plus
`GET <path>` for GraphiQL when `playground` is enabled).

### Driver options

`LeavenDriverConfig` accepts everything `GqlModuleOptions` does, plus:

| Option | Type | Description |
|--------|------|-------------|
| `cache` | `DocumentCacheConfig \| boolean \| IDocumentCache` | Document/validation cache passed to the executor |
| `metrics` | `boolean` | Collect per-operation metrics and expose them under `extensions.metrics` |
| `maxComplexity` | `number` | Rejected by the executor before any resolver runs |
| `maxDepth` | `number` | Rejected by the executor at parse time |
| `parseOptions` | `ParseOptions` | Parser limits for the executor. `maxTokens` defaults to `10000`; `Infinity` opts out |
| `playground` | `boolean` | Serve GraphiQL on `GET <path>` |
| `subscriptionEndpoint` | `string` | WebSocket endpoint advertised to GraphiQL |
| `formatError` | `(error) => error` | Final transformation applied to every response error |
| `includeStacktraceInErrorResponses` | `boolean` | Include stack traces; also disables production masking |
| `maxBodySize` | `number` | Maximum size in bytes (default `1000000`) of a body read from the raw Fetch `Request` when the adapter hands over no parsed body. Over it the request is answered `413 PAYLOAD_TOO_LARGE`. A body your framework's body parser already parsed is not re-measured, so set the limit on that parser too |
| `bodyReadTimeoutMs` | `number` | Deadline in milliseconds (default `30000`) for reading that raw body. A read that misses it, or fails, is answered `400 BAD_REQUEST`. `Infinity` or `0` means no deadline, and a value over 2^31-1 is clamped to it |
| `csrfPrevention` | `boolean \| { requestHeaders?: string[] }` | CSRF prevention (default `true`); see [CSRF prevention](#csrf-prevention). A form or `text/plain` POST without a preflight-forcing header is answered `400 BAD_REQUEST`. An invalid header name makes `start()` throw a `TypeError`. `false` disables it |

A body the driver parses itself (a raw string `req.body`, or the raw Fetch `Request`) must carry a `Content-Type` whose media type is exactly `application/json` (parameters such as `charset` are ignored, so `text/plain; x=application/json` is refused); anything else, or none, is answered `415` with a `BAD_REQUEST` error before the body is read or any resolver runs, once past CSRF prevention. With `csrfPrevention` on (the default), a missing or `text/plain` Content-Type gets the CSRF 400 first, and reaches 415 only with a preflight header present or `csrfPrevention: false`. A body your framework's parser already turned into an object is accepted as-is; by then [CSRF prevention](#csrf-prevention) has refused a form or `text/plain` POST that carries no preflight-forcing header. `LeavenDriver.handleRequest` refuses an unsupported POST `Content-Type` the same way, with a `LeavenError` coded `BAD_REQUEST` and `statusCode` 415, after the same CSRF check.

### Errors and HTTP status

Every error leaves the driver carrying an `ErrorCode`, and the status is
derived from it (`400` validation/complexity/depth/input, `401`
authentication, `403` authorization, `404` not found, `429` rate limit, `500`
otherwise) — but **only for a total failure** (`data` absent or `null`). A
response with non-null `data` alongside `errors` is a spec-conformant partial
success and stays `200`.

NestJS `HttpException`s — what guards, pipes and filters throw — are
translated to the equivalent Leaven error, so `UnauthorizedException` reaches
the client as `401 UNAUTHENTICATED` rather than as a masked `500`.

In production an unexpected error is masked to `An unexpected error occurred`
with code `INTERNAL_ERROR`; the masked error keeps its `path` and `locations`,
so a client can still tell which field failed.

### The `LeavenModule` alternative

`LeavenModule.forRoot({ typeDefs, resolvers })` remains supported and is the
lighter option when you do not want the NestJS pipeline: it serves a schema
built from plain resolver functions. On that path guards, interceptors and
parameter decorators **do not run** (see the callout under
[Features](#features)); put authorization in the resolver or in the `context`
factory:

```typescript
import { Module } from '@nestjs/common';
import { LeavenModule } from '@leaven-graphql/nestjs';
import { AuthorizationError } from '@leaven-graphql/errors';

@Module({
  imports: [
    LeavenModule.forRoot({
      typeDefs,
      resolvers,
      cache: { maxSize: 1000 },
      playground: true,
      // Runs before execution. Throwing a Leaven error here reaches the client
      // with its own status (401 for AuthenticationError), so this is the
      // practical stand-in for an AuthGuard on this path.
      context: async (request) => {
        const token = request.headers.get('authorization');
        return { user: token ? await verify(token) : null };
      },
    }),
  ],
})
export class AppModule {}
```

<!-- doc-check: skip - defines `resolvers` for the module block above it, so checking it as a continuation would be a forward reference -->

```typescript
const resolvers = {
  Query: {
    adminReport: (_root, _args, context) => {
      if (!context.user?.roles.includes('admin')) {
        throw new AuthorizationError('admin role required');
      }
      return reportService.build();
    },
  },
};
```

The cost limits do not depend on which path you choose: **`maxComplexity` and
`maxDepth` are enforced by the executor itself**, which rejects an over-budget
document with a `ComplexityError` and an over-deep one at parse time, before
any resolver runs. See the note on `ComplexityGuard` and `DepthGuard` under [Features](#features).

HTTP status on this path follows the same rule as the driver and
`@leaven-graphql/http` (`statusForResponse` from `@leaven-graphql/errors`): a
total failure (`data` absent or `null`) carries the `ERROR_CODES` status of its
first error's code (`400` for a validation error, `401` for
`UNAUTHENTICATED`, `500` for an unknown code). **This is a behaviour change:**
`GraphQLMiddleware` previously answered such responses with `200`. A partial
success (non-null `data` alongside `errors`) still stays `200`.

## License

Apache 2.0 - Joseph Quinn
