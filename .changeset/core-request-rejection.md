---
'@leaven-graphql/core': minor
---

Add `isRequestRejection(response)`, which identifies a response the executor produced because it rejected the request before running any resolver (syntax error, parser limits, validation, complexity, operation selection, variable coercion). It is identity-based and changes nothing on the wire. Transports use it to decide which failures are safe to answer with a non-200 status.

Fix: an `onError` hook that throws or rejects no longer escapes `execute()` or `subscribe()`; the original error is still returned as `{ errors: [...] }`.
