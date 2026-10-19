# @leaven-graphql/schema

Schema building and merging utilities for Leaven.

## Installation

```bash
bun add @leaven-graphql/schema graphql
```

## Quick Start

```typescript
import { SchemaBuilder } from '@leaven-graphql/schema';

const builder = new SchemaBuilder();

// Define types — addType takes a single TypeDefinition object
builder.addType({
  name: 'User',
  fields: {
    id: { type: 'ID!' },
    name: { type: 'String!' },
    email: { type: 'String!' },
  },
});

// Define query fields
builder.addQueryFields({
  user: {
    type: 'User',
    args: { id: { type: 'ID!' } },
    // SchemaBuilder types resolve() as (unknown, unknown, unknown, unknown),
    // so a strict build narrows the arguments it needs.
    resolve: (_parent, args, context) =>
      (context as AppContext).db.users.findById((args as { id: string }).id),
  },
});

// Build the schema
const schema = builder.build();
```

## Features

### Schema Builder

Fluent API for building schemas programmatically. Every `add*` method takes a
single configuration object and returns the builder, so calls can be chained.

```typescript
import { SchemaBuilder } from '@leaven-graphql/schema';

const builder = new SchemaBuilder();

// Add object types
builder.addType({
  name: 'User',
  fields: {
    id: { type: 'ID!' },
    name: { type: 'String!' },
    email: { type: 'String!' },
    posts: { type: '[Post!]!' },
  },
});

builder.addType({
  name: 'Post',
  fields: {
    id: { type: 'ID!' },
    title: { type: 'String!' },
    content: { type: 'String' },
    author: { type: 'User!' },
  },
});

// Add an input type
builder.addInputType({
  name: 'CreateUserInput',
  fields: {
    name: { type: 'String!' },
    email: { type: 'String!' },
  },
});

// Add query fields — one call may register several fields
builder.addQueryFields({
  user: {
    type: 'User',
    args: { id: { type: 'ID!' } },
    // SchemaBuilder types resolve() as (unknown, unknown, unknown, unknown),
    // so a strict build narrows the arguments it needs.
    resolve: (_parent, args, context) =>
      (context as AppContext).db.users.findById((args as { id: string }).id),
  },
  users: {
    type: '[User!]!',
    resolve: (_parent, _args, context) => (context as AppContext).db.users.findAll(),
  },
});

// Add mutation fields
builder.addMutationFields({
  createUser: {
    type: 'User!',
    args: { input: { type: 'CreateUserInput!' } },
    resolve: (_parent, args, context) =>
      (context as AppContext).db.users.create((args as { input: unknown }).input),
  },
});

// Add subscription fields — `subscribe` produces the event stream, and each
// payload is handed to `resolve` (or the default resolver) as the parent value
builder.addSubscriptionFields({
  userCreated: {
    type: 'User!',
    subscribe: (_parent, _args, context) =>
      (context as AppContext).pubsub.subscribe('userCreated'),
  },
});

const schema = builder.build();
```

Scalars, enums, interfaces and unions each take their own config object:

```typescript
builder.addScalar({
  name: 'Date',
  description: 'An ISO-8601 date-time',
  serialize: (value) => (value as Date).toISOString(),
  parseValue: (value) => new Date(value as string),
});

builder.addEnum({
  name: 'Status',
  values: {
    ACTIVE: { value: 'active' },
    INACTIVE: { value: 'inactive', deprecationReason: 'Use ACTIVE' },
  },
});

builder.addInterface({
  name: 'Node',
  fields: { id: { type: 'ID!' } },
});

builder.addType({
  name: 'Cat',
  interfaces: ['Node'],
  fields: { id: { type: 'ID!' }, meows: { type: 'Boolean!' } },
});

builder.addUnion({
  name: 'Pet',
  types: ['Cat', 'Dog'],
  // `resolveType` receives `unknown`, so narrow it here.
  resolveType: (value) => ((value as { meows?: boolean }).meows !== undefined ? 'Cat' : 'Dog'),
});
```

Resolvers can also be attached separately from the type definitions with
`applyResolvers`. Unknown type and field names throw, so typos fail while the
schema is being assembled instead of resolving to `null` at runtime:

