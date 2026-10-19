/**
 * @leaven-graphql/errors - Error codes tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { ErrorCode, ERROR_CODES, getErrorCode, getErrorMessage, statusForResponse } from './codes';

describe('ErrorCode', () => {
  test('should have all expected error codes', () => {
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCode.BAD_REQUEST).toBe('BAD_REQUEST');
    expect(ErrorCode.PAYLOAD_TOO_LARGE).toBe('PAYLOAD_TOO_LARGE');
    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCode.PARSE_ERROR).toBe('PARSE_ERROR');
    expect(ErrorCode.UNAUTHENTICATED).toBe('UNAUTHENTICATED');
    expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.ALREADY_EXISTS).toBe('ALREADY_EXISTS');
    expect(ErrorCode.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ErrorCode.COMPLEXITY_LIMIT).toBe('COMPLEXITY_LIMIT');
    expect(ErrorCode.DEPTH_LIMIT).toBe('DEPTH_LIMIT');
    expect(ErrorCode.PERSISTED_QUERY_NOT_FOUND).toBe('PERSISTED_QUERY_NOT_FOUND');
    expect(ErrorCode.PERSISTED_QUERY_INVALID).toBe('PERSISTED_QUERY_INVALID');
    expect(ErrorCode.INVALID_INPUT).toBe('INVALID_INPUT');
    expect(ErrorCode.MISSING_REQUIRED_FIELD).toBe('MISSING_REQUIRED_FIELD');
  });
});

describe('ERROR_CODES', () => {
  test('should have metadata for all error codes', () => {
    for (const code of Object.values(ErrorCode)) {
      const metadata = ERROR_CODES[code];
      expect(metadata).toBeDefined();
      expect(metadata.status).toBeGreaterThanOrEqual(400);
      expect(metadata.message).toBeDefined();
      expect(typeof metadata.message).toBe('string');
    }
  });

  test('should have correct status codes', () => {
    expect(ERROR_CODES[ErrorCode.INTERNAL_ERROR].status).toBe(500);
    expect(ERROR_CODES[ErrorCode.BAD_REQUEST].status).toBe(400);
    expect(ERROR_CODES[ErrorCode.UNAUTHENTICATED].status).toBe(401);
    expect(ERROR_CODES[ErrorCode.FORBIDDEN].status).toBe(403);
    expect(ERROR_CODES[ErrorCode.NOT_FOUND].status).toBe(404);
    expect(ERROR_CODES[ErrorCode.RATE_LIMITED].status).toBe(429);
    expect(ERROR_CODES[ErrorCode.PAYLOAD_TOO_LARGE].status).toBe(413);
  });
});

describe('getErrorCode', () => {
  test('should return ErrorCode for valid code string', () => {
    expect(getErrorCode('INTERNAL_ERROR')).toBe(ErrorCode.INTERNAL_ERROR);
    expect(getErrorCode('BAD_REQUEST')).toBe(ErrorCode.BAD_REQUEST);
    expect(getErrorCode('NOT_FOUND')).toBe(ErrorCode.NOT_FOUND);
    // @leaven-graphql/http emits this code for oversized request bodies and
    // relies on buildResponse resolving it through the registry.
    expect(getErrorCode('PAYLOAD_TOO_LARGE')).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  test('should return null for invalid code string', () => {
    expect(getErrorCode('INVALID_CODE')).toBeNull();
    expect(getErrorCode('')).toBeNull();
    expect(getErrorCode('internal_error')).toBeNull(); // case sensitive
  });
});

describe('getErrorMessage', () => {
  test('should return message for valid error code', () => {
    expect(getErrorMessage(ErrorCode.INTERNAL_ERROR)).toBe(
      'An internal error occurred'
    );
    expect(getErrorMessage(ErrorCode.UNAUTHENTICATED)).toBe(
      'Authentication required'
    );
    expect(getErrorMessage(ErrorCode.NOT_FOUND)).toBe('Resource not found');
  });

  test('should return default message for unknown code', () => {
    // TypeScript would normally prevent this, but testing runtime behavior
    const result = getErrorMessage('UNKNOWN' as ErrorCode);
    expect(result).toBe('An error occurred');
  });
});

describe('statusForResponse', () => {
  const err = (code?: string) => ({ extensions: code ? { code } : undefined });

  test('should return 200 when there are no errors', () => {
    expect(statusForResponse({ data: { a: 1 } })).toBe(200);
    expect(statusForResponse({ errors: [] })).toBe(200);
  });

  test('should return 200 for a partial success even with coded errors', () => {
    expect(statusForResponse({ data: { a: null }, errors: [err('NOT_FOUND')] })).toBe(200);
  });

  test('should map the first error code on total failure (data undefined)', () => {
    expect(statusForResponse({ errors: [err('NOT_FOUND')] })).toBe(404);
  });

  test('should treat null data as total failure', () => {
    expect(statusForResponse({ data: null, errors: [err('UNAUTHENTICATED')] })).toBe(401);
  });

  test('should fall back to 500 for unknown or missing codes', () => {
    expect(statusForResponse({ errors: [err('NOPE')] })).toBe(500);
    expect(statusForResponse({ errors: [err()] })).toBe(500);
    expect(statusForResponse({ errors: [{ extensions: { code: 42 } }] })).toBe(500);
  });
});
