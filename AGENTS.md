<!-- converted from Cursor rules -->

## Cursor rule: `.cursor/rules/bun-runtime.mdc`

_Bun runtime specifics for Leaven_

Applies to: `["packages/**/*.ts"]`

# Bun Runtime Guidelines

## Why Bun?

Leaven is designed specifically for Bun, taking advantage of:

- Faster startup times
- Built-in TypeScript support
- Native test runner
- Optimized HTTP server
- Native WebSocket support
- Built-in crypto APIs

## Bun APIs to Use

### File System

```typescript
// ✅ Use Bun.file for file operations
const file = Bun.file(path);
const exists = await file.exists();
const content = await file.text();

// ❌ Avoid Node.js fs
import fs from 'fs';  // Don't use
```

### Cryptography

```typescript
// ✅ Use Bun.CryptoHasher
const hasher = new Bun.CryptoHasher('sha256');
hasher.update(data);
const hash = hasher.digest('hex');

// ❌ Avoid Node.js crypto
import crypto from 'crypto';  // Don't use
```

### HTTP Server

```typescript
// ✅ Use Bun.serve
const server = Bun.serve({
  port: 4000,
  fetch: (request) => handleRequest(request),
  websocket: {
    open: (ws) => { /* ... */ },
    message: (ws, message) => { /* ... */ },
    close: (ws) => { /* ... */ },
  },
});

// Access server info
console.log(`Listening on ${server.hostname}:${server.port}`);
```

### WebSockets

```typescript
// ✅ Use Bun's native WebSocket in servers
import type { ServerWebSocket } from 'bun';

interface SocketData {
  connectionId: string;
  authenticated: boolean;
}

const websocket = {
  open(ws: ServerWebSocket<SocketData>) {
    ws.data.connectionId = generateId();
  },
  message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
    // Handle message
  },
};
```

### Glob Patterns

```typescript
// ✅ Use Bun.Glob
import { Glob } from 'bun';

const glob = new Glob('**/*.graphql');
for await (const file of glob.scan('.')) {
  // Process file
}
```

## Node.js Compatibility

When Node.js APIs are needed, use the `node:` prefix:

```typescript
// ✅ Correct import for Node.js built-ins
import { AsyncLocalStorage } from 'node:async_hooks';
import { join, resolve } from 'node:path';

// ❌ Don't use bare imports for Node.js modules
import { AsyncLocalStorage } from 'async_hooks';  // Wrong
```

## Performance Tips

1. **Avoid unnecessary async**: Bun is fast synchronously
   ```typescript
   // ✅ Prefer sync when appropriate
   const hash = Bun.hash(data);

   // ❌ Don't await when not needed
   const hash = await computeHash(data);  // If sync is possible
   ```

2. **Use streaming for large responses**:
   ```typescript
   return new Response(stream, {
     headers: { 'Content-Type': 'application/json' },
   });
   ```

3. **Leverage Bun's JIT compilation**: Hot paths get optimized automatically

## Testing with Bun

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

describe('Feature', () => {
  test('should work', () => {
    expect(true).toBe(true);
  });
});
```

Run tests:
```bash
bun test                    # Run all tests
bun test --coverage         # With coverage
bun test --watch            # Watch mode
bun test packages/core/     # Specific package
```


## Cursor rule: `.cursor/rules/code-style.mdc`

_Code style and conventions for Leaven_

Applies to: `["packages/**/*.ts"]`

# Code Style Guidelines

## TypeScript Conventions

### Visibility Modifiers (REQUIRED)

All class members MUST have explicit visibility modifiers:

```typescript
// ✅ CORRECT
export class MyClass {
  public readonly name: string;
  private cache: Map<string, unknown>;
  protected config: Config;

  constructor(name: string) {  // Constructors don't need 'public'
    this.name = name;
  }

  public getData(): string {
    return this.name;
  }

  private processInternal(): void {
    // ...
  }
}

// ❌ WRONG - Missing visibility modifiers
export class MyClass {
  readonly name: string;        // Missing 'public'
  getData(): string { ... }     // Missing 'public'
}
```

### Unused Variables

Prefix unused variables with underscore:

```typescript
// ✅ CORRECT
function handler(_event: Event, data: Data) {
  return data.value;
}

