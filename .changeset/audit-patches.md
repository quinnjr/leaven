---
'@leaven-graphql/core': patch
'@leaven-graphql/context': patch
'@leaven-graphql/errors': minor
'@leaven-graphql/plugins': patch
---

Fixes from a conformance audit:

- **core:** `CompiledQuery` stores field arguments and input-object fields on null-prototype objects, so an argument named `__proto__` is kept as a key instead of replacing the object's prototype.
- **core:** a document-cache read failure (for example a Redis outage) is now treated as a cache miss and reported through `onCacheError`, instead of failing the request (0.4.1 answered it as a pre-execution request rejection). Hook throws before `onExecute` are still request rejections.
  A mutation or subscription sent to a schema without that root type is now rejected as a coded request rejection (`BAD_REQUEST` on graphql 16; graphql 17 already reports it as a `VALIDATION_ERROR`), instead of an uncoded error that a masking transport turned into a 500.
- **context:** `ContextStore` keeps an entry for a `requestId` while any run with that id is still active, including when runs overlap. The entry tracks the most recent active run for an id and falls back to the previous one when it ends. `cleanup(maxAge)` reaps individual entries older than `maxAge`, and the `autoCleanup` timer does the same with the fixed 5-minute default, even for runs that are still unsettled (they then disappear from `getByRequestId`); a reaped run's later release cannot affect a newer run. `ContextBuilder.build` copies the base context once and applies every extension to that one object; extensions must not keep a reference to it.
- **errors:** new `isPlainObject` (accepts only plain objects, meaning an `Object` or `null` prototype), `MASKED_ERROR_MESSAGE`, `maskedErrorFor`, `statusForResponse` and `withMaskingDefault` exports. These are the shared GraphQL-over-HTTP status rule and masking message and masked-error builder, used by the transports. Masked errors now keep `path` and `locations`.
- **plugins:**
  - The caching plugin no longer caches mutations or subscriptions.
  - The complexity plugin now scores the selected operation, or the most complex one, instead of the sum of all operations in a document.
  - The logging plugin no longer reports `NaNms` after a cache short-circuit: it reports `duration: 'unknown'` when `beforeExecute` did not run (another plugin short-circuited).
