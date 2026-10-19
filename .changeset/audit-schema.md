---
'@leaven-graphql/schema': minor
---

Fix schema merging:

- **Custom root types:** `mergeSchemas`, `mergeSchemasFromStrings` and the directory and glob loaders now keep custom root operation types (`schema { query: RootQuery }` and `extend schema`). Before, they silently dropped them. When two sources name different root types for the same operation, the losing root's fields are merged into the winning root. Resolvers keyed by the losing root's name (in the sources or in the `resolvers` argument) are applied to the winning root, and also to the losing type if another type still references it; a field only the winning root has is not an error there.
- **Schema directives and description:** merging now keeps schema-level directives (`schema @link(...)`, `extend schema @tag`) and the schema description, which were dropped before. A repeatable directive keeps every distinct occurrence, deduped by its printed form; a non-repeatable one keeps the first source's. The description is the first source's that has one. In `mergeSchemas`, directives are kept for sources built from SDL, and the description for all sources.
- **Subscriptions:** a bare function under the subscription root in the merge `resolvers` argument is now applied as `subscribe`, matching `SchemaBuilder`. Wrap payload mappers as `{ resolve: fn }`.
- **Docs:** `getDirectiveValues` and the glob loaders' ignored options are now documented accurately.
