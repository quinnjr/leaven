/**
 * @leaven-graphql/sse - Request error classification tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { ErrorCode } from '@leaven-graphql/errors';
import { REQUEST_ERROR_CODES, isRequestError } from './request-error';

const coded = (code: string): { message: string; extensions: { code: string } } => ({
  message: 'x',
  extensions: { code },
});

describe('isRequestError', () => {
  test.each([...REQUEST_ERROR_CODES])('should treat a data-less %s rejection as a request error', (code) => {
    expect(isRequestError({ errors: [coded(code)] })).toBe(true);
  });

  test('should allow exactly the pre-execution rejection codes', () => {
    expect([...REQUEST_ERROR_CODES].sort()).toEqual(
      [
        ErrorCode.BAD_REQUEST,
        ErrorCode.COMPLEXITY_LIMIT,
        ErrorCode.DEPTH_LIMIT,
        ErrorCode.PARSE_ERROR,
        ErrorCode.PERSISTED_QUERY_INVALID,
        ErrorCode.PERSISTED_QUERY_NOT_FOUND,
        ErrorCode.VALIDATION_ERROR,
      ].sort()
    );
  });

  test('should stream a data-less error whose code is not a rejection code', () => {
    expect(isRequestError({ errors: [coded('INTERNAL_ERROR')] })).toBe(false);
    expect(isRequestError({ errors: [coded('UNAUTHENTICATED')] })).toBe(false);
  });

  test('should stream a data-less error without a code', () => {
    expect(isRequestError({ errors: [{ message: 'hook failed' }] })).toBe(false);
  });

  test('should stream when any one error is not a rejection', () => {
    expect(
      isRequestError({ errors: [coded('VALIDATION_ERROR'), coded('INTERNAL_ERROR')] })
    ).toBe(false);
  });

  test('should stream a result that has data, null included', () => {
    expect(isRequestError({ data: null, errors: [coded('BAD_REQUEST')] })).toBe(false);
    expect(isRequestError({ data: { a: 1 }, errors: [coded('VALIDATION_ERROR')] })).toBe(false);
  });

  test('should stream a result with no errors', () => {
    expect(isRequestError({})).toBe(false);
    expect(isRequestError({ errors: [] })).toBe(false);
  });
});
