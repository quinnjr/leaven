---
'@leaven-graphql/sse': minor
'@leaven-graphql/http': minor
'@leaven-graphql/leaven': minor
---

Add GraphQL over Server-Sent Events (graphql-sse distinct connections mode): the new `@leaven-graphql/sse` package and an opt-in `sse` option on the HTTP handler and server. Mutations sent with GET are now rejected with 405 and `Allow: POST`.
