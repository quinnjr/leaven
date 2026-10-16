# @leaven-graphql/playground

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

## 0.2.1

### Patch Changes

- ec4f43e: Stop bundling dependencies into published builds. Every package now builds with `bun build --packages external`, so `graphql` and sibling `@leaven-graphql/*` packages are imported instead of inlined. Previously each package carried its own copy of graphql-js, so any schema built with the consumer's `graphql` failed with "Cannot use GraphQLSchema … from another module or realm". `graphql` is now a peer dependency only (and a dev dependency for builds/tests), so a single copy is shared with the application.

## 0.2.0

### Minor Changes

- 2d549b9: Escape every value interpolated into the rendered playground HTML

  `renderPlayground` and `renderGraphiQL` interpolated caller-supplied values —
  `title`, the GraphiQL `version`, the endpoint and the initial query/variables —
  straight into the HTML document they return. A value containing markup could
  therefore close the surrounding tag and inject script into the served page.

  Both renderers now route text through `escapeHtml` and embedded JSON through
  `toScriptJson`, so a hostile `title` or endpoint is rendered as text rather
  than markup.

  This shipped in the API reconciliation but was left off that changeset, so
  `@leaven-graphql/playground` would have stayed at 0.1.0 and the fix would never
  have reached npm.
