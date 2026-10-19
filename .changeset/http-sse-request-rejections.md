---
'@leaven-graphql/http': patch
---

On the SSE path, a request whose `onParse`, `onParsed`, `onValidate` or `onValidated` hook throws, or whose document cache read fails, is now answered as a non-200 JSON request error instead of a `200` event stream (see `@leaven-graphql/core`'s wider `isRequestRejection`). Nothing ran, so the `graphql-sse` client's retry is harmless; streaming it would have looked like a successful operation.
