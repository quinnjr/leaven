# @leaven-graphql/context

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
