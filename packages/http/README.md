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
  csrfPrevention: true,          // Default: true (see CSRF Prevention)

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
  // Errors thrown outside execution (e.g. by the context factory) are masked
  // unless `errorFormatting.maskErrors` is explicitly `false`
  errorFormatting: {
    maskErrors: true,
    includeStackTrace: false,
  },

  // Body limits
  maxBodySize: 1024 * 1024,      // 1MB, default: 1_000_000
  bodyReadTimeoutMs: 30_000,     // Deadline for reading a body, default: 30_000; Infinity or 0 disables it

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
unset behaviour is unchanged. Subscriptions stream results, and queries and
mutations answer with one `next` event then `complete`. Only request errors
(no `data`, and rejected by the executor before any resolver ran: a syntax,
validation, complexity, depth, operation-selection or variable-coercion error,
or a failure before execution started such as a throwing `onParse` or
`onValidated` hook; see `isRequestError` in
`@leaven-graphql/sse`) get a plain JSON response.
Everything else, `data: null` and coded errors raised after execution started
included, is streamed, because the `graphql-sse` client
retries non-`200` responses. `LeavenServer` disables Bun's idle timeout while an event
stream is open and restores it when the stream closes. See
[`@leaven-graphql/sse`](../sse) for the client and the low-level API.

Errors in a streamed result (from resolvers) follow `errorFormatting`, exactly
as on the JSON path: without it nothing is masked. An error thrown by the
subscription iterator itself mid-stream is masked by default, and follows
`errorFormatting` when it is set. The SSE `Content-Type` and `Cache-Control`
always win over `response.headers`; other headers, CORS included, are kept.

A mutation sent with any method other than `POST` (`GET`, or `HEAD` if you add
it to `allowedMethods`) is rejected with `405` and `Allow: POST` on every path,
whether or not `sse` is enabled.

### CORS Configuration

```typescript
const server = createServer({
  schema,
  cors: {
    origin: ['https://example.com', 'https://app.example.com'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-graphql-csrf'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
    maxAge: 86400,
  },
});
```

`credentials: true` needs an explicit `origin` (a string, an array or a predicate). With the default `'*'` origin, a credentialed config sends neither `Access-Control-Allow-Origin` nor `Access-Control-Allow-Credentials`, because echoing an arbitrary request Origin would let any site make credentialed reads.

Without `allowedHeaders`, the default `Access-Control-Allow-Headers` is
`Content-Type`, `Authorization` and the `csrfPrevention` header names. An
explicit `allowedHeaders` replaces that default, so it must include the CSRF
header names (e.g. `x-graphql-csrf`) for cross-origin form or multipart
clients, or their preflight fails.

### CSRF Prevention

CSRF prevention is on by default. A browser sends a "simple" cross-site `POST`
without a CORS preflight, so CORS alone cannot stop a malicious page from
running a mutation with the visitor's cookies. Leaven therefore refuses a
`POST` whose `Content-Type` is missing or CORS-safelisted (`text/plain`,
`application/x-www-form-urlencoded`, `multipart/form-data`) unless it carries
at least one non-empty preflight-forcing header:

- `x-graphql-csrf`
- `apollo-require-preflight`
- `x-apollo-operation-name`

A blocked request gets `400` with code `BAD_REQUEST` and the message
`This request is blocked by CSRF prevention: ...`, before the body is read or
the context factory runs.

`application/json` and `application/graphql` requests need no header, since
browsers always preflight them cross-site. `GET` is not checked: mutations are
already refused on every method other than `POST`, which also keeps
`EventSource`-style SSE `GET`s working.

File-upload clients (graphql-multipart-request-spec) post
`multipart/form-data`, so they must send one of the headers, for example
`x-graphql-csrf: 1` (Apollo's upload link sends `apollo-require-preflight`).

```typescript
import { createServer } from '@leaven-graphql/http';

// Replace the accepted header list
const server = createServer({
  schema,
  csrfPrevention: { requestHeaders: ['x-my-csrf'] },
});

// Or turn the check off (only behind another CSRF defence)
const unprotected = createServer({ schema, csrfPrevention: false });
```

Body media types are matched exactly (case-insensitively, parameters
ignored). Any other `Content-Type`, or a missing one on a non-empty body, gets
`415` with code `BAD_REQUEST` once past CSRF prevention. With `csrfPrevention`
on (the default), a missing or `text/plain` Content-Type is refused with `400`
first; it reaches `415` only when a preflight header is present or
`csrfPrevention` is `false`. The body is no longer parsed as JSON as a
fallback. A `POST` with an empty body still takes its parameters from the URL.

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
  // Upgrades only if websocket.isOriginAllowed(request); otherwise 403 Forbidden
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
  csrfPrevention?: boolean | CSRFPreventionOptions; // default true
}

interface SSEOptions {
  keepAliveInterval?: number; // default 8000, 0 disables
}

interface CSRFPreventionOptions {
  // Replaces the defaults: x-graphql-csrf, apollo-require-preflight,
  // x-apollo-operation-name
  requestHeaders?: string[];
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
  stop(closeActiveConnections?: boolean): void; // default false: open SSE/WebSocket connections are left to finish
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
import {
  mediaType,
  parseBody,
  parseQuery,
  UnsupportedMediaTypeError,
  validateRequest,
} from '@leaven-graphql/http';

// The media-type essence: lowercased, parameters dropped, '' when missing
const type = mediaType(request.headers.get('content-type')); // 'application/json'

// Parse request body (JSON, GraphQL, form, multipart). Any other
// Content-Type throws `UnsupportedMediaTypeError` (an empty body returns {}).
const body = await parseBody(request);

// In a custom handler, map that error to 415
async function parseOr415(req: Request) {
  try {
    return await parseBody(req);
  } catch (error) {
    if (error instanceof UnsupportedMediaTypeError) {
      return new Response(error.message, { status: 415 });
    }
    throw error;
  }
}

// Parse query string parameters — takes a URL, not a Request. Like
// parseBody, it throws a plain Error on undecodable `variables`/`extensions`
// JSON: answer 400. parseBody also throws one on a body that is not a JSON
// object, an unparseable form or multipart body, or an upload whose
// `operations`/`map` is not a JSON object, whose `map` entries are not
// arrays of strings, or (with a `map`) whose `variables` is not an object.
const params = parseQuery(new URL(request.url));

// Validate a GraphQL request. The second argument holds the parameters
// parsed off the URL and defaults to `{}`; the body wins on conflicts.
// `valid: false` (answer 400) for a missing or non-string `query`, a
// non-string `operationName`, or a `variables`/`extensions` that is not a
// plain object; `null` counts as absent.
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