```typescript
builder.addType({
  name: 'User',
  fields: {
    firstName: { type: 'String!' },
    lastName: { type: 'String!' },
    fullName: { type: 'String!' },
  },
});

builder.applyResolvers({
  User: {
    // Parent values arrive as `unknown`; narrow at the point of use.
    fullName: (user) => {
      const { firstName, lastName } = user as { firstName: string; lastName: string };
      return `${firstName} ${lastName}`;
    },
  },
});
```

`build()` may be called more than once; each call returns a fresh schema that
reflects everything registered so far, including resolvers applied after an
earlier build.

### Schema Merging

Combine multiple schemas. Types that appear in more than one source are merged
field by field, so every source keeps its `Query`, `Mutation` and
`Subscription` fields — along with their resolvers.

```typescript
import { mergeSchemas, mergeSchemasFromStrings } from '@leaven-graphql/schema';

// Merge existing schemas
const merged = mergeSchemas([usersSchema, postsSchema, commentsSchema]);

// Optionally attach extra resolvers and pick a conflict policy
const withOverrides = mergeSchemas(
  [usersSchema, postsSchema],
  { Query: { users: () => [] } },
  { onTypeConflict: 'last' }
);

// Merge from SDL strings — `extend type` is always folded into the base type
const schema = mergeSchemasFromStrings([
  `
    type Query {
      users: [User!]!
    }
    type User {
      id: ID!
      name: String!
    }
  `,
  `
    extend type Query {
      posts: [Post!]!
    }
    type Post {
      id: ID!
      title: String!
    }
  `,
]);
```

Schema-level directives (`schema @link(...) { ... }`, `extend schema @tag`)
survive both functions. A non-repeatable directive is kept once, with the first
source winning. A repeatable directive keeps every distinct occurrence and
drops only exact duplicates. `mergeSchemas` rebuilds from `printSchema`, which
never prints schema-level directives, so it reads them from each source's
`astNode` and `extensionASTNodes`. graphql-js sets those only on schemas built
from SDL. A schema built in code (`new GraphQLSchema({ ... })`, `SchemaBuilder`)
has none. If you need schema directives preserved reliably, merge from SDL with
`mergeSchemasFromStrings` or the loaders instead. The schema description is
kept by both functions, with the first source that has one winning, whether a
source was built from SDL or in code.

`onTypeConflict` decides who wins when two sources define the same thing:

| Value | `mergeSchemas` (per field) | `mergeSchemasFromStrings` (per definition) |
| --- | --- | --- |
| `'first'` (default) | first schema to define the field wins | first non-extension definition wins |
| `'last'` | last schema to define the field wins | last non-extension definition wins |
| `'error'` | throws when two schemas define the same field | throws on a duplicate non-extension definition |

`extend type ...` is always merged into its base definition, including under
`'error'`. Note the argument order: the **second** parameter of both functions
is the resolvers map and the **third** is the options bag. Passing
`{ onTypeConflict: 'last' }` as the second argument sets no options — it is
read as a resolvers map, and any name in it that is not a type in the merged
schema (other than a root type folded into another) throws.

Custom root type names survive both functions: `schema { query: RootQuery }`
definitions and `extend schema` extensions are combined into one schema
definition. A source with its own `schema { ... }` definition is authoritative
for its roots, as in graphql-js. In a source without one (or with only
`extend schema`), a default-named `Query`, `Mutation` or `Subscription` object
type is the root of any operation it does not name, even when another source
has a `schema { ... }` block.

When two sources name different root types for the same operation (say
`schema { query: RootQuery }` in one and a plain `type Query` in another),
`onTypeConflict` picks the name — the first under `'first'` and `'error'`, the
last under `'last'` — and the losing root type's fields are merged into the
winner, so every source's root fields stay reachable. A field both root types
define follows `onTypeConflict` like any other field, so `'error'` throws only
on such a shared field, not on the differing names. The losing type is dropped
unless another type still references it, in which case it is kept as an
ordinary type. Resolvers keyed by the losing root's name (in a source or in
the `resolvers` argument) are applied to the winning root, and also to the
losing type when it is kept; only a field missing on the winner throws. As
with
`SchemaBuilder.applyResolvers`, a bare function in the resolvers map under the
subscription root type is applied as the field's `subscribe` function.