// ❌ WRONG
function handler(event: Event, data: Data) {  // 'event' unused
  return data.value;
}
```

### Return Types

Always specify return types for public methods:

```typescript
// ✅ CORRECT
public execute(): ExecutionResult {
  // ...
}

// ⚠️ Warning (but allowed in some cases)
public execute() {
  // ...
}
```

## Import Conventions

1. Use `type` imports for type-only imports:
   ```typescript
   import type { GraphQLSchema } from 'graphql';
   import { execute, subscribe } from 'graphql';
   ```

2. Order imports:
   - External packages first
   - Internal packages second
   - Relative imports last

3. Use Node.js built-in imports with `node:` prefix:
   ```typescript
   import { AsyncLocalStorage } from 'node:async_hooks';
   ```

## Documentation

All public APIs must have JSDoc comments:

```typescript
/**
 * Execute a GraphQL request
 *
 * @param request - The GraphQL request to execute
 * @param context - Optional execution context
 * @returns The execution result
 */
public async execute<TData>(
  request: GraphQLRequest,
  context?: unknown
): Promise<ExecutionResult<TData>> {
  // ...
}
```

## File Headers

All source files should have the standard header:

```typescript
/**
 * @leaven/package-name - Brief description
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */
```

## Naming Conventions

- **Classes**: PascalCase (`DocumentCache`, `LeavenExecutor`)
- **Interfaces/Types**: PascalCase (`ExecutorConfig`, `GraphQLRequest`)
- **Functions**: camelCase (`parseDocument`, `createExecutor`)
- **Constants**: UPPER_SNAKE_CASE (`ERROR_CODES`, `DEFAULT_TTL`)
- **Files**: kebab-case (`document-cache.ts`, `error-codes.ts`)
  - Exception: Test files use `.test.ts` suffix


## Cursor rule: `.cursor/rules/commits.mdc`

_Commit message conventions for Leaven_

Applies to: `["**/*"]`

# Commit Message Conventions

This project uses **Conventional Commits** enforced by Commitlint and Husky.

## Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

## Types

| Type       | Description                                      |
|------------|--------------------------------------------------|
| `feat`     | New feature                                      |
| `fix`      | Bug fix                                          |
| `docs`     | Documentation only changes                       |
| `style`    | Code style (formatting, missing semi-colons)     |
| `refactor` | Code change that neither fixes bug nor adds feature |
| `perf`     | Performance improvement                          |
| `test`     | Adding or updating tests                         |
| `build`    | Build system or external dependencies            |
| `ci`       | CI configuration                                 |
| `chore`    | Other changes that don't modify src or test      |
| `revert`   | Reverts a previous commit                        |

## Scopes

Use package names as scopes:

- `core` - @leaven/core
- `context` - @leaven/context
- `errors` - @leaven/errors
- `http` - @leaven/http
- `ws` - @leaven/ws
- `schema` - @leaven/schema
- `plugins` - @leaven/plugins
- `playground` - @leaven/playground
- `deps` - Dependency updates
- `config` - Configuration changes

## Examples

```bash
# Feature
feat(core): add query complexity calculation

# Bug fix
fix(http): handle malformed JSON in request body

# Documentation
docs(readme): update installation instructions

# Tests
test(core): add tests for document cache eviction

# Breaking change (note the !)
feat(schema)!: change SchemaBuilder API to use fluent pattern

BREAKING CHANGE: SchemaBuilder.addType() now returns `this` instead of the type.
```

## Pre-commit Hooks

The following checks run automatically on commit:

1. **ESLint** - Code linting
2. **Tests** - All unit tests must pass

If either fails, the commit is rejected.

## Best Practices

1. **Keep commits atomic**: One logical change per commit
2. **Write clear descriptions**: Explain what changed, not how
3. **Use imperative mood**: "add feature" not "added feature"
4. **Reference issues**: Include issue numbers when applicable

```bash
fix(core): resolve memory leak in document cache

