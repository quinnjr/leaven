---
'@leaven-graphql/core': patch
'@leaven-graphql/ws': patch
'@leaven-graphql/nestjs': patch
---

Security re-audit fixes: operation id validation, log escaping and bounded caches

- **ws**: `parseMessage` (with the default `requireId: true`) rejects a
  `subscribe`/`complete` id that does not match `^[A-Za-z0-9_.:-]{1,64}$`
  with `Invalid message`, so the handler closes the socket with 4400. The
  pattern is exported as `OPERATION_ID_PATTERN`, with an `isValidOperationId`
  predicate. Subscription ids, topics and unknown message types are escaped
  wherever they reach a log line, error or close reason.
- **nestjs**: the subscription transport applies the same id rule (4400
  `Invalid message`); the echoed `Content-Type` and the pump-failure log
  escape client values; the query-analysis memo is bounded at 8 MiB.
- **core**: new `escapeLog(value, maxLength = 256)` escapes CR, LF, other
  control characters and DEL and caps the value; unknown operation names in
  error text go through it. Documents and compiled plans are cached only after
  validation, the depth limit and the complexity budget have all passed.
  `DocumentCache` takes `maxBytes` (default 32 MiB, estimated as
  `query.length * AST_BYTES_PER_QUERY_CHAR`, 300), evicts LRU entries when
  either `maxSize` or `maxBytes` is exceeded, and never caches an entry above
  `maxBytes / 10`. The compiled-query cache is bounded the same way
  (`MAX_COMPILED_QUERIES`, `MAX_COMPILED_BYTES`) and keyed by the operation
  the document actually selects, so an unknown `operationName` creates no
  entry. `getCacheStats()` reports `bytes`/`maxBytes` for both caches.
