# @leaven-graphql/errors

## 0.3.0

### Minor Changes

- 37f6299: Export `fromFormattedError` from `@leaven-graphql/errors`. It rebuilds a `GraphQLError` from an
  already-serialised `GraphQLFormattedError` (what `LeavenExecutor` returns), so `formatError` can
  mask it without turning it into `"[object Object]"` or losing its code, path and locations.
  `@leaven-graphql/http` now uses the shared helper instead of its private copy; its behaviour is
  unchanged.

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

- ef6b743: Reconcile the documented API with the implementation and add streaming GraphQL
  subscriptions to the NestJS integration.

  While Leaven is pre-1.0 these releases are versioned `minor`, so the entries
  below include **breaking changes**. Read them before upgrading.

  ### Breaking changes

  - **`@leaven-graphql/http` — `buildResponse` status mapping.** HTTP status codes
    are now derived from `ERROR_CODES` instead of an inline table, so some error
    responses return a different status than before. Clients that branch on the
    status of a GraphQL error response should be re-checked.
  - **`@leaven-graphql/nestjs` — `SubscriptionManager.publish` renamed to
    `publishToTopic`.** The new method keys on a **server-side topic** rather than
    the client-supplied operation id, so a single publish fans out to every
    subscriber of the topic. `publish` remains as a `@deprecated` shim that
    forwards to `publishToTopic`; it will be removed in a future release. Note
    this is the `SubscriptionManager` in `@leaven-graphql/nestjs`, not the
    same-named class in `@leaven-graphql/ws`, which has neither method.
  - **`@leaven-graphql/nestjs` — `GqlExecutionContext` path accessors.**
    `getPath()` keeps returning `string[]` (field names only). The new
    `getFullPath()` returns the complete response path _including list indices_.
    Code that expected indices from `getPath()` must move to `getFullPath()`.
  - **`@leaven-graphql/nestjs` — subscription filters now actually filter.**
    `@SubscriptionFilter` and `@Subscription({ filter })` wrap the decorated
    method and filter the events it yields. Previously-registered filters that
    were no-ops will start suppressing events.
  - **`@leaven-graphql/nestjs` — `LeavenModuleAsyncOptions` is now a discriminated
    union.** Exactly one of `useFactory`, `useClass`, or `useExisting` must be
    supplied; objects that set several (or none) no longer type-check.
  - **`@leaven-graphql/nestjs` — driver error code renamed.**
    `INTERNAL_SERVER_ERROR` is now `INTERNAL_ERROR`.
  - **`@leaven-graphql/nestjs` — CORS is opt-in.** The GraphQL middleware emits no
    `Access-Control-*` headers unless `LeavenModuleOptions.cors` is set to `true`
    or an options object, and leaves `OPTIONS` preflights to the application. A
    stock `LeavenModule.forRoot({ schema })` no longer answers every GraphQL POST
    with `Access-Control-Allow-Origin: *`. Deployments that relied on the previous
    always-on default must now set `cors` explicitly. When it _is_ enabled, the
    allowed origin is reflected rather than defaulted to `*` whenever an
    allowlist is configured, `Vary: Origin` is emitted whenever the value depends
    on the request, and `*` is never paired with `credentials: true`.
  - **`@leaven-graphql/ws` — `WebSocketContext.connectionId` is now an opaque
    UUIDv4.** It was previously a parseable `Date.now()`-prefixed string. Treat it
    as an opaque identifier: do **not** parse it, sort by it, or derive a
    connection timestamp from it.
  - **`@leaven-graphql/plugins` — complexity scores changed.** Pagination
    arguments supplied as variables are now resolved (previously they fell back to
    a fixed multiplier of `10`), non-positive literals are rejected instead of
    driving scores negative, and multipliers compound across nesting. An
    unresolvable page size uses the new `unknownMultiplier` option (default
    `100`). **Existing `maxComplexity` budgets will need raising.**
  - **`@leaven-graphql/plugins` — `createCachingPlugin` requires an explicit cache
    key policy.** It now throws unless given either a `keyFn` or
    `allowSharedCache: true`. The default key never contained user or tenant
    identity, so responses could be served across callers; opting in is now
    deliberate.
  - **`@leaven-graphql/core` — `CompiledQuery` no longer inlines fragment
    spreads.** `CompiledField.children` excludes fragment fields, which are
    reachable via the new `CompiledField.fragmentSpreads` and
    `CompiledQuery.fragments`; `getFieldNames()` now returns distinct names. This
    is what makes fragment analysis linear rather than exponential.
  - **`@leaven-graphql/core` — query analysis is bounded.** Depth and complexity
    analysis now abort with an error once a document exceeds an internal visit
    budget, so a small document with deeply fanned-out fragments can no longer
    consume unbounded CPU and memory.
  - **Removed options.** Five inert options have been **removed** from their
    interfaces rather than deprecated. They previously type-checked and did
    nothing; under `strict` an object literal that still sets one is now an
    excess-property compile error, so this surfaces at build time rather than
    silently.
    - `@leaven-graphql/core`: `CompilerOptions.cacheHints` — there is no
      field-level cache-hint mechanism to enable. Delete the property.
    - `@leaven-graphql/core`: `ParseOptions.cache` — document caching is
      configured on the executor via `ExecutorConfig.cache`, never here. Delete
      the property and set `cache` on `LeavenExecutor` instead.
    - `@leaven-graphql/http`: `ResponseOptions.cors` — `buildResponse` never read
      it. Build the headers with the exported `corsHeaders(request, config)` and
      pass them through `ResponseOptions.headers`, or set `cors` on the handler /
      server config, which does apply them.
    - `@leaven-graphql/schema`: `MergeOptions.includeBuiltInDirectives` and
      `MergeOptions.typeMerger` — neither was ever consulted. `MergeOptions` now
      has exactly one member, `onTypeConflict`. There is no replacement for
      `typeMerger`; use `onTypeConflict` plus the `resolvers` argument to
      `mergeSchemas`.
  - **`@leaven-graphql/schema` — a failed merge now throws.** When the merged SDL
    cannot be built into a schema, `mergeSchemas`/`mergeSchemasFromStrings` throw
    `Failed to merge schemas: …` (with the underlying error as `cause`). They
    previously swallowed the failure and fell back to concatenating the raw type
    definitions, producing a schema that was wrong in a different way.
  - **`@leaven-graphql/schema` — mismatched type kinds now throw.** If two source
    schemas declare the same type name as different kinds (a custom scalar in one,
    an object type in the other), `mergeSchemas` fails at composition time instead
    of yielding a schema that misbehaves per request.

  ### Fixes

  - **`@leaven-graphql/http` — multipart `map` paths are restricted.** A file path
    in a `multipart/form-data` upload must now start with `variables` or
    `operations`, and no segment may be `__proto__`, `constructor`, or
    `prototype`. Intermediates are created with a null prototype and traversal
    uses `hasOwnProperty` rather than `in`. An unauthenticated request mapping a
    file to `__proto__.polluted` previously wrote straight into
    `Object.prototype`. Paths outside those roots are now dropped.
  - **`@leaven-graphql/http` — `errorFormatting` no longer destroys execution
    errors.** The executor hands back already-formatted errors, and passing one of
    those to `formatError` stringified it to `"[object Object]"`. Each error is
    now rebuilt into a `GraphQLError` before formatting, so messages, codes, and
    extensions survive.
  - **`@leaven-graphql/http` — partial successes stay 200.** A response that
    carries `data` alongside `errors` is a spec-conformant partial success and now
    keeps its 200 status even when the errors carry codes that map to a 4xx/5xx.
    Only a total failure (`data` absent or `null`) derives its status from the
    first error's code. Clients no longer discard data they were handed as though
    the request had failed.
  - **`@leaven-graphql/http` — `maxBodySize` has a default.** Request bodies are
    now capped at 1,000,000 bytes unless `HandlerConfig.maxBodySize` says
    otherwise; the limit was previously unbounded when the option was omitted. It
    is enforced both from `Content-Length` and while reading the stream, since the
    header may be absent, malformed, or lying, and an oversized body is rejected
    with `PAYLOAD_TOO_LARGE` (HTTP 413).
  - **`@leaven-graphql/ws` — subscriptions are keyed per connection.**
    `SubscriptionManager` now stores subscriptions as `connectionId ->
subscriptionId -> Subscription`. graphql-ws operation ids are unique only
    _within_ a connection — reference clients use a per-connection counter
    starting at `"1"` — so the previous flat map let one connection's `subscribe`
    clobber another's, and one connection's `complete` tear another's down.
  - **`@leaven-graphql/ws` — queries and mutations are accepted over
    graphql-ws.** A `Subscribe` frame is the graphql-ws transport for _every_
    operation, not just subscriptions. Single-result operations are now routed to
    `SubscriptionManager.execute` on the same executor, so both transports honour
    the same limits and share the same caches. They previously failed with
    "Schema is not configured to execute subscription operation."
  - **`@leaven-graphql/core` — `maxDepth` is part of the validation-cache
    fingerprint.** The document cache key now covers the effective parser options,
    including a `maxDepth` configured on the executor. A document parsed under a
    permissive `maxDepth` could previously be served from cache to an executor
    configured with a strict one, whose depth check never re-ran.
  - **`@leaven-graphql/core` — `subscribe()` returns errors instead of throwing.**
    Validation failures and non-iterable subscription results now come back as a
    `GraphQLResponse` carrying `errors`, so transports can forward them to the
    client rather than crashing the connection.
  - **`@leaven-graphql/core` — `subscribe()` now enforces the same limits as
    `execute()`.** Both run one shared pipeline (parse → validate → compile →
    complexity) and fire the same hooks. A `maxComplexity` or `maxDepth` budget
    previously applied only to queries and mutations, leaving subscriptions —
    the longest-lived operations — unmeasured. Documents that were accepted
    before may now be rejected.
  - **`@leaven-graphql/ws` — `SubscriptionManager` is keyed per connection.**
    `unsubscribe(connectionId, subscriptionId)` and
    `getSubscription(connectionId, subscriptionId)` now require both arguments.
    Subscriptions were previously stored in one global map keyed by the
    client-chosen operation id, which is only unique per connection — so two
    clients both using `"1"` clobbered each other, and one disconnecting
    silently killed the other's stream.
  - **`@leaven-graphql/nestjs` — `introspection` and `maxDepth` are now
    forwarded to the executor.** Both options were accepted and silently
    discarded. `introspection: false` genuinely blocks `__schema` queries now
    (previously it did nothing, leaving the schema exposed in production), and
    `maxDepth` is enforced by the executor rather than only by an optional
    guard.
  - **`@leaven-graphql/schema` — `mergeSchemas` no longer drops type extensions.**
    The extension-kind check tested `startsWith('TypeExtension')`, which never
    matches (the AST kinds _end_ with it, e.g. `ObjectTypeExtension`), so every
    `extend type …` was treated as a conflicting redefinition and discarded under
    the default `'first'` policy. Fields contributed by `extend type Query { … }`
    and friends now survive the merge.
  - **`@leaven-graphql/leaven` — invalid subpath exports removed.** The package
    declared `./core`, `./schema`, `./http`, `./ws`, `./context`, `./errors`,
    `./plugins`, and `./playground`, each targeting a bare package specifier.
    `exports` targets must start with `./`, so every one of those subpaths failed
    to resolve — `ERR_INVALID_PACKAGE_TARGET` under Node, "Cannot find module"
    under Bun. They have been removed; the package has a single entry point.
    Import the scoped packages directly for anything the barrel does not
    re-export.
  - **`@leaven-graphql/schema` — `mergeSchemas` re-attaches executable
    functions.** Merging round-trips through SDL, which drops everything that is
    not a type definition. Field `resolve`/`subscribe`, `isTypeOf`, `resolveType`,
    and custom scalar `serialize`/`parseValue`/`parseLiteral` are now copied back
    onto the merged schema, with `onTypeConflict` deciding which source wins.

  ### New features

  - **`@leaven-graphql/errors` — `ErrorCode.PAYLOAD_TOO_LARGE`.** A new code
    registered in `ERROR_CODES` with `status: 413`, emitted by
    `@leaven-graphql/http` for oversized request bodies.
  - **Streaming GraphQL subscriptions over WebSocket in
    `@leaven-graphql/nestjs`.** Subscription resolvers can return an
    `AsyncIterable` and have its events streamed to subscribers over the
    `graphql-ws` transport.
  - **PubSub dependency injection.** Inject the configured PubSub instance with
    `@InjectPubSub()` or the `LEAVEN_PUBSUB` token.
  - **New module options.** `LeavenModuleOptions.subscriptions` configures the
    WebSocket subscription transport, and `LeavenModuleOptions.pubSub` supplies the
    PubSub implementation to register for injection.

  ### Deprecated (accepted, but no longer functional)

  These options still type-check and are marked `@deprecated`; they are ignored at
  runtime and will be removed in a future release.

  - `@leaven-graphql/schema`: `LoaderOptions.encoding` — files are always read as
    UTF-8.
  - `@leaven-graphql/nestjs`: `LeavenModuleOptions.plugins`,
    `LeavenModuleOptions.sortSchema`, `LeavenModuleOptions.buildSchemaOptions`,
    `LeavenModuleOptions.debug`
