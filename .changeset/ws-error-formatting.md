---
'@leaven-graphql/ws': minor
---

Format and mask every error the WebSocket transport sends, as `@leaven-graphql/http` does.

- New `errorFormatting?: ErrorMaskingOptions` on `WebSocketHandlerConfig` (passed to the
  subscription manager) and on `SubscriptionManagerConfig`.
- **Security:** an error thrown by `onSubscribe`, the context factory or a source stream used to
  be sent as its raw `message` (a DSN, a connection failure) with no code. It now goes through
  `formatError(error, errorFormatting)`: masked when `maskErrors` is `true`, and a
  `GraphQLError`/`LeavenError` keeps its `extensions.code` (others get `INTERNAL_ERROR`).
- Execution errors in `next` payloads, in the `error` frame of a rejected operation, and in
  `SubscriptionManager.execute` results are re-formatted (via `fromFormattedError`) when
  `errorFormatting` is set. Without it they are sent as the executor formatted them, as before.
- The "Maximum subscriptions per connection reached" and duplicate-id errors are now
  `LeavenError`s with code `BAD_REQUEST`, so masking never hides them.
