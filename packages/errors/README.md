# @leaven-graphql/errors

Error classes, error codes and error formatting for Leaven.

## Installation

```bash
bun add @leaven-graphql/errors
```

## Quick Start

```typescript
import { AuthenticationError, NotFoundError } from '@leaven-graphql/errors';

const resolvers = {
  Query: {
    me: (_parent, _args, context) => {
      if (!context.user) {
        throw new AuthenticationError('Please log in');
      }
      return context.user;
    },

    user: async (_parent, { id }, context) => {
      const user = await context.db.users.findById(id);
      if (!user) {
        throw new NotFoundError(`User ${id} not found`, {
          resourceType: 'User',
          resourceId: id,
        });
      }
      return user;
    },
  },
};
```

## Error Classes

Every class extends `LeavenError`, which carries a `code` (an `ErrorCode`), a
`statusCode`, an `extensions` bag and an optional wrapped `originalError`.

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
  ErrorCode,
} from '@leaven-graphql/errors';
```

### `LeavenError`

The error code is the **second positional argument**, not an option:

<!-- doc-check: skip - constructor signature listing, not a compilable statement -->
```typescript
new LeavenError(message: string, code?: ErrorCode, options?: {
  statusCode?: number;
  extensions?: Record<string, unknown>;
  originalError?: Error;
});
```

```typescript
// Defaults to ErrorCode.INTERNAL_ERROR / status 500
throw new LeavenError('Something went wrong');

throw new LeavenError('Custom error', ErrorCode.BAD_REQUEST, {
  statusCode: 400,
  extensions: { hint: 'check the payload' },
  originalError: caughtError,
});
```

`statusCode` defaults to the status registered for `code` in `ERROR_CODES`
(500 if the code is unknown). `code` is always mirrored into `extensions.code`
and always wins over an `extensions.code` supplied by the caller, so the two
can never disagree:

```typescript
const error = new LeavenError('x', ErrorCode.BAD_REQUEST, {
  extensions: { code: 'CUSTOM' },
});

error.code;             // 'BAD_REQUEST'
error.extensions.code;  // 'BAD_REQUEST'
```

### Subclasses

| Class | Constructor | Code | Status |
|---|---|---|---|
| `ValidationError` | `(message, validationErrors?, options?)` | `VALIDATION_ERROR` | 400 |
| `AuthenticationError` | `(message?, options?)` | `UNAUTHENTICATED` | 401 |
| `AuthorizationError` | `(message?, options?)` | `FORBIDDEN` | 403 |
| `NotFoundError` | `(message?, options?)` | `NOT_FOUND` | 404 |
| `RateLimitError` | `(message?, options?)` | `RATE_LIMITED` | 429 |
| `ComplexityError` | `(complexity, maxComplexity, options?)` | `COMPLEXITY_LIMIT` | 400 |
| `DepthLimitError` | `(depth, maxDepth, options?)` | `DEPTH_LIMIT` | 400 |
| `PersistedQueryError` | `(message, code?, options?)` | `PERSISTED_QUERY_NOT_FOUND` / `PERSISTED_QUERY_INVALID` | 400 |
| `InputError` | `(message, options?)` | `INVALID_INPUT` | 400 |

```typescript
// ValidationError - the second argument is an array of field errors,
// exposed as `error.validationErrors` and `extensions.validationErrors`
throw new ValidationError('Invalid input', [
  { field: 'email', message: 'Invalid email format' },
  { field: 'age', message: 'Must be a positive number' },
]);

// Default messages: 'Authentication required' / 'Access denied'
throw new AuthenticationError();
throw new AuthorizationError('Admin access required');

// NotFoundError - the option keys are `resourceType` / `resourceId`
throw new NotFoundError('User not found', {
  resourceType: 'User',
  resourceId: '123',
});

// RateLimitError - `retryAfter` is seconds, surfaced in extensions
throw new RateLimitError('Too many requests', { retryAfter: 60 });

// ComplexityError / DepthLimitError build their own message
throw new ComplexityError(150, 100);
// 'Query complexity of 150 exceeds maximum allowed complexity of 100'
throw new DepthLimitError(10, 5);
// 'Query depth of 10 exceeds maximum allowed depth of 5'

