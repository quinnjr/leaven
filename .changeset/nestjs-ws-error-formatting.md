---
'@leaven-graphql/nestjs': patch
---

Format and mask errors sent by the graphql-ws `SubscriptionManager` the way the driver formats
HTTP errors.

- **Security:** an error thrown by the `context`, `onSubscribe` or `onOperation` hook, or by a
  subscription's source stream, used to be sent as its raw `message` with no code. It now goes
  through `LeavenDriver.formatThrownError` (now public): masked in production unless
  `includeStacktraceInErrorResponses` is set, a `LeavenError` or coded `GraphQLError` keeps its
  message and `extensions.code`, and `formatError` runs last.
- `LeavenDriver.subscribe` now applies `formatError` to the errors of every stream event, not
  only to an operation rejected before it streams.