Closes #123
```


## Cursor rule: `.cursor/rules/error-handling.mdc`

_Error handling patterns for Leaven_

Applies to: `["packages/**/*.ts"]`

# Error Handling

## Error Classes

Use the error classes from `@leaven-graphql/errors`:

```typescript
import {
  LeavenError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ComplexityError,
  DepthLimitError,
  PersistedQueryError,
  InputError,
} from '@leaven-graphql/errors';
```

## Error Hierarchy

```
LeavenError (base)
├── ValidationError      # Schema/input validation failures
├── AuthenticationError  # 401 - Not authenticated
├── AuthorizationError   # 403 - Not authorized
├── NotFoundError        # 404 - Resource not found
├── RateLimitError       # 429 - Rate limit exceeded
├── ComplexityError      # Query too complex
├── DepthLimitError      # Query too deep
├── PersistedQueryError  # Persisted query not found/invalid
└── InputError           # Invalid input value
```

## Creating Errors

```typescript
// Basic error
throw new LeavenError('Something went wrong', ErrorCode.INTERNAL_ERROR);

// With options
throw new LeavenError('Custom error', ErrorCode.BAD_REQUEST, {
  statusCode: 400,
  extensions: { field: 'email' },
  originalError: caughtError,
});

// Specialized errors
throw new AuthenticationError('Token expired');

throw new NotFoundError('User not found', {
  resourceType: 'User',
  resourceId: userId,
});

throw new ValidationError('Invalid input', [
  { field: 'email', message: 'Invalid email format' },
  { field: 'age', message: 'Must be positive number' },
]);
```

## Error Codes

```typescript
import { ErrorCode } from '@leaven-graphql/errors';

ErrorCode.INTERNAL_ERROR        // Generic server error
ErrorCode.BAD_REQUEST           // Malformed request
ErrorCode.PAYLOAD_TOO_LARGE     // Request body exceeded the size limit
ErrorCode.VALIDATION_ERROR      // Input validation failed
ErrorCode.PARSE_ERROR           // Failed to parse GraphQL query
ErrorCode.UNAUTHENTICATED       // Authentication required
ErrorCode.FORBIDDEN             // Access denied
ErrorCode.NOT_FOUND             // Resource not found
ErrorCode.ALREADY_EXISTS        // Resource already exists
ErrorCode.RATE_LIMITED          // Too many requests
ErrorCode.COMPLEXITY_LIMIT      // Query too complex
ErrorCode.DEPTH_LIMIT           // Query too deep
ErrorCode.INVALID_INPUT         // Invalid input value
ErrorCode.MISSING_REQUIRED_FIELD // Required field is missing
ErrorCode.PERSISTED_QUERY_NOT_FOUND
ErrorCode.PERSISTED_QUERY_INVALID
```

## Error Formatting

```typescript
import { formatError, maskError, isLeavenError } from '@leaven-graphql/errors';

// Format for GraphQL response
const formatted = formatError(error);
// { message: '...', extensions: { code: '...' } }

// Mask internal errors in production
const safe = maskError(error, { maskErrors: true });
// Unexpected errors become "An unexpected error occurred"
// (override with the `maskedMessage` option). Intentional Leaven
// errors and errors with a known Leaven code are never masked.
```

### `originalError` is the LeavenError, not the wrapped cause

`LeavenError.toGraphQLError()` (used by `errorToGraphQL`, and therefore by
`formatError`/`maskError`) attaches the `LeavenError` itself as the
`GraphQLError`'s `originalError`. That is what lets `maskError` recognise the
error as intentional and leave it unmasked.

The cause passed to the constructor sits one level deeper:

```typescript
const gqlError = new LeavenError('Query failed', ErrorCode.INTERNAL_ERROR, {
  originalError: dbError,
}).toGraphQLError();

gqlError.originalError;                // the LeavenError
gqlError.originalError.originalError;  // dbError
```

So any `formatError` hook, logger or Sentry integration that matches on the
underlying cause must unwrap one extra level:

```typescript
// Wrong - never matches for a wrapped Leaven error
if (gqlError.originalError instanceof MyDbError) { /* ... */ }

// Right
const cause = isLeavenError(gqlError.originalError)
  ? gqlError.originalError.originalError
  : gqlError.originalError;