// PersistedQueryError - the code is the second positional argument
throw new PersistedQueryError('Query not found');
throw new PersistedQueryError(
  'Invalid query hash',
  ErrorCode.PERSISTED_QUERY_INVALID
);

// InputError - `field` reaches `extensions`, `value` deliberately does not
throw new InputError('Invalid email format', {
  field: 'email',
  value: userInput.email,
});
```

Optional option keys are only added to `extensions` when supplied, so
`new NotFoundError()` produces `extensions === { code: 'NOT_FOUND' }` rather
than a bag full of `undefined`s.

### Instance API

```typescript
class LeavenError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly extensions: Record<string, unknown>;
  readonly originalError?: Error;

  toGraphQLError(): GraphQLError;
  toJSON(): {
    message: string;
    code: ErrorCode;
    statusCode: number;
    extensions: Record<string, unknown>;
  };
}
```

## Error Codes

```typescript
import { ErrorCode, ERROR_CODES, getErrorCode, getErrorMessage } from '@leaven-graphql/errors';
```

| `ErrorCode` | HTTP status | Default message |
|---|---|---|
| `INTERNAL_ERROR` | 500 | An internal error occurred |
| `BAD_REQUEST` | 400 | Bad request |
| `PAYLOAD_TOO_LARGE` | 413 | Request payload is too large |
| `VALIDATION_ERROR` | 400 | Validation failed |
| `PARSE_ERROR` | 400 | Failed to parse GraphQL query |
| `UNAUTHENTICATED` | 401 | Authentication required |
| `FORBIDDEN` | 403 | Access denied |
| `NOT_FOUND` | 404 | Resource not found |
| `ALREADY_EXISTS` | 409 | Resource already exists |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `COMPLEXITY_LIMIT` | 400 | Query complexity limit exceeded |
| `DEPTH_LIMIT` | 400 | Query depth limit exceeded |
| `PERSISTED_QUERY_NOT_FOUND` | 400 | Persisted query not found |
| `PERSISTED_QUERY_INVALID` | 400 | Invalid persisted query |
| `INVALID_INPUT` | 400 | Invalid input provided |
| `MISSING_REQUIRED_FIELD` | 400 | Required field is missing |

`ERROR_CODES` is the registry behind that table and the single source of truth
for HTTP status mapping:

```typescript
ERROR_CODES[ErrorCode.NOT_FOUND];
// { status: 404, message: 'Resource not found' }
```

### `getErrorCode(code: string): ErrorCode | null`

Narrows a **code string** (typically read off `extensions.code`) to the enum,
or returns `null` when it is not a known Leaven code. It does not accept an
error object:

```typescript
getErrorCode('NOT_FOUND');   // ErrorCode.NOT_FOUND
getErrorCode('not_found');   // null (case sensitive)
getErrorCode('WHATEVER');    // null

// Reading the code off a formatted error
const code = getErrorCode(String(formatted.extensions?.code ?? ''));
```

### `getErrorMessage(code: ErrorCode): string`

```typescript
getErrorMessage(ErrorCode.UNAUTHENTICATED); // 'Authentication required'
getErrorMessage(ErrorCode.NOT_FOUND);       // 'Resource not found'
getErrorMessage('NOPE' as ErrorCode);       // 'An error occurred'
```

## Formatting and Masking

```typescript
import {
  formatError,
  formatErrors,
  maskError,
  errorToGraphQL,
  fromFormattedError,
  isLeavenError,
  type ErrorFormatter,
  type ErrorMaskingOptions,
} from '@leaven-graphql/errors';
```

### Options

```typescript
interface ErrorMaskingOptions {
  /** Mask unexpected errors (default: false) */
  maskErrors?: boolean;
  /** Replacement message for masked errors (default: 'An unexpected error occurred') */
  maskedMessage?: string;
  /** Override the masking decision entirely */
  shouldMask?: (error: GraphQLError) => boolean;
  /** Append `extensions.stackTrace` (an array of trimmed stack lines) */
  includeStackTrace?: boolean;
  /** Take over formatting completely */
  formatter?: ErrorFormatter;
}

