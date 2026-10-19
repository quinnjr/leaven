# @leaven-graphql/sse

## 0.5.0

### Minor Changes

- ab4ed47: Support graphql 17. The `graphql` peer range is now `^16.0.0 || ^17.0.0`, and the test suite passes against both majors.
  
  `mergeSchemas` in `@leaven-graphql/schema` now also carries a custom scalar's graphql 17 coercion functions (`coerceOutputValue`, `coerceInputValue`, `coerceInputLiteral`, `valueToLiteral`) onto the merged schema. Under graphql 17 a merged custom scalar previously fell back to the default coercion, so its `serialize` was ignored.
  
  `@leaven-graphql/nestjs` now imports `ModuleMetadata` from the `@nestjs/common` root, which makes it compatible with NestJS 12 (that release no longer resolves the `@nestjs/common/interfaces` subpath).

### Patch Changes

- Updated dependencies [3877881]
- Updated dependencies [ab4ed47]
  - @leaven-graphql/core@0.5.0
  - @leaven-graphql/errors@0.4.0

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
