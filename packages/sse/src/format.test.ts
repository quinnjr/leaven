/**
 * @leaven-graphql/sse - Result error formatting tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import type { GraphQLResponse } from '@leaven-graphql/core';
import { formatResultErrors } from './format';

describe('formatResultErrors', () => {
  test('should return a result without errors unchanged', () => {
    const result: GraphQLResponse = { data: { a: 1 } };
    expect(formatResultErrors(result, { maskErrors: true })).toBe(result);
  });

  test('should keep an intentional error, its code and its path when masking', () => {
    const result: GraphQLResponse = {
      data: null,
      errors: [
        {
          message: 'Sign in first',
          path: ['me'],
          locations: [{ line: 1, column: 3 }],
          extensions: { code: 'UNAUTHENTICATED' },
        },
      ],
    };
    const formatted = formatResultErrors(result, { maskErrors: true });
    expect(formatted.data).toBeNull();
    expect(formatted.errors).toEqual([
      {
        message: 'Sign in first',
        path: ['me'],
        locations: [{ line: 1, column: 3 }],
        extensions: { code: 'UNAUTHENTICATED' },
      },
    ]);
  });

  test('should mask an unexpected error', () => {
    const formatted = formatResultErrors(
      { data: null, errors: [{ message: 'db password leaked', path: ['me'] }] },
      { maskErrors: true }
    );
    expect(formatted.errors).toEqual([
      {
        message: 'An unexpected error occurred',
        path: ['me'],
        extensions: { code: 'INTERNAL_ERROR' },
      },
    ]);
  });

  test('should not mask without options', () => {
    const formatted = formatResultErrors({ errors: [{ message: 'raw detail' }] });
    expect(formatted.errors?.[0]?.message).toBe('raw detail');
  });

  test('should keep the other fields of the result', () => {
    const formatted = formatResultErrors(
      { data: { a: 1 }, errors: [{ message: 'x' }], extensions: { cost: 3 } },
      { maskErrors: true }
    );
    expect(formatted.data).toEqual({ a: 1 });
    expect(formatted.extensions).toEqual({ cost: 3 });
  });
});
