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
`POST`: a `GET` mutation is rejected with `405` and `Allow: POST`.

Only a *request error* is answered as a plain JSON response with the usual
status code rather than as a stream: a result with no `data` that the executor
itself rejected before running any resolver (a syntax error, a parser limit,
validation, complexity, operation selection or variable coercion, or any
other failure before execution starts: a throwing `onParse`, `onParsed`,
`onValidate` or `onValidated` hook, or a document cache failure). The executor
marks those responses, and `isRequestError` checks the mark
(`isRequestRejection` from `@leaven-graphql/core`), so the decision is
structural rather than by error code. Everything else is streamed as `200`
`next` + `complete`, including a result with `data: null`, and any error raised
after execution started, whatever its code: by a resolver, by a subscribe
resolver at subscription start (an `AuthenticationError` or a
`ValidationError`, for example), or by an `onExecute` or `onExecuted` hook. The client receives
those as a result carrying `errors`. Streaming is the safe default, because a
stream is never retried.

### Retries

The `graphql-sse` client treats every non-`200` response as a network error and
retries it, up to `retryAttempts` times (default `5`) with randomised
exponential backoff, before rejecting with a `NetworkError` whose `response`
holds the JSON error. This is why only request errors get a non-`200` answer:
retrying them is harmless because nothing ran, while an execution error answered
that way would run a mutation's resolver again on every retry. Set
`retryAttempts: 0` on the client to surface request errors immediately.

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
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
Content-Encoding: none
```

Extra `headers` passed to `createEventStreamResponse` (CORS headers, for
example) are added to these, but cannot replace them.

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
GraphQL context yourself and route the operation by type: a subscription goes
through `executor.subscribe` (an iterator, or a single response when it failed
to start), a query or mutation through `executor.execute`. Answer a request
error (`isRequestError`) as JSON, and hand everything else to `createEventStreamResponse`, which
accepts either a subscription iterator or a single response. Mask errors with
`formatResultErrors`: the executor's errors are already formatted, and passing
them to `formatErrors` would mask intentional errors such as `UNAUTHENTICATED`
and drop their `path`.

Only send subscription operations to `executor.subscribe()`: graphql-js runs the root resolver of a query or mutation if you pass one, which is why the sample routes by operation type first.

```typescript
import { getOperationAST } from 'graphql';
import { LeavenExecutor, type GraphQLRequest, type GraphQLResponse } from '@leaven-graphql/core';
import { formatErrors } from '@leaven-graphql/errors';
import {
  acceptsEventStream,
  createEventStreamResponse,
  formatResultErrors,
  isRequestError,
  isSubscriptionIterator,
} from '@leaven-graphql/sse';

const executor = new LeavenExecutor({ schema });

// Mask unexpected errors; intentional Leaven errors keep their code and path
const masking = { maskErrors: true };

// Request errors all answer 400 here for brevity; @leaven-graphql/http derives
// the status from each error's code instead
const json = (body: GraphQLResponse, status = 400): Response => Response.json(body, { status });

export async function handleGraphQL(request: Request): Promise<Response> {
  if (!acceptsEventStream(request)) {
    return new Response('Not Acceptable', { status: 406 });
  }

  const graphqlRequest = (await request.json()) as GraphQLRequest;
  const context = { user: request.headers.get('authorization') };

  // executor.parse applies the executor's parser limits; a syntax error throws
  let operation;
  try {
    operation = getOperationAST(
      await executor.parse(graphqlRequest.query),
      graphqlRequest.operationName
    );
  } catch (error) {
    return json({ errors: formatErrors([error], masking) });
  }
  if (!operation) {
    return json({ errors: [{ message: 'Unknown operation' }] });
  }

  // Subscriptions go through subscribe, queries and mutations through execute
  const source =
    operation.operation === 'subscription'
      ? await executor.subscribe(graphqlRequest, context)
      : (await executor.execute(graphqlRequest, context)).response;

  // Only a result the executor rejected before running anything is answered as
  // JSON. Check the executor's own object: the mark does not survive a copy.
  // Everything else is streamed, or the client's retries would run it again.
  if (!isSubscriptionIterator(source) && isRequestError(source)) {
    return json(formatResultErrors(source, masking));
  }

  return createEventStreamResponse(source, {
    // Closing the connection ends the stream and returns the iterator
    signal: request.signal,
    // Mask every result's errors before it is serialised
    formatResult: (response) => formatResultErrors(response, masking),
  });
}
```

This is the route frameworks such as Knead take: they own routing and context
creation and only need the stream.

The stream applies backpressure (the iterator is only advanced as fast as the
client reads), calls `iterator.return()` exactly once when the client
disconnects or `signal` aborts, and masks errors thrown by the iterator by
default; supply `formatError` to change that. Errors inside a result are left
to `formatResult`.

### Exports

| Export | Description |
|--------|-------------|
| `createEventStreamResponse(source, options?)` | Wrap a response or iterator in a `200` event-stream `Response` |
| `createEventStream(source, options?)` | The underlying `ReadableStream` |
| `acceptsEventStream(request)` | Whether the request `Accept`s `text/event-stream` |
| `isSubscriptionIterator(value)` | Distinguish an iterator from a single response |
| `formatResultErrors(result, options?)` | Format (mask) the already-formatted errors of an executor result |
| `isRequestError(result)` | Whether a single executor result was rejected before execution (check the executor's own object, not a copy) |
| `formatSSEEvent`, `formatNextEvent`, `formatCompleteEvent` | Event encoders |
| `SSE_CONTENT_TYPE`, `SSE_HEADERS`, `SSE_KEEP_ALIVE` | Protocol constants |
| `DEFAULT_KEEP_ALIVE_INTERVAL` | `8000` ms |

## Keep-alive and idle timeouts

Proxies and Bun itself close connections that stay silent. The keep-alive
comment defaults to every `8000` ms (`DEFAULT_KEEP_ALIVE_INTERVAL`); set
`keepAliveInterval: 0` to disable it. Keep the interval below Bun's 10 second
`idleTimeout`. `LeavenServer` disables Bun's idle timeout while an event stream
is open and restores it when the stream closes, so this matters mainly when you
serve the stream with your own `Bun.serve`.

## HTTP/1.1 connection limit

Distinct connections mode uses one HTTP connection per active operation.
Browsers allow about **6 connections per origin** over HTTP/1.1, so a page with
many live subscriptions can stall. Serve over HTTP/2 or HTTP/3 (typically via a
reverse proxy) to lift the limit, or use WebSockets via `@leaven-graphql/ws`.
Disable proxy response buffering for the endpoint as well (`X-Accel-Buffering:
no` is already sent for nginx).

## License

Apache-2.0
