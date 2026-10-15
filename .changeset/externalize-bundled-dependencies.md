---
"@leaven-graphql/context": patch
"@leaven-graphql/core": patch
"@leaven-graphql/errors": patch
"@leaven-graphql/http": patch
"@leaven-graphql/leaven": patch
"@leaven-graphql/nestjs": patch
"@leaven-graphql/playground": patch
"@leaven-graphql/plugins": patch
"@leaven-graphql/schema": patch
"@leaven-graphql/ws": patch
---

Stop bundling dependencies into published builds. Every package now builds with `bun build --packages external`, so `graphql` and sibling `@leaven-graphql/*` packages are imported instead of inlined. Previously each package carried its own copy of graphql-js, so any schema built with the consumer's `graphql` failed with "Cannot use GraphQLSchema … from another module or realm". `graphql` is now a peer dependency only (and a dev dependency for builds/tests), so a single copy is shared with the application.