### Resolvers

Create and merge type-safe resolvers. `mergeResolvers` is variadic — pass the
resolver maps as separate arguments, not as an array.

```typescript
import { createResolvers, mergeResolvers } from '@leaven-graphql/schema';

// The context type parameter is what makes `context` typed inside a resolver;
// parent values stay `unknown`, so narrow them where you use them.
const userResolvers = createResolvers<AppContext>({
  Query: {
    user: async (_parent, args, context) =>
      context.db.users.findById((args as { id: string }).id),
    users: async (_parent, _args, context) => context.db.users.findAll(),
  },
  User: {
    posts: async (user, _args, context) =>
      context.db.posts.findByAuthor((user as User).id),
  },
});

const postResolvers = createResolvers<AppContext>({
  Query: {
    posts: async (_parent, _args, context) => context.db.posts.findAll(),
  },
  Post: {
    author: async (post, _args, context) =>
      context.db.users.findById((post as Post).authorId),
  },
});

// Merge resolvers — variadic, one argument per resolver map
const resolvers = mergeResolvers(userResolvers, postResolvers);
```

Helpers for common resolver shapes:

```typescript
import { wrapResolver, defaultResolver, constantResolver } from '@leaven-graphql/schema';

// Wrap a resolver with middleware
const logged = wrapResolver<unknown, unknown, AppContext, Record<string, unknown>>(
  (parent, args, context, info) => context.db.users.findAll(),
  (next, parent, args, context, info) => {
    console.log(info.fieldName);
    return next(parent, args, context, info);
  }
);

const name = defaultResolver('name');      // (parent) => parent.name
const version = constantResolver('1.0.0'); // () => '1.0.0'
```

### File Loaders

Load schemas from `.graphql` files. Directory and glob loaders read files in
sorted path order and merge them, so `extend type` definitions spread across
files are combined, and a `schema { query: RootQuery }` block in one file
applies to root types defined in another.

```typescript
import {
  loadSchemaFromFile,
  loadSchemaFromDirectory,
  loadSchemaFromGlob,
  loadTypeDefsFromDirectory,
  mergeSchemasFromStrings,
} from '@leaven-graphql/schema';

// Load a single file
const schema1 = await loadSchemaFromFile('./schema.graphql');

// Load all files in a directory
const schema2 = await loadSchemaFromDirectory('./schemas', { recursive: true });

// Load files matching a glob pattern. The pattern alone selects files:
// `extensions` and `recursive` are ignored by the glob loaders.
const schema3 = await loadSchemaFromGlob('**/*.graphql', { cwd: './modules' });

// Read the SDL without building, to merge it with resolvers yourself
const typeDefs = await loadTypeDefsFromDirectory('./schemas');
const schema4 = mergeSchemasFromStrings(typeDefs, resolvers);
```

### Custom Directives

`createDirective` builds a `GraphQLDirective`; `addDirective` installs it on a
schema; `applyDirectives` runs schema transformers keyed by directive name.
Directive argument types are declared as `'String'`, `'Boolean'` or `'Int'`.

```typescript
import { DirectiveLocation } from 'graphql';
import {
  cacheControlDirective,
  createDirective,
  addDirective,
  addDirectives,
  applyDirectives,
  getDirectiveValues,
} from '@leaven-graphql/schema';

// Create an @auth directive
const authDirective = createDirective({
  name: 'auth',
  description: 'Requires authentication',
  locations: [DirectiveLocation.FIELD_DEFINITION],
  args: {
    requires: { type: 'String', defaultValue: 'USER' },
  },
});

// Install transformers keyed by directive name
const schema = applyDirectives(baseSchema, {
  auth: (input) => addDirective(input, authDirective),
});

// Installing several at once rebuilds the schema only once
const schema2 = addDirectives(baseSchema, [authDirective, cacheControlDirective]);

// Read the arguments a directive was applied with
const fields = schema.getQueryType()!.toConfig().fields;
const args = getDirectiveValues(fields.secret!, 'auth'); // { requires: 'ADMIN' } | null
```

