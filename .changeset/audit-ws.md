---
'@leaven-graphql/ws': minor
---

Harden the graphql-ws handler and `PubSub`:

- **Same-origin WebSockets by default (behaviour change):** the new `allowedOrigins` option and `WebSocketHandler.isOriginAllowed(request)` close cross-site WebSocket hijacking. By default only the server's own origin may connect (the `Origin` host:port must equal the `Host` header, case-insensitive, default ports normalised); a request with no `Origin` (a non-browser client) is always allowed. Behind a reverse proxy that rewrites `Host` (nginx default), forward the public Host (`proxy_set_header Host $host`) or list the public origin in `allowedOrigins`. Cross-origin browser clients must now be listed in `allowedOrigins`, or allowed with `'*'`. `LeavenServer` enforces the check; a standalone `Bun.serve` must call `isOriginAllowed` before `server.upgrade()`.
- **Subscribe validation:** a `subscribe` whose payload is not an object with a string `query` now closes the socket with `4400 Invalid message`, following the graphql-ws protocol. Before, it triggered an internal error. The socket also closes with `4400` when `operationName` is not a string, or `variables`/`extensions` are not objects (for example arrays or strings). `null` is accepted for all three, as is omitting them. The exported `parseMessage` now throws `Invalid message` for such a frame (whatever `requireId` is).
- **`onConnect` failures:** a throwing `onConnect` closes with `4403 Forbidden` and is logged. Its error text no longer appears in the close reason.
- **`onComplete`:** now fires only for operations that were still live.
- **Wildcards:** with `wildcards: true`, a bare `'*'` now matches exactly one topic segment, as documented. Use `'#'` to match every topic.
- **`PubSub.asyncIterator`:**
  - It no longer leaks subscriptions when a later topic hits `maxSubscribersPerTopic`.
  - `asyncIterator` dequeues in O(1) and no longer retains drained slots; set `maxQueueSize` to bound a lagging consumer's buffer, which is unlimited by default.
- **`PubSub` `maxQueueSize`:** the constructor now throws a `TypeError` unless `maxQueueSize` is an integer >= 1 or `Infinity`. Before, `0` behaved like a queue of 1.
- **Error masking:** errors from a throwing context factory and other non-execution failures are now masked by default; the default also masks errors thrown by `onSubscribe` and by a subscription's source stream, including on a standalone `SubscriptionManager`. Only a `LeavenError` or an error with a known non-`INTERNAL_ERROR` code keeps its message, so an uncoded `GraphQLError` is masked too. Throw a `LeavenError` (e.g. `AuthorizationError`) or a coded `GraphQLError` to keep a rejection message, or set `errorFormatting: { maskErrors: false }` to disable masking.
- **`next` frames:** now forward the result's `extensions`; `createNextMessage` takes a new optional fourth `extensions` argument.
- **Manager callbacks:** a throwing callback no longer causes an unhandled rejection or leaves the subscription registered.
