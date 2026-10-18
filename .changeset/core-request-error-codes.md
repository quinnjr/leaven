---
'@leaven-graphql/core': patch
---

Give request errors a client `ErrorCode`. graphql-js reports syntax, validation and
variable-coercion failures without `extensions.code`, so `@leaven-graphql/http` answered them
with 500 and, with `maskErrors`, replaced the message with "An unexpected error occurred" (the
same happened over the WebSocket transport). The executor now codes them, keeping their
`locations`: syntax errors and an exceeded `maxTokens` are `PARSE_ERROR`, validation errors
(including disabled introspection) are `VALIDATION_ERROR`, and variable-coercion errors are
`BAD_REQUEST` (applied before `formatExecutionError`). All three map to HTTP 400. Errors that
already carry a code, and resolver errors, are unchanged.
