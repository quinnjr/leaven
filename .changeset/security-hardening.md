---
'@leaven-graphql/playground': patch
'@leaven-graphql/core': patch
'@leaven-graphql/ws': patch
'@leaven-graphql/nestjs': patch
---

Security hardening for the playground, the executor caches and the WebSocket transport

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
  nor given a keep-alive timer.
