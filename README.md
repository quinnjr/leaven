# 🥖 Leaven

> High-Performance GraphQL Library for Bun

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh)

Leaven is a modular, high-performance GraphQL library designed specifically for the [Bun](https://bun.sh) runtime. Named after the rising agent in bread, Leaven makes your GraphQL APIs rise to their full potential.

## ✨ Features

- **🚀 Built for Bun** - Native Bun APIs for maximum performance
- **📦 Modular Architecture** - Use only what you need
- **🔒 Type Safe** - Full TypeScript with strict types
- **🧩 Plugin System** - Extensible with caching, logging, tracing
- **📊 Performance Metrics** - Built-in execution timing and caching stats
- **🔗 Context Management** - AsyncLocalStorage-based request context
- **🌐 HTTP & WebSocket** - Full HTTP server and subscription support
- **🏛️ NestJS Integration** - First-class NestJS support
- **🎮 GraphQL Playground** - Built-in IDE for development

## 📦 Installation

```bash
# Install the meta-package (all runtime modules)
bun add @leaven-graphql/leaven graphql

# Or install individual packages
bun add @leaven-graphql/core @leaven-graphql/http graphql
```

## 🚀 Quick Start

```typescript
import { createServer } from '@leaven-graphql/http';
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from 'graphql';

// Create a schema
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: {
        type: GraphQLString,
        resolve: () => 'Hello, World!',
      },
    },
  }),
});

// Create and start the server
const server = createServer({
  schema,
  port: 4000,
  playground: true,
});

server.start();
console.log('🥖 Server ready at http://localhost:4000/graphql');
```

## 📚 Packages

| Package | Description |
|---------|-------------|
| [`@leaven-graphql/core`](./packages/core) | Core execution engine with caching and metrics |
| [`@leaven-graphql/http`](./packages/http) | High-performance HTTP server for Bun |
| [`@leaven-graphql/ws`](./packages/ws) | WebSocket subscriptions with graphql-ws protocol |
| [`@leaven-graphql/sse`](./packages/sse) | GraphQL over Server-Sent Events (graphql-sse) |
| [`@leaven-graphql/context`](./packages/context) | Request context with AsyncLocalStorage |
| [`@leaven-graphql/errors`](./packages/errors) | Error handling and formatting |
| [`@leaven-graphql/schema`](./packages/schema) | Schema building and merging utilities |
| [`@leaven-graphql/plugins`](./packages/plugins) | Plugin system with built-in plugins |
| [`@leaven-graphql/playground`](./packages/playground) | GraphQL Playground and GraphiQL |
| [`@leaven-graphql/nestjs`](./packages/nestjs) | NestJS framework integration |
| [`@leaven-graphql/leaven`](./packages/leaven) | Meta-package re-exporting the runtime modules (the NestJS integration installs separately as `@leaven-graphql/nestjs`) |

## 🔧 Core Executor

The heart of Leaven is the `LeavenExecutor`:

```typescript
import { LeavenExecutor } from '@leaven-graphql/core';

const executor = new LeavenExecutor({
  schema,
  cache: {
    maxSize: 1000,
    ttl: 3600000, // 1 hour
  },
  metrics: true,
});

const result = await executor.execute({
  query: '{ hello }',
  variables: {},
});

console.log(result.response.data);
// { hello: "Hello, World!" }

console.log(result.metrics);
// { timing: { parseTime: 0.5, validationTime: 1.2, ... }, documentCached: true }
```

## 🌐 HTTP Server

Full-featured HTTP server with CORS, Playground, and custom routes:

```typescript
import { createServer } from '@leaven-graphql/http';

const server = createServer({
  schema,
  port: 4000,
  path: '/graphql',
  playground: true,
  cors: {
    origin: ['https://example.com'],
    credentials: true,
  },
  context: async (request) => ({
    user: await authenticate(request),
    db: database,
  }),
  routes: {
    '/health': () => new Response('OK'),
  },
});

server.start();
```

## 📡 Subscriptions

Real-time GraphQL with WebSocket support:

```typescript
import { createPubSub } from '@leaven-graphql/ws';

const pubsub = createPubSub();

const resolvers = {
  Subscription: {
    messageAdded: {
      subscribe: () => pubsub.asyncIterator('MESSAGE_ADDED'),
    },
  },
  Mutation: {
    sendMessage: async (_, { content }) => {
      const message = await db.messages.create({ content });
      pubsub.publish('MESSAGE_ADDED', message);
      return message;
    },
  },
};
```

Prefer plain HTTP? Subscriptions also work over Server-Sent Events
([graphql-sse](https://github.com/enisdenjo/graphql-sse), distinct connections
mode). It is opt-in:

```typescript
import { createServer } from '@leaven-graphql/http';

createServer({ schema, sse: true }).start();
```

Clients use `createClient({ url: '/graphql' })` from `graphql-sse`. See
[`@leaven-graphql/sse`](./packages/sse) for details.

## 🧩 Plugin System

Plugins are wired up **manually** today. `LeavenExecutor` has no `plugins`
option — `ExecutorConfig` is `schema`, `rootValue`, `cache`, `parseOptions`,
`compilerOptions`, `introspection`, `maxDepth`, `maxComplexity`, `hooks` and
`metrics` — and no package in Leaven (core, http, ws, or nestjs) dispatches
plugin hooks for you. To run plugins you construct a `PluginManager` yourself
and call its hooks around `executor.execute`:

```typescript
import {
  LeavenExecutor,
  parseDocument,
  type GraphQLRequest,
} from '@leaven-graphql/core';
import {
  createPluginManager,
  createLoggingPlugin,
  createDepthLimitPlugin,
  createComplexityPlugin,
} from '@leaven-graphql/plugins';

const executor = new LeavenExecutor({ schema });

const plugins = createPluginManager({
  schema,
  plugins: [
    createLoggingPlugin({ logger: console }),
    createDepthLimitPlugin({ maxDepth: 10 }),
    createComplexityPlugin({ maxComplexity: 1000 }),
  ],
});

async function run<TContext>(request: GraphQLRequest, context: TContext) {
  const pluginContext = plugins.createContext(request, context);

  try {
    const query = await plugins.beforeParse(request.query, pluginContext);

    // The depth-limit and complexity plugins run in `afterParse` and throw
    // when a limit is exceeded, so the document has to be parsed here for
    // them to see it at all.
    const document = await plugins.afterParse(
      parseDocument(query),
      pluginContext
    );

    // A `beforeExecute` hook may return a response outright (a cache hit,
    // say); when it does, skip execution and use it.
    const cached = await plugins.beforeExecute(document, pluginContext);
    const response =
      cached ?? (await executor.execute({ ...request, query }, context)).response;

    return await plugins.afterExecute(response, pluginContext);
  } catch (error) {
    throw await plugins.onError(error as Error, pluginContext);
  }
}
```

For a limit that does **not** need this plumbing, set `maxDepth` and
`maxComplexity` directly on `LeavenExecutor` — the executor enforces those
itself. See [`packages/plugins`](./packages/plugins) for the full hook list.

## 🚨 Error Handling

Type-safe error handling with formatting:

```typescript
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
} from '@leaven-graphql/errors';

const resolvers = {
  Query: {
    me: (_, __, context) => {
      if (!context.user) {
        throw new AuthenticationError('Please log in');
      }
      return context.user;
    },
    user: async (_, { id }) => {
      const user = await db.users.findById(id);
      if (!user) {
        throw new NotFoundError('User not found');
      }
      return user;
    },
  },
};
```

## 🏛️ NestJS Integration

Seamless NestJS support with decorators, guards, and interceptors:

```typescript
import { Module } from '@nestjs/common';
import { LeavenModule } from '@leaven-graphql/nestjs';

@Module({
  imports: [
    LeavenModule.forRoot({
      schema,
      playground: true,
    }),
  ],
})
export class AppModule {}
```

```typescript
import { Resolver, Query } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AuthGuard, RolesGuard, Roles, Context } from '@leaven-graphql/nestjs';

@Resolver()
@UseGuards(AuthGuard, RolesGuard)
export class UserResolver {
  @Query(() => User)
  @Roles('admin')
  async users(@Context() ctx) {
    return ctx.db.users.findAll();
  }
}
```

## 📖 Documentation

Visit our documentation site for comprehensive guides:

- [Quick Start](https://leaven.dev/quick-start)
- [Executor](https://leaven.dev/executor)
- [Schema Building](https://leaven.dev/schema)
- [HTTP Server](https://leaven.dev/http)
- [WebSocket Subscriptions](https://leaven.dev/websockets)
- [Server-Sent Events](https://leaven.dev/websockets#server-sent-events)
- [Plugin System](https://leaven.dev/plugins)
- [Error Handling](https://leaven.dev/errors)
- [NestJS Integration](https://leaven.dev/nestjs)

## 🛠️ Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint

# Build all packages
pnpm build
```

## 🗺️ Roadmap

- [x] Core execution engine
- [x] HTTP server integration
- [x] WebSocket subscriptions
- [x] Server-Sent Events subscriptions (graphql-sse)
- [x] Plugin system
- [x] NestJS integration
- [ ] Persisted queries
- [ ] Federation support
- [ ] Automatic Persisted Queries (APQ)
- [ ] Query batching

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## 📄 License

Apache 2.0 - Joseph Quinn

---

<p align="center">
  Made with 🍞 by <a href="https://github.com/quinnjr">Joseph Quinn</a>
</p>