if (cause instanceof MyDbError) { /* ... */ }
```

`extensions` are copied verbatim by `toGraphQLError()`, so subclass detail such
as `RateLimitError.retryAfter` or `ValidationError.validationErrors` survives
the conversion and reaches the formatted response.

### `formatExecutionError`: the last point where `originalError` still exists

`ExecutorConfig.formatExecutionError` is the executor-level hook a transport uses
to serialize an *execution* error while the graphql-js `GraphQLError` is still
intact. The default is `error.toJSON()`, which emits only
`{ message, locations, path, extensions }` and drops `originalError`.

graphql-js sets `extensions = extensions ?? originalError?.extensions ?? {}`, so
a `LeavenError` survives `toJSON()` with its `code`. A framework exception with
no `extensions` of its own — a NestJS `HttpException` — does not: it arrives with
`extensions: {}` and is indistinguishable from a crash. Mapping it to an
`ErrorCode` is only possible before `toJSON()` runs:

```typescript
const executor = new LeavenExecutor({
  schema,
  formatExecutionError: (error) => {
    const cause = error.originalError;
    if (cause instanceof HttpException) {
      return {
        message: cause.message,
        path: error.path,
        locations: error.locations,
        extensions: { ...error.extensions, code: codeForStatus(cause.getStatus()) },
      };
    }
    return error.toJSON();
  },
});
```

Scope: the errors of an execution result and of both subscription paths. It is
deliberately *not* applied to parse, validation or complexity rejections — those
are synthesised by Leaven, never carry a framework `originalError`, and already
carry an `ErrorCode` — nor to an error thrown out of the executor itself, which
`formatCaughtError` routes through this package.

Distinct from a transport's own `formatError` (e.g.
`LeavenModuleOptions.formatError`), which is a final, response-level pass over an
already-serialized `GraphQLFormattedError`.

## Error Handling in Resolvers

```typescript
const resolve = async (_, args, context) => {
  try {
    const result = await riskyOperation();
    return result;
  } catch (error) {
    // Re-throw Leaven errors as-is
    if (error instanceof LeavenError) {
      throw error;
    }

    // Wrap unknown errors
    throw new LeavenError(
      'Operation failed',
      ErrorCode.INTERNAL_ERROR,
      { originalError: error as Error }
    );
  }
};
```

## HTTP Status Codes

`ERROR_CODES` in `@leaven-graphql/errors` is the single source of truth: it maps
every `ErrorCode` to its HTTP status, and `LeavenError` reads its `statusCode`
from it unless one is passed explicitly. `buildResponse` in
`@leaven-graphql/http` derives response statuses from the same registry.

Each error class carries a `statusCode` property for transports to use
when mapping errors to HTTP responses. The reference mapping:

| Error Class          | HTTP Status |
|---------------------|-------------|
| ValidationError     | 400         |
| InputError          | 400         |
| ComplexityError     | 400         |
| DepthLimitError     | 400         |
| PersistedQueryError | 400         |
| AuthenticationError | 401         |
| AuthorizationError  | 403         |
| NotFoundError       | 404         |
| RateLimitError      | 429         |
| LeavenError (default)| 500        |

Some codes have no dedicated error class and are raised as a bare `LeavenError`
or emitted directly by a transport:

| Error Code            | HTTP Status |
|-----------------------|-------------|
| `BAD_REQUEST`         | 400         |
| `PARSE_ERROR`         | 400         |
| `ALREADY_EXISTS`      | 409         |
| `PAYLOAD_TOO_LARGE`   | 413         |

`@leaven-graphql/http` emits `PAYLOAD_TOO_LARGE` (413) when a request body
exceeds `maxBodySize` — both on the `Content-Length` fast path and while
reading the stream, since the header may be absent, malformed, or lying.

Note that a status is only derived from an error when the response is a *total*
failure. A response that carries `data` alongside `errors` is a spec-conformant
partial success and stays 200 whatever the error codes say.


## Cursor rule: `.cursor/rules/graphql-patterns.mdc`

_GraphQL-specific patterns and conventions for Leaven_

Applies to: `["packages/**/*.ts"]`

# GraphQL Patterns

## Schema Definition

Use the programmatic GraphQL.js API for schema building:

```typescript
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  GraphQLList,
} from 'graphql';

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      user: {
        type: UserType,
        args: {
          id: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve: (_, { id }, context) => context.loaders.user.load(id),
      },
    },
  }),
});
```

## Resolver Patterns

### Type Safety

Always type resolver arguments:

```typescript
interface UserArgs {
  id: string;
}

interface Context {
  user?: { id: string };
  loaders: DataLoaders;
}

const resolver: GraphQLFieldResolver<unknown, Context, UserArgs> = (
  _parent,
  args,
  context
) => {
  return context.loaders.user.load(args.id);
};
```

### Error Handling

Use Leaven error classes:

```typescript
import { AuthenticationError, NotFoundError } from '@leaven/errors';

