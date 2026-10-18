# @leaven-graphql/nestjs

NestJS integration for Leaven GraphQL - a high-performance GraphQL execution engine for Bun.

> **Note:** This package assumes you're using `@lexmata/nestjs-platform-bun` as your NestJS HTTP adapter for Bun runtime support.

## Installation

```bash
bun add @leaven-graphql/nestjs @leaven-graphql/core @leaven-graphql/context @leaven-graphql/errors @lexmata/nestjs-platform-bun
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

Use `GqlExecutionContext` in guards, interceptors, and other NestJS constructs to access GraphQL-specific context:

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

Inject the module's shared `PubSub` with `@InjectPubSub()` and use the
`@Subscription` decorator in resolvers:

```typescript
import { Resolver } from '@nestjs/graphql';
import { InjectPubSub, Subscription } from '@leaven-graphql/nestjs';
import type { PubSub } from '@leaven-graphql/ws';

@Resolver()
export class MessageResolver {
  constructor(@InjectPubSub() private readonly pubSub: PubSub) {}

  @Subscription(() => Message, {
    filter: (payload, variables) =>
      (payload as { roomId: string }).roomId === (variables as { roomId: string }).roomId,
  })
  messageAdded() {
    return this.pubSub.asyncIterator('MESSAGE_ADDED');
  }

  publish(roomId: string, body: string) {
    this.pubSub.publish('MESSAGE_ADDED', { messageAdded: { roomId, body } });
  }
}
```

`@InjectPubSub()` resolves the module's own in-memory instance by default, so a
publisher and a subscriber in different providers share the same topics. Pass a
`pubSub` option to `forRoot()`/`forRootAsync()` to supply your own — for example
a distributed engine, so events published on one server instance reach
subscribers on another.

`@SubscriptionFilter` is the standalone equivalent of the `filter` option, and
preserves the decorated method's return kind: a method returning an async
iterable still returns one, so `for await (const event of resolver.messageAdded())`
works in tests and direct callers.

<!-- doc-check: skip - class-member excerpt, not a standalone module -->
```typescript
import { SubscriptionFilter } from '@leaven-graphql/nestjs';

@Subscription(() => Comment)
@SubscriptionFilter((payload, variables) => payload.postId === variables.postId)
commentAdded() {
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
| `subscriptions` | `SubscriptionConfig` | - | GraphQL-over-WebSocket configuration: lifecycle hooks (`onConnect`, `onDisconnect`, `onSubscribe`, `onOperation`, `onComplete`), per-connection context factory, keep-alive, connection-init timeout, and max subscriptions per connection |
| `pubSub` | `PubSub` | per-module in-memory instance | Instance resolved by `@InjectPubSub()`; supply your own to share it across modules or to use a distributed engine |
| `playground` | `boolean` | `true` (dev) | Enable GraphQL Playground |
| `introspection` | `boolean` | `true` (dev) | Enable introspection |
| `cache` | `DocumentCacheConfig \| boolean` | - | Document cache configuration |
| `maxComplexity` | `number` | - | Maximum query complexity. Enforced by the executor before any resolver runs — an over-budget document is rejected with a `ComplexityError` |
| `maxDepth` | `number` | - | Maximum query depth. **Only recorded on the context** (as `_queryDepth`) for `DepthGuard`, so it is not enforced on `LeavenModule`'s HTTP path — see the caveat under [Features](#features). The `LeavenGraphQLDriver` path enforces it in the executor |
| `parseOptions` | `ParseOptions` | `{ maxTokens: 10000 }` | Parser limits (core executor shape). Applied by the executor, the guard query analysis and the subscription transport's operation-type detection, so an oversized document is never parsed in full; over the limit it is rejected through the executor's normal error response. Set `maxTokens: Infinity` to opt out |
| `metrics` | `boolean` | `false` | Enable execution metrics |
| `context` | `ContextFactory` | - | Custom context factory |
| `formatError` | `FormatErrorFn` | - | Final pass over every error sent to a client: HTTP responses, and the `next` and `error` frames of the WebSocket transport |
| `publicUrl` | `string` | `http://localhost` | Canonical origin (scheme + authority) used to build `request.url` for the context factory. The `Host` header is client-controlled, so it is not trusted: set this when a factory resolves tenancy or issues redirects from `request.url` |
| `cors` | `boolean \| CorsOptions` | *unset — no CORS headers* | CORS handling. **Opt-in:** while unset the endpoint emits no `Access-Control-*` headers and delegates `OPTIONS` preflights to the next handler. `true` (or an options object without `origin`) enables `Access-Control-Allow-Origin: *`; set `origin` to narrow it. `false` is equivalent to unset |
| `includeStacktraceInErrorResponses` | `boolean` | `false` | Include stack traces in errors (also suppresses production masking — honored in every environment, not just development) |

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

### Errors and HTTP status

Every error leaves the driver carrying an `ErrorCode`, and the status is
derived from it (`400` validation/complexity/depth/input, `401`
authentication, `403` authorization, `404` not found, `429` rate limit, `500`
otherwise) — but **only for a total failure**. A response carrying `data`
alongside `errors` is a spec-conformant partial success and stays `200`.

NestJS `HttpException`s — what guards, pipes and filters throw — are
translated to the equivalent Leaven error, so `UnauthorizedException` reaches
the client as `401 UNAUTHENTICATED` rather than as a masked `500`.

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

One cost limit does not depend on which path you choose: **`maxComplexity` is
enforced by the executor itself**, which rejects an over-budget document with a
`ComplexityError` before any resolver runs. `maxDepth` under `LeavenModule` is
only recorded on the context for `DepthGuard`, so there it needs the driver
like every other guard.

## License

Apache 2.0 - Joseph Quinn
