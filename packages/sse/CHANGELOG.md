# @leaven-graphql/sse

## 0.4.1

### Patch Changes

- 507d308: `createEventStream` and `createEventStreamResponse` now call `iterator.return()` exactly once on every close of a subscription iterator, including after the iterator threw and after it completed. Before, `return()` ran only when the stream ended early, so a source that releases its topic subscriptions in `return()` stayed subscribed after a throw. A `return()` that throws or rejects is still ignored and never becomes an unhandled rejection.

  `isRequestError` also covers the new pre-execution rejections from `@leaven-graphql/core`: a response for a throwing `onParse`, `onParsed`, `onValidate` or `onValidated` hook, or a document cache failure, is now a request error.

- Updated dependencies [507d308]
  - @leaven-graphql/core@0.4.1

## 0.4.0

### Minor Changes

- 998bbaf: Add GraphQL over Server-Sent Events (graphql-sse distinct connections mode): the new `@leaven-graphql/sse` package and an opt-in `sse` option on the HTTP handler and server.

### Patch Changes

- Updated dependencies [998bbaf]
  - @leaven-graphql/core@0.4.0
