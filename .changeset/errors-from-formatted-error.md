---
'@leaven-graphql/errors': minor
'@leaven-graphql/http': patch
---

Export `fromFormattedError` from `@leaven-graphql/errors`. It rebuilds a `GraphQLError` from an
already-serialised `GraphQLFormattedError` (what `LeavenExecutor` returns), so `formatError` can
mask it without turning it into `"[object Object]"` or losing its code, path and locations.
`@leaven-graphql/http` now uses the shared helper instead of its private copy; its behaviour is
unchanged.
