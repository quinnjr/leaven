# @leaven-graphql/http

High-performance GraphQL HTTP server for Leaven, built on Bun's native APIs.

## Installation

```bash
bun add @leaven-graphql/http @leaven-graphql/core graphql
```

## Quick Start

```typescript
import { createServer } from '@leaven-graphql/http';
import { schema } from './schema';

const server = createServer({
  schema,
  port: 4000,
  playground: true,
});

const info = server.start();
console.log(`🚀 Server ready at ${info.url}`);
```

## Features

### Server Configuration

Full configuration options:

```typescript
import { createServer } from '@leaven-graphql/http';
import { WebSocketHandler } from '@leaven-graphql/ws';

const server = createServer({
  // Required
  schema,

  // Server options
  port: 4000,                    // Default: 4000
  hostname: '0.0.0.0',           // Default: '0.0.0.0'
  path: '/graphql',              // Default: '/graphql'
  development: false,            // Passed through to Bun.serve

  // Features
  playground: true,              // Enable GraphiQL (boolean only)
  introspection: true,           // Enable introspection
  cors: true,                    // Enable CORS

  // HTTP
  allowedMethods: ['GET', 'POST', 'OPTIONS'],  // Default: GET, POST, OPTIONS
  response: {                    // Applied to every GraphQL response
    pretty: false,
    headers: { 'X-Powered-By': 'Leaven' },
  },

  // Executor options (everything except `schema` and `rootValue`, which are
  // taken from the top level). A top-level `cache` is NOT a ServerConfig
  // option — document caching lives here.
  executor: {
    cache: { maxSize: 1000, ttl: 3600000 },
    maxDepth: 10,
    maxComplexity: 1000,
    metrics: false,
  },

  // Default request context (ignored when a `context` factory is supplied)
  requestContext: {
    trustProxy: true,
    proxyHeaders: ['x-forwarded-for'],
  },

  // Error handling
  errorFormatting: {
    maskErrors: true,
    includeStackTrace: false,
  },

  // Body limits
  maxBodySize: 1024 * 1024,      // 1MB, default: 1_000_000
  bodyReadTimeoutMs: 30_000,     // Deadline for reading a body, default: 30_000

  // Subscriptions: upgrades `Upgrade: websocket` requests on `path`
  websocket: new WebSocketHandler({ schema }),

  // GraphQL over SSE (graphql-sse, distinct connections). Off by default;
  // answers requests that Accept text/event-stream. `true` or
  // `{ keepAliveInterval: 8000 }` (ms, 0 disables)
  sse: true,

  // Lifecycle hooks
  onStart: (server) => console.log('Server started'),
  onStop: () => console.log('Server stopped'),
  onError: (error, request) => new Response('Error', { status: 500 }),
});
```

### Server-Sent Events

Set `sse` to serve GraphQL over SSE (graphql-sse, distinct connections mode) to
requests that `Accept` `text/event-stream`. It is off by default; with `sse`
unset behaviour is unchanged. Subscriptions stream results, queries and
mutations answer with one `next` event then `complete`, and operations that fail
before producing data get a plain JSON response. `LeavenServer` disables Bun's
idle timeout for SSE requests. See [`@leaven-graphql/sse`](../sse) for the
client and the low-level API.

A mutation sent with `GET` is rejected with `405` and `Allow: POST` on every
path, whether or not `sse` is enabled.

### CORS Configuration

```typescript
const server = createServer({
  schema,
  cors: {
    origin: ['https://example.com', 'https://app.example.com'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
    maxAge: 86400,
  },
});
```

### Custom Context

Add authentication and custom data:

```typescript
const server = createServer({
  schema,
  context: async (request, graphqlRequest) => {
    const token = request.headers.get('authorization')?.replace('Bearer ', '');
    const user = token ? await verifyToken(token) : null;
    const db = await getDatabase();

    return {
      user,
      db,
      requestId: crypto.randomUUID(),
    };
  },
});
```

### Multiple Routes

Add custom routes alongside GraphQL:

```typescript
const server = createServer({
  schema,
  routes: {
    '/health': () => new Response('OK'),
    '/metrics': async () => {
      const metrics = await collectMetrics();
      return Response.json(metrics);
    },
  },
  fallback: (request) => new Response('Not Found', { status: 404 }),
});
```

### Standalone Handler

Use just the handler with your own Bun server:

```typescript
import { createHandler } from '@leaven-graphql/http';

const graphqlHandler = createHandler({
  schema,
  playground: true,
  cors: true,
});

Bun.serve({
  port: 4000,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/graphql') {
      return graphqlHandler(request);
    }

    return new Response('Not Found', { status: 404 });
  },
});
```

## API Reference

### createServer

```typescript
function createServer<TContext = unknown>(
  config: ServerConfig<TContext>
): LeavenServer;

interface ServerConfig<TContext = unknown> extends HandlerConfig<TContext> {
  port?: number;
  hostname?: string;
  development?: boolean;
  routes?: Record<string, GraphQLHandler | ((request: Request) => Response | Promise<Response>)>;
  fallback?: (request: Request) => Response | Promise<Response>;
  websocket?: WebSocketHandler;
  onStart?: (server: Server<unknown>) => void;
  onStop?: () => void;
  onError?: (error: Error, request: Request) => Response | Promise<Response>;
}

interface HandlerConfig<TContext = unknown> {
  schema: GraphQLSchema;
  context?: ContextFactory<TContext>;
  rootValue?: unknown;
  executor?: Omit<ExecutorConfig, 'schema' | 'rootValue'>;
  cors?: CorsConfig | boolean;
  playground?: boolean;
  path?: string;
  errorFormatting?: ErrorMaskingOptions;
  requestContext?: RequestContextConfig;
  response?: ResponseOptions;
  allowedMethods?: string[];
  introspection?: boolean;
  maxBodySize?: number;
  bodyReadTimeoutMs?: number;
  sse?: boolean | SSEOptions;
}

interface SSEOptions {
  keepAliveInterval?: number; // default 8000, 0 disables
}
```

Document caching, depth and complexity limits, hooks and metrics are executor
concerns and are configured under `executor`. A top-level `cache` key is not
part of `ServerConfig` and is ignored.

### LeavenServer

The URL and port are returned by `start()`; they are not properties of the
server instance.

```typescript
class LeavenServer {
  constructor(config: ServerConfig);
  start(): ServerInfo;
  stop(): void;
  reload(): void;
  getServer(): Server<unknown> | null;
  isRunning(): boolean;
}

interface ServerInfo {
  url: string;
  port: number;
  hostname: string;
}
```

```typescript
const server = createServer({ schema });
const { url, port } = server.start();
```

### createHandler

```typescript
function createHandler<TContext = unknown>(
  config: HandlerConfig<TContext>
): GraphQLHandler;

type GraphQLHandler = (request: Request) => Promise<Response>;
```

### Request Utilities

```typescript
import { parseBody, parseQuery, validateRequest } from '@leaven-graphql/http';

// Parse request body (JSON, GraphQL, form, multipart)
const body = await parseBody(request);

// Parse query string parameters — takes a URL, not a Request
const params = parseQuery(new URL(request.url));

// Validate a GraphQL request. The second argument holds the parameters
// parsed off the URL and defaults to `{}`; the body wins on conflicts.
const validation = validateRequest(body);
const merged = validateRequest(body, params);
```

### Response Utilities

```typescript
import { buildResponse, sendResponse, corsHeaders } from '@leaven-graphql/http';

// Build a GraphQL response
const response = buildResponse(result, {
  status: 200,
  headers: { 'X-Request-Id': '123' },
});

// Get CORS headers — the request comes first, the config is optional
const headers = corsHeaders(request, { origin: 'https://example.com' });
```

`buildResponse` only derives a status when the response is a total failure
(`data` is `undefined` or `null`). A partial success — data alongside errors —
always stays `200`, even when the error carries a code such as `NOT_FOUND`, so
clients do not discard data they were given.

## License

Apache 2.0 - Joseph Quinn
