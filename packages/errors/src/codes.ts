/**
 * @leaven-graphql/errors - Error codes
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

/**
 * Standard error codes for Leaven errors
 */
export enum ErrorCode {
  // General errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  BAD_REQUEST = 'BAD_REQUEST',
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',

  // Validation errors
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  PARSE_ERROR = 'PARSE_ERROR',

  // Authentication/Authorization
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',

  // Resource errors
  NOT_FOUND = 'NOT_FOUND',
  ALREADY_EXISTS = 'ALREADY_EXISTS',

  // Rate limiting
  RATE_LIMITED = 'RATE_LIMITED',

  // Query limits
  COMPLEXITY_LIMIT = 'COMPLEXITY_LIMIT',
  DEPTH_LIMIT = 'DEPTH_LIMIT',

  // Persisted queries
  PERSISTED_QUERY_NOT_FOUND = 'PERSISTED_QUERY_NOT_FOUND',
  PERSISTED_QUERY_INVALID = 'PERSISTED_QUERY_INVALID',

  // Input errors
  INVALID_INPUT = 'INVALID_INPUT',
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
}

/**
 * Error code metadata
 */
export const ERROR_CODES: Record<ErrorCode, { status: number; message: string }> = {
  [ErrorCode.INTERNAL_ERROR]: {
    status: 500,
    message: 'An internal error occurred',
  },
  [ErrorCode.BAD_REQUEST]: {
    status: 400,
    message: 'Bad request',
  },
  [ErrorCode.PAYLOAD_TOO_LARGE]: {
    status: 413,
    message: 'Request payload is too large',
  },
  [ErrorCode.VALIDATION_ERROR]: {
    status: 400,
    message: 'Validation failed',
  },
  [ErrorCode.PARSE_ERROR]: {
    status: 400,
    message: 'Failed to parse GraphQL query',
  },
  [ErrorCode.UNAUTHENTICATED]: {
    status: 401,
    message: 'Authentication required',
  },
  [ErrorCode.FORBIDDEN]: {
    status: 403,
    message: 'Access denied',
  },
  [ErrorCode.NOT_FOUND]: {
    status: 404,
    message: 'Resource not found',
  },
  [ErrorCode.ALREADY_EXISTS]: {
    status: 409,
    message: 'Resource already exists',
  },
  [ErrorCode.RATE_LIMITED]: {
    status: 429,
    message: 'Rate limit exceeded',
  },
  [ErrorCode.COMPLEXITY_LIMIT]: {
    status: 400,
    message: 'Query complexity limit exceeded',
  },
  [ErrorCode.DEPTH_LIMIT]: {
    status: 400,
    message: 'Query depth limit exceeded',
  },
  [ErrorCode.PERSISTED_QUERY_NOT_FOUND]: {
    status: 400,
    message: 'Persisted query not found',
  },
  [ErrorCode.PERSISTED_QUERY_INVALID]: {
    status: 400,
    message: 'Invalid persisted query',
  },
  [ErrorCode.INVALID_INPUT]: {
    status: 400,
    message: 'Invalid input provided',
  },
  [ErrorCode.MISSING_REQUIRED_FIELD]: {
    status: 400,
    message: 'Required field is missing',
  },
};

/**
 * Set of all known error codes, hoisted to module level so per-error hot
 * paths get O(1) membership checks without allocating on every call
 */
const ERROR_CODE_SET: ReadonlySet<string> = new Set(Object.values(ErrorCode));

/**
 * Get error code from a code string
 */
export function getErrorCode(code: string): ErrorCode | null {
  return ERROR_CODE_SET.has(code) ? (code as ErrorCode) : null;
}

/**
 * Get default message for an error code
 */
export function getErrorMessage(code: ErrorCode): string {
  return ERROR_CODES[code]?.message ?? 'An error occurred';
}

/**
 * Derive the HTTP status for a GraphQL response, per the GraphQL-over-HTTP
 * status rule (see `statusForResponse` in the package README).
 *
 * - No errors: 200.
 * - `data` present and non-null (a spec-conformant partial success): 200,
 *   whatever the error codes say.
 * - Total failure (`data` undefined or null): the status registered in
 *   {@link ERROR_CODES} for the first error's `extensions.code` when it is a
 *   known code, otherwise 500.
 *
 * @param response - The GraphQL response (or any object with `data`/`errors`)
 * @returns The HTTP status code
 */
export function statusForResponse(response: {
  data?: unknown;
  errors?: readonly { extensions?: Record<string, unknown> }[];
}): number {
  if (!response.errors || response.errors.length === 0) {
    return 200;
  }
  if (response.data !== undefined && response.data !== null) {
    return 200;
  }
  const code = response.errors[0]?.extensions?.['code'];
  const known = typeof code === 'string' ? getErrorCode(code) : null;
  return known ? ERROR_CODES[known].status : 500;
}