`getDirectiveValues` converts the raw SDL arguments only. It does not apply the
directive definition's `defaultValue`s (an omitted argument is absent from the
result, so `@auth` alone yields `{}`, not `{ requires: 'USER' }`) and does not
coerce values against the declared argument types. Use graphql-js
`getDirectiveValues(directive, node)` when you need defaults and coercion.

`authDirective`, `cacheControlDirective` and `specDeprecatedDirective` are
exported ready-made. `specDeprecatedDirective` is a replica of the spec
`@deprecated` directive that graphql-js already installs on every schema, so
passing it to `addDirective` is a no-op.

## API Reference

### SchemaBuilder

```typescript
class SchemaBuilder {
  constructor(config?: SchemaBuilderConfig);

  addScalar(config: ScalarConfig): this;
  addEnum(config: EnumConfig): this;
  addInterface(config: InterfaceConfig): this;
  addUnion(config: UnionConfig): this;
  addType(definition: TypeDefinition): this;
  addInputType(definition: InputTypeDefinition): this;

  addQueryFields(fields: Record<string, FieldDefinition>): this;
  addMutationFields(fields: Record<string, FieldDefinition>): this;
  addSubscriptionFields(fields: Record<string, FieldDefinition>): this;

  applyResolvers(resolvers: Resolvers): this;
  build(): GraphQLSchema;
}

function createSchemaBuilder(config?: SchemaBuilderConfig): SchemaBuilder;

interface SchemaBuilderConfig {
  query?: boolean;        // default true
  mutation?: boolean;     // default true
  subscription?: boolean; // default true
}

interface FieldDefinition {
  type: string; // e.g. "String", "Int!", "[User!]!"
  description?: string;
  deprecationReason?: string;
  args?: Record<string, { type: string; description?: string; defaultValue?: unknown }>;
  resolve?: (parent: unknown, args: unknown, context: unknown, info: unknown) => unknown;
  subscribe?: (parent: unknown, args: unknown, context: unknown, info: unknown) => unknown;
}

interface TypeDefinition {
  name: string;
  description?: string;
  fields: Record<string, FieldDefinition>;
  interfaces?: string[];
}

interface InputTypeDefinition {
  name: string;
  description?: string;
  fields: Record<string, { type: string; description?: string; defaultValue?: unknown }>;
}

interface ScalarConfig {
  name: string;
  description?: string;
  serialize: (value: unknown) => unknown;
  parseValue: (value: unknown) => unknown;
  parseLiteral?: (ast: unknown) => unknown;
}

interface EnumConfig {
  name: string;
  description?: string;
  values: Record<string, { value?: unknown; description?: string; deprecationReason?: string }>;
}

interface InterfaceConfig {
  name: string;
  description?: string;
  fields: Record<string, {
    type: string;
    description?: string;
    args?: Record<string, { type: string; description?: string; defaultValue?: unknown }>;
  }>;
  resolveType?: (value: unknown, context: unknown, info: unknown) => string | null;
}

interface UnionConfig {
  name: string;
  description?: string;
  types: string[];
  resolveType?: (value: unknown, context: unknown, info: unknown) => string | null;
}
```

### Schema Merging

```typescript
function mergeSchemas(
  schemas: GraphQLSchema[],
  resolvers?: Resolvers,
  options?: MergeOptions
): GraphQLSchema;

function mergeSchemasFromStrings(
  typeDefs: string[],
  resolvers?: Resolvers,
  options?: MergeOptions
): GraphQLSchema;

interface MergeOptions {
  onTypeConflict?: 'error' | 'first' | 'last'; // default 'first'
}
```

### Resolvers