type ErrorFormatter = (
  error: GraphQLError,
  masked: boolean
) => GraphQLFormattedError;
```

There is no `includeExtensions` option: `extensions` are always included when
the error has any, and a masked error is always reduced to
`{ message, locations?, path?, extensions: { code: 'INTERNAL_ERROR' } }` (see
`maskedErrorFor`).

### `formatError` / `formatErrors`

`formatError` accepts anything (`unknown`), runs it through `errorToGraphQL`,
then through `maskError`:

```typescript
const formatted = formatError(
  new NotFoundError('User not found', { resourceType: 'User', resourceId: '123' }),
  { maskErrors: true }
);
// {
//   message: 'User not found',
//   extensions: { resourceType: 'User', resourceId: '123', code: 'NOT_FOUND' }
// }

const masked = formatError(new Error('DB password is hunter2 at 10.0.0.5'), {
  maskErrors: true,
});
// { message: 'An unexpected error occurred', extensions: { code: 'INTERNAL_ERROR' } }

const all = formatErrors(result.errors ?? [], { maskErrors: isProduction });
```

An unmasked result carries `message`, plus `locations`, `path` and
`extensions` when the error actually has them.

### What gets masked

`maskError` masks an error only when all of the following hold:

1. No `shouldMask` predicate was supplied (it wins outright when it is).
2. The error's `originalError` is **not** a `LeavenError` — thrown Leaven
   errors are intentional and always pass through unmasked.
3. `extensions.code` is not a known `ErrorCode` other than `INTERNAL_ERROR`.
   `INTERNAL_ERROR` is the fallback code for unexpected failures, which is
   exactly what masking is for.
4. `maskErrors` is `true`.

```typescript
import { GraphQLError } from 'graphql';
import {
  AuthenticationError,
  errorToGraphQL,
  maskError,
} from '@leaven-graphql/errors';

// Never masked - a known, deliberate code
maskError(errorToGraphQL(new AuthenticationError('Please log in')), {
  maskErrors: true,
});
// { message: 'Please log in', extensions: { code: 'UNAUTHENTICATED' } }

// Masked - an unexpected failure
maskError(new GraphQLError('connect ECONNREFUSED 10.0.0.5:5432'), {
  maskErrors: true,
  maskedMessage: 'Something went wrong',
});
// { message: 'Something went wrong', extensions: { code: 'INTERNAL_ERROR' } }
```

### `errorToGraphQL(error: unknown): GraphQLError`

Normalises anything into a `GraphQLError` that carries an `ErrorCode`:

- a `LeavenError` becomes `error.toGraphQLError()`;
- a `GraphQLError` that already has `extensions.code` is returned unchanged;
- a `GraphQLError` without a code (a bare `new GraphQLError('boom')`, or a
  graphql-js validation error) is rebuilt with
  `extensions.code = ErrorCode.INTERNAL_ERROR`, preserving `nodes`, `source`,
  `positions`, `path` and `originalError` so `locations` survive;
- any other `Error` or value becomes a `GraphQLError` with
  `extensions.code = ErrorCode.INTERNAL_ERROR`.

### `fromFormattedError(formatted: GraphQLFormattedError): GraphQLError`

`LeavenExecutor` hands back errors that are already serialised
(`GraphQLFormattedError`, the output of `GraphQLError.toJSON()`). Passing one
straight to `formatError` is destructive: `errorToGraphQL` has no branch for a
plain object, so the message becomes `"[object Object]"`, `path` and
`locations` are lost, and the real code is replaced by `INTERNAL_ERROR`.
`fromFormattedError` rebuilds a `GraphQLError` with the same `message`, `path`,
`locations` and `extensions`, so masking decides on the error the executor
actually produced:

```typescript
import { formatError, fromFormattedError } from '@leaven-graphql/errors';

const errors = result.response.errors?.map((e) =>
  formatError(fromFormattedError(e), { maskErrors: true })
);
```

`@leaven-graphql/http` and `@leaven-graphql/ws` both do this when `errorFormatting` is
configured.

### `isLeavenError(error: unknown): error is LeavenError`

A plain `instanceof LeavenError` guard. It is **false** for a `GraphQLError`,
even one produced from a `LeavenError` — `toGraphQLError()` attaches the
`LeavenError` as the `GraphQLError`'s `originalError`, so a `formatError` hook
has to unwrap:

```typescript
const gqlError = new LeavenError('Query failed', ErrorCode.INTERNAL_ERROR, {
  originalError: dbError,
}).toGraphQLError();

