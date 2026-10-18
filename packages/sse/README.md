# @leaven-graphql/sse

Server-Sent Events transport for GraphQL, implementing the
[graphql-sse](https://github.com/enisdenjo/graphql-sse) protocol in
**distinct connections mode**: every operation gets its own HTTP request and its
own event stream. Single connection mode is not implemented.

## Installation

```bash
bun add @leaven-graphql/sse @leaven-graphql/core graphql
```

Most applications do not use this package directly. Enable the transport on
`@leaven-graphql/http` (below) and let it do the wiring. The package is also
re-exported from `@leaven-graphql/leaven`.

## Quick Start

### Server

SSE is **off by default**. Opt in with the `sse` option on `createServer` (or
`createHandler`):

```typescript
import { createServer } from '@leaven-graphql/http';

createServer({
  schema,
  sse: true, // or { keepAliveInterval: 5000 }
}).start();
```

A request is answered over SSE when it `Accept`s `text/event-stream`.
Subscriptions stream every result; queries and mutations are answered with a
single `next` event followed by `complete`. Mutations are only accepted over
`POST`: a `GET` mutation is rejected with `405` and `Allow: POST`. Anything that
fails before producing data (a syntax or validation error, for example) is
answered as a plain JSON response with the usual status code rather than as a
stream.

### Browser client

Use the `graphql-sse` client, pointed at the same endpoint:

```typescript
import { createClient } from 'graphql-sse';

const client = createClient({ url: '/graphql' });

for await (const result of client.iterate({
  query: 'subscription { messageAdded { id content } }',
})) {
  console.log(result.data);
}
```

`client.subscribe(payload, sink)` is the callback-based equivalent.

## Wire format

Success responses carry these headers:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

Events are exactly:

```
event: next
data: {"data":{"messageAdded":{"id":"1","content":"hi"}}}

event: complete
data:

```

A comment line (`:` followed by a blank line) is sent periodically as a
keep-alive.

## Low-level API

For a custom transport (a different framework, or your own router), build the
GraphQL context yourself, call `executor.subscribe`, and hand the result to
`createEventStreamResponse`. It accepts either a subscription iterator or a
single response:

```typescript
import { LeavenExecutor, type GraphQLRequest } from '@leaven-graphql/core';
import { acceptsEventStream, createEventStreamResponse } from '@leaven-graphql/sse';

const executor = new LeavenExecutor({ schema });

export async function handleGraphQL(request: Request): Promise<Response> {
  if (!acceptsEventStream(request)) {
    return new Response('Not Acceptable', { status: 406 });
  }

  const graphqlRequest = (await request.json()) as GraphQLRequest;
  const context = { user: request.headers.get('authorization') };

  const result = await executor.subscribe(graphqlRequest, context);

  return createEventStreamResponse(result, {
    // Closing the connection ends the stream and returns the iterator
    signal: request.signal,
    // Shape every result before it is serialised
    formatResult: (response) => response,
  });
}
```

This is the route frameworks such as Knead take: they own routing and context
creation and only need the stream.

The stream applies backpressure (the iterator is only advanced as fast as the
client reads), calls `iterator.return()` exactly once when the client
disconnects or `signal` aborts, and masks unexpected errors by default; supply
`formatError` to change that.

### Exports

| Export | Description |
|--------|-------------|
| `createEventStreamResponse(source, options?)` | Wrap a response or iterator in a `200` event-stream `Response` |
| `createEventStream(source, options?)` | The underlying `ReadableStream` |
| `acceptsEventStream(request)` | Whether the request `Accept`s `text/event-stream` |
| `isSubscriptionIterator(value)` | Distinguish an iterator from a single response |
| `formatSSEEvent`, `formatNextEvent`, `formatCompleteEvent` | Event encoders |
| `SSE_CONTENT_TYPE`, `SSE_HEADERS`, `SSE_KEEP_ALIVE` | Protocol constants |
| `DEFAULT_KEEP_ALIVE_INTERVAL` | `8000` ms |

## Keep-alive and idle timeouts

Proxies and Bun itself close connections that stay silent. The keep-alive
comment defaults to every `8000` ms (`DEFAULT_KEEP_ALIVE_INTERVAL`); set
`keepAliveInterval: 0` to disable it. Keep the interval below Bun's 10 second
`idleTimeout`. `LeavenServer` disables Bun's idle timeout for SSE requests, so
this matters mainly when you serve the stream with your own `Bun.serve`.

## HTTP/1.1 connection limit

Distinct connections mode uses one HTTP connection per active operation.
Browsers allow about **6 connections per origin** over HTTP/1.1, so a page with
many live subscriptions can stall. Serve over HTTP/2 or HTTP/3 (typically via a
reverse proxy) to lift the limit, or use WebSockets via `@leaven-graphql/ws`.
Disable proxy response buffering for the endpoint as well (`X-Accel-Buffering:
no` is already sent for nginx).

## License

Apache-2.0