```typescript
function createResolvers<TContext = unknown>(
  resolvers: Resolvers<TContext>
): Resolvers<TContext>;

function mergeResolvers<TContext = unknown>(
  ...resolverSets: Array<Resolvers<TContext>>
): Resolvers<TContext>;

function wrapResolver<TResult, TParent, TContext, TArgs>(
  resolver: ResolverFn<TResult, TParent, TContext, TArgs>,
  middleware: (
    next: ResolverFn<TResult, TParent, TContext, TArgs>,
    parent: TParent,
    args: TArgs,
    context: TContext,
    info: GraphQLResolveInfo
  ) => TResult | Promise<TResult>
): ResolverFn<TResult, TParent, TContext, TArgs>;

function defaultResolver<TParent>(fieldName: keyof TParent): ResolverFn;
function constantResolver<TResult>(value: TResult): ResolverFn;

type ResolverFn<
  TResult = unknown,
  TParent = unknown,
  TContext = unknown,
  TArgs = Record<string, unknown>,
> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo
) => TResult | Promise<TResult>;

interface FieldResolver<
  TResult = unknown,
  TParent = unknown,
  TContext = unknown,
  TArgs = Record<string, unknown>,
> {
  resolve?: ResolverFn<TResult, TParent, TContext, TArgs>;
  subscribe?: ResolverFn<AsyncIterator<TResult>, TParent, TContext, TArgs>;
}

type Resolvers<TContext = unknown> = {
  [typeName: string]: {
    [fieldName: string]: ResolverFn | FieldResolver;
  };
};
```

### File Loaders

```typescript
function loadSchemaFromFile(
  filePath: string,
  options?: LoaderOptions
): Promise<GraphQLSchema>;

function loadSchemaFromDirectory(
  directoryPath: string,
  options?: LoaderOptions & MergeOptions
): Promise<GraphQLSchema>;

function loadSchemaFromGlob(
  pattern: string,
  options?: LoaderOptions & MergeOptions & { cwd?: string }
): Promise<GraphQLSchema>;

function loadTypeDefsFromFile(filePath: string): Promise<string>;

function loadTypeDefsFromDirectory(
  directoryPath: string,
  options?: LoaderOptions
): Promise<string[]>;

function loadTypeDefsFromGlob(
  pattern: string,
  options?: LoaderOptions & { cwd?: string }
): Promise<string[]>;

interface LoaderOptions {
  /** File extensions to load (default: ['.graphql', '.gql']). Directory loaders only. */
  extensions?: string[];
  /** @deprecated Ignored — files are always read as UTF-8. Removed in 0.3.0. */
  encoding?: BufferEncoding;
  /** Whether to recursively search directories. Directory loaders only. */
  recursive?: boolean;
}
```

`loadSchemaFromFile` ignores its options bag entirely; it accepts one only so
it keeps the same call signature as the directory and glob loaders.

`loadSchemaFromGlob` and `loadTypeDefsFromGlob` ignore `extensions` and
`recursive`: the pattern alone decides which files match, so use `**` in the
pattern to search subdirectories. Only `cwd` (and, for `loadSchemaFromGlob`,
the merge options) take effect.

### Directives

```typescript
function createDirective(config: DirectiveConfig): GraphQLDirective;

function addDirective(
  schema: GraphQLSchema,
  directive: GraphQLDirective
): GraphQLSchema;

function addDirectives(
  schema: GraphQLSchema,
  directives: readonly GraphQLDirective[]
): GraphQLSchema;

function applyDirectives(
  schema: GraphQLSchema,
  transformers: Record<string, DirectiveTransformer>
): GraphQLSchema;

function getDirectiveValues(
  field: GraphQLFieldConfig<unknown, unknown>,
  directiveName: string
): Record<string, unknown> | null;

interface DirectiveConfig {
  name: string;
  description?: string;
  locations: DirectiveLocation[];
  args?: Record<string, {
    type: 'String' | 'Boolean' | 'Int';
    description?: string;
    defaultValue?: unknown;
  }>;
}

type DirectiveTransformer = (
  schema: GraphQLSchema,
  directiveName: string
) => GraphQLSchema;

const specDeprecatedDirective: GraphQLDirective;
const authDirective: GraphQLDirective;
const cacheControlDirective: GraphQLDirective;
```

`addDirective` rebuilds the whole schema on every call, so installing N
directives one at a time costs O(N × schema size); `addDirectives` pays that
cost once.

## License

Apache 2.0 - Joseph Quinn
