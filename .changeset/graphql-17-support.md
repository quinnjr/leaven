---
'@leaven-graphql/core': minor
'@leaven-graphql/errors': minor
'@leaven-graphql/http': minor
'@leaven-graphql/leaven': minor
'@leaven-graphql/nestjs': minor
'@leaven-graphql/plugins': minor
'@leaven-graphql/schema': minor
'@leaven-graphql/sse': minor
'@leaven-graphql/ws': minor
---

Support graphql 17. The `graphql` peer range is now `^16.0.0 || ^17.0.0`, and the test suite passes against both majors.

`mergeSchemas` in `@leaven-graphql/schema` now also carries a custom scalar's graphql 17 coercion functions (`coerceOutputValue`, `coerceInputValue`, `coerceInputLiteral`, `valueToLiteral`) onto the merged schema. Under graphql 17 a merged custom scalar previously fell back to the default coercion, so its `serialize` was ignored.

`@leaven-graphql/nestjs` now imports `ModuleMetadata` from the `@nestjs/common` root, which makes it compatible with NestJS 12 (that release no longer resolves the `@nestjs/common/interfaces` subpath).
