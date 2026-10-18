# @leaven-graphql/leaven

The meta-package that re-exports the Leaven runtime modules - a high-performance GraphQL library for Bun.

## Installation

```bash
bun add @leaven-graphql/leaven graphql
```

Or install individual packages:

```bash
bun add @leaven-graphql/core @leaven-graphql/http @leaven-graphql/context @leaven-graphql/errors
```

## Quick Start

```typescript
import { createServer, LeavenExecutor } from '@leaven-graphql/leaven';
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from 'graphql';

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

const server = createServer({
  schema,
  port: 4000,
  playground: true,
});

server.start();
console.log('🚀 Server ready at http://localhost:4000/graphql');
```

## Included Packages

| Package | Description |
|---------|-------------|
| `@leaven-graphql/core` | Core execution engine |
| `@leaven-graphql/http` | HTTP server integration |
| `@leaven-graphql/ws` | WebSocket subscriptions |
| `@leaven-graphql/sse` | GraphQL over Server-Sent Events (graphql-sse) |
| `@leaven-graphql/context` | Request context management |
| `@leaven-graphql/errors` | Error handling utilities |
| `@leaven-graphql/schema` | Schema building utilities (**selected** helpers only — see below) |
| `@leaven-graphql/plugins` | Plugin system |
| `@leaven-graphql/playground` | GraphQL Playground |

The NestJS integration is **not** re-exported here — importing NestJS symbols
from this package fails. Install it separately:

```bash
bun add @leaven-graphql/nestjs
```

`@leaven-graphql/schema` is re-exported selectively to avoid name collisions
with core: `SchemaBuilder`, `createSchemaBuilder`, `mergeSchemas`,
`mergeSchemasFromStrings`, `createResolvers`, `mergeResolvers`,
`loadSchemaFromFile`, and `loadSchemaFromDirectory`. Anything else — the
directive helpers, for instance — imports from `@leaven-graphql/schema`
directly. This package has a single entry point; there are no
`@leaven-graphql/leaven/*` subpaths.

## Usage

### From Core

```typescript
import { LeavenExecutor } from '@leaven-graphql/leaven';

const executor = new LeavenExecutor({
  schema,
  cache: true,
  metrics: true,
});

const result = await executor.execute({
  query: '{ hello }',
});
```

### From HTTP

```typescript
import { createServer, createHandler } from '@leaven-graphql/leaven';

const server = createServer({
  schema,
  port: 4000,
  playground: true,
  cors: true,
});

server.start();
```

### From Context

```typescript
import { createRequestContext, ContextStore } from '@leaven-graphql/leaven';

const context = createRequestContext(request);
console.log(context.requestId);
```

### From Errors

```typescript
import {
  AuthenticationError,
  AuthorizationError,
  NotFoundError
} from '@leaven-graphql/leaven';

throw new AuthenticationError('Please log in');
```

### From Schema

```typescript
import { SchemaBuilder, mergeSchemas } from '@leaven-graphql/leaven';

const builder = new SchemaBuilder();

builder.addType({
  name: 'User',
  fields: {
    id: { type: 'ID!' },
    name: { type: 'String!' },
  },
});

builder.addQueryFields({
  users: { type: '[User!]!', resolve: () => db.users.findAll() },
});

const schema = builder.build();
```

### From Plugins

`LeavenExecutor` has no `plugins` option and no transport dispatches plugin
hooks, so plugins are wired manually through a `PluginManager`:

```typescript
import {
  createPluginManager,
  createLoggingPlugin,
  createDepthLimitPlugin,
  createComplexityPlugin
} from '@leaven-graphql/leaven';

const plugins = createPluginManager({
  schema,
  plugins: [
    createLoggingPlugin({ logger: console }),
    createDepthLimitPlugin({ maxDepth: 10 }),
    createComplexityPlugin({ maxComplexity: 1000 }),
  ],
});
```

See the [root README](../../README.md#-plugin-system) for the full
`beforeParse` → `afterParse` → `beforeExecute` → `afterExecute` wiring.

### From WebSocket

```typescript
import { createPubSub } from '@leaven-graphql/leaven';

const pubsub = createPubSub();

pubsub.publish('MESSAGE_ADDED', message);
const iterator = pubsub.asyncIterator('MESSAGE_ADDED');
```

### From SSE

```typescript
import { leaven } from '@leaven-graphql/leaven';

leaven({ schema, sse: true }).start();
```

## Documentation

For full documentation, visit the [Leaven Documentation](https://leaven.dev).

### Core Concepts

- [Quick Start](/quick-start) - Get up and running
- [Executor](/executor) - Core execution engine
- [Schema Building](/schema) - Build and merge schemas
- [Request Context](/context) - Context management

### Integrations

- [HTTP Server](/http) - Bun HTTP integration
- [WebSocket](/websockets) - Real-time subscriptions
- [Server-Sent Events](/websockets#server-sent-events) - Subscriptions over SSE
- [NestJS](/nestjs) - NestJS framework integration
- [Playground](/playground) - GraphQL IDE

### Advanced

- [Plugin System](/plugins) - Extend with plugins
- [Error Handling](/errors) - Error formatting and masking

## Why Leaven?

- **Built for Bun** - Native Bun APIs for maximum performance
- **Type Safe** - Full TypeScript support with strict types
- **Modular** - Use only what you need
- **Extensible** - Plugin system for customization
- **Standards Compliant** - Follows GraphQL specification

## License

Apache 2.0 - Joseph Quinn
