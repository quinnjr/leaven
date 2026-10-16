# @leaven-graphql/playground

## 0.2.1

### Patch Changes

- ec4f43e: Stop bundling dependencies into published builds. Every package now builds with `bun build --packages external`, so `graphql` and sibling `@leaven-graphql/*` packages are imported instead of inlined. Previously each package carried its own copy of graphql-js, so any schema built with the consumer's `graphql` failed with "Cannot use GraphQLSchema … from another module or realm". `graphql` is now a peer dependency only (and a dev dependency for builds/tests), so a single copy is shared with the application.

## 0.2.0

### Minor Changes

- 2d549b9: Escape every value interpolated into the rendered playground HTML

  `renderPlayground` and `renderGraphiQL` interpolated caller-supplied values —
  `title`, the GraphiQL `version`, the endpoint and the initial query/variables —
  straight into the HTML document they return. A value containing markup could
  therefore close the surrounding tag and inject script into the served page.

  Both renderers now route text through `escapeHtml` and embedded JSON through
  `toScriptJson`, so a hostile `title` or endpoint is rendered as text rather
  than markup.

  This shipped in the API reconciliation but was left off that changeset, so
  `@leaven-graphql/playground` would have stayed at 0.1.0 and the fix would never
  have reached npm.
