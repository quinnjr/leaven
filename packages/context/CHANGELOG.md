# @leaven-graphql/context

## 0.2.2

### Patch Changes

- 3877881: Fixes from a conformance audit:
  
  - **core:** `CompiledQuery` stores field arguments and input-object fields on null-prototype objects, so an argument named `__proto__` is kept as a key instead of replacing the object's prototype.
  - **core:** a document-cache read failure (for example a Redis outage) is now treated as a cache miss and reported through `onCacheError`, instead of failing the request (0.4.1 answered it as a pre-execution request rejection). Hook throws before `onExecute` are still request rejections.
    A mutation or subscription sent to a schema without that root type is now rejected as a coded request rejection (`BAD_REQUEST` on graphql 16; graphql 17 already reports it as a `VALIDATION_ERROR`), instead of an uncoded error that a masking transport turned into a 500.
  - **context:** `ContextStore` keeps an entry for a `requestId` while any run with that id is still active, including when runs overlap. The entry tracks the most recent active run for an id and falls back to the previous one when it ends. `cleanup(maxAge)` reaps individual entries older than `maxAge`, and the `autoCleanup` timer does the same with the fixed 5-minute default, even for runs that are still unsettled (they then disappear from `getByRequestId`); a reaped run's later release cannot affect a newer run. `ContextBuilder.build` copies the base context once and applies every extension to that one object; extensions must not keep a reference to it.
  - **errors:** new `isPlainObject` (accepts only plain objects, meaning an `Object` or `null` prototype), `MASKED_ERROR_MESSAGE`, `maskedErrorFor`, `statusForResponse` and `withMaskingDefault` exports. These are the shared GraphQL-over-HTTP status rule and masking message and masked-error builder, used by the transports. Masked errors now keep `path` and `locations`.
  - **plugins:**
    - The caching plugin no longer caches mutations or subscriptions.
    - The complexity plugin now scores the selected operation, or the most complex one, instead of the sum of all operations in a document.
    - The logging plugin no longer reports `NaNms` after a cache short-circuit: it reports `duration: 'unknown'` when `beforeExecute` did not run (another plugin short-circuited).

## 0.2.1

### Patch Changes

- ec4f43e: Stop bundling dependencies into published builds. Every package now builds with `bun build --packages external`, so `graphql` and sibling `@leaven-graphql/*` packages are imported instead of inlined. Previously each package carried its own copy of graphql-js, so any schema built with the consumer's `graphql` failed with "Cannot use GraphQLSchema … from another module or realm". `graphql` is now a peer dependency only (and a dev dependency for builds/tests), so a single copy is shared with the application.

## 0.2.0

### Minor Changes

- ef6b743: Reconcile `@leaven-graphql/errors` and `@leaven-graphql/context` with their
  implementations, and correct two error-shaping bugs.

  ### Breaking changes

  - **`@leaven-graphql/errors` — `extensions.code` can no longer be overridden.**
    `LeavenError` (and every subclass) now spreads `options.extensions` _before_
    the code, so `error.code` and `error.extensions.code` always agree. Previously
    `new NotFoundError('x', { extensions: { code: 'HACKED' } })` produced
    `code === 'NOT_FOUND'` but `extensions.code === 'HACKED'`, which also defeated
    the known-code check in `maskError`.
  - **`@leaven-graphql/errors` — uncoded `GraphQLError`s get a code.**
    `errorToGraphQL` (and therefore `formatError`/`formatErrors`) no longer passes
    a `GraphQLError` through untouched when it carries no `extensions.code`. Such
    errors — a bare `new GraphQLError('boom')` from a resolver, or a graphql-js
    validation error — are rebuilt with `extensions.code = INTERNAL_ERROR`,
    preserving `nodes`/`source`/`positions`/`path`/`originalError` so `locations`
    survive. A `GraphQLError` that already has a code is still returned by
    identity.

  ### Added

  - **`ErrorCode.PAYLOAD_TOO_LARGE`** (HTTP 413), registered in `ERROR_CODES`.
    `@leaven-graphql/http` already emits this code for oversized request bodies;
    `getErrorCode()` now resolves it and `buildResponse` maps it to 413 instead of
    falling back to 500.

  ### Fixed

  - **`NotFoundError`, `RateLimitError` and `InputError` no longer emit phantom
    `undefined` extension keys.** `resourceType`, `resourceId`, `retryAfter` and
    `field` are only added to `extensions` when supplied, so
    `new NotFoundError().extensions` is `{ code: 'NOT_FOUND' }` rather than a bag
    of `undefined`s visible to in-process loggers and hooks.

  ### Documentation

  - **`packages/errors/README.md` rewritten.** The published README documented an
    API that did not exist: masking options that were silent no-ops
    (`maskMessage`/`maskInternalErrors`/`allowedCodes` instead of
    `maskErrors`/`maskedMessage`/`shouldMask`/`includeStackTrace`/`formatter`), a
    `LeavenError` options-bag `code` (it is the second positional argument), a
    `ValidationError` field/value object (it is an array of field errors),
    `NotFoundError`'s `resource`/`id` (really `resourceType`/`resourceId`),
    `getErrorCode(error)` (it takes a code _string_), a non-existent
    `includeExtensions` option and non-existent `COMPLEXITY_EXCEEDED` /
    `DEPTH_EXCEEDED` / `BAD_USER_INPUT` codes, plus an `isLeavenError(gqlError)`
    branch that is never taken. `PersistedQueryError` was missing entirely.
  - **`packages/context/README.md` rewritten.** It documented flat
    `context.url/method/headers/ip/userAgent` (the real state lives under
    `ctx.request`), a `createRequestContext` config of
    `includeHeaders`/`includeIp` (really
    `generateRequestId`/`trustProxy`/`proxyHeaders`), a throwing `getContext()`
    plus non-existent `getContextOrNull()`/`hasContext()` (the throwing variant is
    `requireContext()`), a fluent
    `withRequest`/`withUser`/`withDatabase`/`withLogger`/`withTracing` builder (the
    real surface is `extend`/`build`/`withInput`, and `createContextBuilder`
    requires a factory), and a `store.run(...)` example that passed a
    non-`BaseContext` to the synchronous `run` with an async callback. `getHeader`,
    `getClientIp`, `getElapsedTime`, `extend`, `toJSON` and `runAsync` are now
    documented.
    </content>
