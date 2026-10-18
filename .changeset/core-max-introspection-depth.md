---
'@leaven-graphql/core': minor
---

Add `maxIntrospectionDepth` (on `ExecutorConfig` and `ParseOptions`). When set, paths that enter
`__schema` or `__type` at an operation root count against it instead of `maxDepth`, so
`getIntrospectionQuery()` (depth 15) passes under a typical `maxDepth: 10` while introspection
stays bounded. When unset nothing changes: introspection counts against `maxDepth`. Either limit
raises a `DepthLimitError` whose `extensions.limit` names the limit (only when
`maxIntrospectionDepth` is configured). The option is part of the document-cache fingerprint.
New `calculateQueryDepths(document)` returns `{ depth, introspectionDepth }`.
