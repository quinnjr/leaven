---
'@leaven-graphql/core': patch
---

`isRequestRejection(response)` now covers every failure before execution starts, not only the executor's own analysis. A throw or rejection from the `onParse`, `onParsed`, `onValidate` or `onValidated` hooks, or a document cache read failure, ran no resolver, so `execute()` and `subscribe()` now mark the response they return for it. A throw from `onExecute`, `onExecuted` or anything else once execution started is still never marked. Transports that answer request rejections as non-200 (such as the `@leaven-graphql/http` SSE path, through `isRequestError`) now answer these failures as JSON instead of streaming them.