const resolve = async (_, { id }, context) => {
  if (!context.user) {
    throw new AuthenticationError();
  }

  const result = await context.db.find(id);
  if (!result) {
    throw new NotFoundError('User not found', { resourceId: id });
  }

  return result;
};
```

## Execution Flow

```
Request → Parse → Validate → Compile → Execute → Format Response
   ↓         ↓        ↓          ↓         ↓           ↓
  HTTP    Cache    Schema    Cache     Resolvers    Errors
```

## Document Caching

Use the built-in LRU cache for parsed documents:

```typescript
import { DocumentCache } from '@leaven/core';

const cache = new DocumentCache({
  maxSize: 1000,
  ttl: 3600000, // 1 hour
});
```

## Subscription Patterns

Use the graphql-ws protocol:

```typescript
import { PubSub, createWebSocketHandler } from '@leaven/ws';

const pubsub = new PubSub();

// Publish events
pubsub.publish('USER_CREATED', { userCreated: newUser });

// Subscribe in resolvers
const subscribe = () => pubsub.asyncIterator(['USER_CREATED']);
```

## Plugin System

Create plugins using the lifecycle hooks:

```typescript
import { createPlugin } from '@leaven/plugins';

const myPlugin = createPlugin(
  {
    name: 'my-plugin',
    version: '1.0.0',
    description: 'Does something useful',
  },
  {
    async beforeExecute(document, context) {
      // Pre-execution logic
    },
    async afterExecute(response, context) {
      // Post-execution logic
      return response;
    },
  }
);
```

## Context Management

Use AsyncLocalStorage for request-scoped context:

```typescript
import { ContextStore, ContextBuilder } from '@leaven/context';

const store = new ContextStore<AppContext>();

// In request handler
store.runAsync(context, async () => {
  const result = await executor.execute(request);
  const ctx = store.requireContext(); // Access anywhere
  return result;
});
```

## Query Complexity

Implement complexity analysis for DoS protection:

```typescript
const executor = new LeavenExecutor({
  schema,
  compilerOptions: {
    calculateComplexity: true,
    complexityCalculator: (field, depth) => 1 + (depth * 0.5),
  },
  maxComplexity: 100,
});
```


## Cursor rule: `.cursor/rules/package-development.mdc`

_Guidelines for developing packages in the Leaven monorepo_

Applies to: `["packages/**/*"]`

# Package Development Guidelines

## Package Structure

Each package follows this structure:

```
packages/package-name/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          # Public exports only
    ├── types.ts          # Type definitions
    ├── feature.ts        # Feature implementation
    └── feature.test.ts   # Tests for feature
```

## package.json Template

```json
{
  "name": "@leaven/package-name",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "types": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "bun build ./src/index.ts --outdir ./dist --target bun",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "graphql": "^16.12.0"
  },
  "peerDependencies": {
    "@leaven/core": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.9.3"
  },
  "license": "Apache-2.0",
  "author": "Joseph Quinn"
}
```

## tsconfig.json Template

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

## Index Exports

Only export public APIs from `index.ts`:

```typescript
/**
 * @leaven/package-name - Brief description
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

// Types
export type { ConfigType, ResultType } from './types';

// Classes
export { MainClass, HelperClass } from './main';

// Functions
export { createSomething, helperFunction } from './helpers';
```

## Inter-Package Dependencies

Use workspace protocol for internal dependencies:

```json
{
  "dependencies": {
    "@leaven/core": "workspace:*",
    "@leaven/errors": "workspace:*"
  }
}
```

## Adding a New Package

1. Create directory: `packages/new-package/`
2. Add `package.json` with `@leaven/new-package` name
3. Add `tsconfig.json` extending base config
4. Create `src/index.ts` with exports
5. Add to meta-package `packages/leaven/src/index.ts`
6. Run `pnpm install` to link workspace

## Bun-Specific APIs

Prefer Bun native APIs over Node.js equivalents:

```typescript
// ✅ Use Bun APIs
const hasher = new Bun.CryptoHasher('sha256');
const file = Bun.file(path);
const server = Bun.serve({ ... });

// ❌ Avoid Node.js equivalents when Bun has native support
import crypto from 'crypto';  // Use Bun.CryptoHasher instead
import fs from 'fs';          // Use Bun.file instead
```


## Cursor rule: `.cursor/rules/project-overview.mdc`

_Leaven project overview and architecture_

Applies to: `["**/*"]`

