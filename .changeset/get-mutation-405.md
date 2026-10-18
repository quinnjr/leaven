---
'@leaven-graphql/http': minor
---

Reject mutations sent with GET. The handler now answers a GET request whose selected operation is a mutation with `405 Method Not Allowed` and an `Allow: POST` header, before the context factory runs, whether or not `sse` is enabled. Send mutations with POST.