isLeavenError(gqlError);                 // false
isLeavenError(gqlError.originalError);   // true - the LeavenError

// `isLeavenError` narrows, which is also how you reach the cause one level
// deeper without an assertion.
if (isLeavenError(gqlError.originalError)) {
  gqlError.originalError.originalError;  // dbError
}
```

So code matching on the underlying cause must unwrap one extra level:

```typescript
// Whatever your data layer throws.
class MyDbError extends Error {}

// Wrong - never matches for a wrapped Leaven error
if (gqlError.originalError instanceof MyDbError) { /* ... */ }

// Right
const cause = isLeavenError(gqlError.originalError)
  ? gqlError.originalError.originalError
  : gqlError.originalError;

if (cause instanceof MyDbError) { /* ... */ }
```

`maskError` uses that same `originalError` check, which is why Leaven errors
survive masking.

### `maskedErrorFor(error, message?)`

Builds the generic masked error `{ message, extensions: { code: 'INTERNAL_ERROR' } }`.
`path` is copied only when it is a non-empty array whose every element is a
string or a finite number (anything else, such as an object or a DSN-bearing
object, is dropped); `locations` only when every entry
has a numeric `line`/`column`, and each is rebuilt as `{ line, column }`, so
nothing else leaks:

```typescript
import { maskedErrorFor } from '@leaven-graphql/errors';

maskedErrorFor({ locations: [{ line: 1, column: 3 }], path: ['user'] }, 'Oops');
// { message: 'Oops', locations: [{ line: 1, column: 3 }], path: ['user'],
//   extensions: { code: 'INTERNAL_ERROR' } }
```

### `MASKED_ERROR_MESSAGE`

The default masked message, `'An unexpected error occurred'`.

### `withMaskingDefault(options?)`

Returns the options with `maskErrors` defaulted to `true` (an explicit `false`
is kept). Transports use it for errors thrown outside execution:

```typescript
import { withMaskingDefault } from '@leaven-graphql/errors';

withMaskingDefault();                      // { maskErrors: true }
withMaskingDefault({ maskErrors: false }); // { maskErrors: false }
```

### `statusForResponse(response)`

The shared GraphQL-over-HTTP status rule: 200 when there are no errors or when
`data` is non-null (partial success), otherwise the status registered for the
first error's `extensions.code`, or 500:

```typescript
import { statusForResponse } from '@leaven-graphql/errors';

statusForResponse({ data: null, errors: [{ extensions: { code: 'NOT_FOUND' } }] }); // 404
statusForResponse({ data: { a: 1 }, errors: [{ extensions: { code: 'NOT_FOUND' } }] }); // 200
```

### `isPlainObject(value)`

True only for objects whose prototype is `Object.prototype` or `null`; arrays,
`Date`, `Map` and class instances are rejected:

```typescript
import { isPlainObject } from '@leaven-graphql/errors';

isPlainObject({});         // true
isPlainObject(new Map());  // false
```

## Usage in Resolvers

```typescript
import { LeavenError, ErrorCode, NotFoundError } from '@leaven-graphql/errors';

const resolve = async (_parent, { id }, context) => {
  try {
    const user = await context.db.users.findById(id);
    if (!user) {
      throw new NotFoundError(`User ${id} not found`, {
        resourceType: 'User',
        resourceId: id,
      });
    }
    return user;
  } catch (error) {
    // Re-throw Leaven errors as-is
    if (error instanceof LeavenError) {
      throw error;
    }

    // Wrap unknown errors so they carry a code and can be masked
    throw new LeavenError('Failed to load user', ErrorCode.INTERNAL_ERROR, {
      originalError: error as Error,
    });
  }
};
```

## Custom Formatting

```typescript
import { formatError, isLeavenError } from '@leaven-graphql/errors';

const options = {
  maskErrors: process.env.NODE_ENV === 'production',
  includeStackTrace: process.env.NODE_ENV !== 'production',
  formatter: (error, masked) => ({
    message: masked ? 'An unexpected error occurred' : error.message,
    extensions: {
      ...error.extensions,
      requestId: currentRequestId(),
    },
  }),
};

const formatted = formatError(caughtError, options);
```

## License

Apache 2.0 - Joseph Quinn
</content>