# Leaven - GraphQL Library for Bun

Leaven is a high-performance GraphQL library designed specifically for the Bun runtime, similar to Mercurius and Apollo.

## Project Structure

This is a **PNPM monorepo** with scoped packages under `@leaven/*`:

```
packages/
├── core/          # Core execution engine (parsing, compiling, executing)
├── context/       # Request context management with AsyncLocalStorage
├── errors/        # Error handling and formatting
├── http/          # HTTP server integration for Bun
├── ws/            # WebSocket/GraphQL subscriptions (graphql-ws protocol)
├── schema/        # Schema building and merging utilities
├── plugins/       # Plugin system and built-in plugins
├── playground/    # GraphQL Playground and GraphiQL integration
├── nestjs/        # NestJS framework integration
└── leaven/        # Meta-package that re-exports all modules
```

## Key Technologies

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript with strict type checking
- **Package Manager**: PNPM (never use npm or yarn)
- **Testing**: Bun's built-in test runner with Vitest-compatible API
- **Linting**: ESLint with TypeScript rules
- **Commits**: Conventional Commits enforced by Commitlint + Husky

## License

Apache 2.0 - Joseph Quinn

## Important Commands

```bash
pnpm install          # Install dependencies
pnpm test             # Run all tests with coverage
pnpm lint             # Run ESLint
pnpm lint:fix         # Run ESLint with auto-fix
pnpm build            # Build all packages
pnpm typecheck        # Type check all packages
```

## Architecture Principles

1. **Modularity**: Each package is self-contained with clear responsibilities
2. **Performance**: Optimized for Bun runtime, uses native Bun APIs where possible
3. **Type Safety**: Full TypeScript with strict mode, explicit types everywhere
4. **Extensibility**: Plugin system for customization without core modifications
5. **Standards Compliance**: Follows GraphQL specification strictly


## Cursor rule: `.cursor/rules/testing.mdc`

_Testing guidelines for Leaven_

Applies to: `["packages/**/*.test.ts"]`

# Testing Guidelines

## Testing Framework

Use **Bun's built-in test runner** (NOT Jest, NOT Vitest separately):

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
```

## Test File Location

Test files live alongside source files with `.test.ts` suffix:

```
packages/core/src/
├── cache.ts
├── cache.test.ts      ← Test file here
├── executor.ts
└── executor.test.ts   ← Test file here
```

## Test Structure

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';

describe('ClassName', () => {
  let instance: ClassName;

  beforeEach(() => {
    instance = new ClassName();
  });

  describe('methodName', () => {
    test('should do expected behavior', () => {
      const result = instance.methodName();
      expect(result).toBe(expectedValue);
    });

    test('should handle edge case', () => {
      // ...
    });

    test('should throw on invalid input', () => {
      expect(() => instance.methodName(null)).toThrow();
    });
  });
});
```

## Coverage Requirements

**Target: 90% code coverage minimum**

Current coverage: ~97% (maintain or improve)

Run tests with coverage:
```bash
pnpm test                          # Runs with coverage
pnpm test:coverage                 # Detailed coverage report
```

## Test Categories

### Unit Tests
- Test individual functions/methods in isolation
- Mock external dependencies
- Fast execution

### Integration Tests
- Test multiple components working together
- Use real GraphQL schemas
- Test full execution flow

## Mocking

For GraphQL testing, create simple test schemas:

```typescript
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: {
        type: GraphQLString,
        resolve: () => 'world',
      },
    },
  }),
});
```

## Async Testing

```typescript
test('should handle async operations', async () => {
  const result = await executor.execute(query);
  expect(result.data).toBeDefined();
});
```

## Error Testing

```typescript
test('should throw ValidationError for invalid input', () => {
  expect(() => {
    validate(invalidInput);
  }).toThrow(ValidationError);
});

// Or for async:
test('should reject with error', async () => {
  await expect(asyncFn()).rejects.toThrow('error message');
});
```

## Test Naming

Use descriptive test names that explain:
1. What is being tested
2. Under what conditions
3. Expected outcome

```typescript
// ✅ Good
test('should return cached document when query exists in cache', () => {});
test('should evict oldest entry when cache reaches max size', () => {});

// ❌ Bad
test('cache works', () => {});
test('test1', () => {});
```

