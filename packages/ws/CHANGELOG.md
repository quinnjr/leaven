# @leaven-graphql/ws

## 0.4.0

### Minor Changes

- 3877881: Harden the graphql-ws handler and `PubSub`:
  
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
- ab4ed47: Support graphql 17. The `graphql` peer range is now `^16.0.0 || ^17.0.0`, and the test suite passes against both majors.
  
  `mergeSchemas` in `@leaven-graphql/schema` now also carries a custom scalar's graphql 17 coercion functions (`coerceOutputValue`, `coerceInputValue`, `coerceInputLiteral`, `valueToLiteral`) onto the merged schema. Under graphql 17 a merged custom scalar previously fell back to the default coercion, so its `serialize` was ignored.
  
  `@leaven-graphql/nestjs` now imports `ModuleMetadata` from the `@nestjs/common` root, which makes it compatible with NestJS 12 (that release no longer resolves the `@nestjs/common/interfaces` subpath).

### Patch Changes

- Updated dependencies [3877881]
- Updated dependencies [ab4ed47]
  - @leaven-graphql/core@0.5.0
  - @leaven-graphql/context@0.2.2
  - @leaven-graphql/errors@0.4.0

## 0.3.2

### Patch Changes

- 507d308: Bound `onConnect` by `connectionInitTimeout`. The handler stopped its init timer when `connection_init` arrived, so an `onConnect` that never settled kept the socket open, unacknowledged, forever. If `onConnect` has not settled within `connectionInitTimeout` after `connection_init`, the socket is now closed with `4408 Connection initialization timeout` (the code and reason of the existing init timeout), and the late result is ignored: no `connection_ack`, no keep-alive timer, and a late rejection is logged through the configured logger instead of closing the socket again.
- Updated dependencies [507d308]
  - @leaven-graphql/core@0.4.1

## 0.3.1

### Patch Changes

- Updated dependencies [998bbaf]
  - @leaven-graphql/core@0.4.0

## 0.3.0

### Minor Changes

- 37f6299: Format and mask every error the WebSocket transport sends, as `@leaven-graphql/http` does.

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

### Patch Changes

- Updated dependencies [37f6299]
- Updated dependencies [37f6299]
- Updated dependencies [37f6299]
- Updated dependencies [37f6299]
  - @leaven-graphql/core@0.3.0
  - @leaven-graphql/errors@0.3.0

## 0.2.3

### Patch Changes

- 801ced0: Security re-audit fixes: operation id validation, log escaping and bounded caches

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

- Updated dependencies [801ced0]
  - @leaven-graphql/core@0.2.3

## 0.2.2

### Patch Changes

- 6e305fc: Security hardening for the playground, the executor caches and the WebSocket transport

  - **playground**: `renderPlayground` loads `graphql-playground-react@1.7.28`
    (1.7.26 is affected by CVE-2021-41249), and `renderGraphiQL` pins
    `react`/`react-dom` to `18.3.1` instead of the floating `@18`.
  - **core**: the compiled-query cache is keyed by the full query string and a
    length-prefixed operation name instead of a 64-bit `Bun.hash`, so a
    collision can no longer reuse a cheap query's complexity result.
    `DocumentCache` (queries over `directKeyMaxLength`) and `RedisDocumentCache`
    key by SHA-256, accept an injectable `hashKey`, store each entry's full
    query and only hit on an exact match. Only documents that pass validation
    are cached. New `executor.parse(query)` parses under the executor's limits.
  - **ws**: a second `connection_init` while `onConnect` is still running closes
    with 4429, and a connection never has more than one keep-alive timer. An
    operation still setting up when the socket closes, or when the client
    completes its id, registers nothing and has its iterator returned;
    reusing that id afterwards is safe. `SubscriptionManager.subscribe` refuses
    to overwrite an existing id, and operations still setting up count toward
    `maxSubscriptionsPerConnection`. Operation-type detection parses with the
    executor's `maxTokens`/depth limits. `WebSocketHandler`,
    `SubscriptionManager` and `PubSub` accept a `logger` (default `console`).
  - **nestjs**: the NestJS subscription transport gets the same
    `connection_init` fix: a second init while `onConnect` is running closes
    with 4429, and a socket closed during `onConnect` is neither acknowledged
    nor given a keep-alive timer. A new `parseOptions` option (core
    `ParseOptions` shape) on `LeavenModule` and `LeavenGraphQLDriver` sets the
    parser limits, with `maxTokens` defaulting to 10000 (`Infinity` opts out).
    It is applied by the executor, the guard query analysis and the
    subscription transport's synchronous operation-type detection, which
    previously used an unbounded `parse()`; an over-limit document is rejected
    through the executor's normal error response.

- Updated dependencies [6e305fc]
  - @leaven-graphql/core@0.2.2

## 0.2.1

### Patch Changes

- ec4f43e: Stop bundling dependencies into published builds. Every package now builds with `bun build --packages external`, so `graphql` and sibling `@leaven-graphql/*` packages are imported instead of inlined. Previously each package carried its own copy of graphql-js, so any schema built with the consumer's `graphql` failed with "Cannot use GraphQLSchema … from another module or realm". `graphql` is now a peer dependency only (and a dev dependency for builds/tests), so a single copy is shared with the application.
- Updated dependencies [ec4f43e]
  - @leaven-graphql/context@0.2.1
  - @leaven-graphql/core@0.2.1
  - @leaven-graphql/errors@0.2.1

## 0.2.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [ef6b743]
- Updated dependencies [5a35fac]
- Updated dependencies [ef6b743]
  - @leaven-graphql/errors@0.2.0
  - @leaven-graphql/context@0.2.0
  - @leaven-graphql/core@0.2.0
