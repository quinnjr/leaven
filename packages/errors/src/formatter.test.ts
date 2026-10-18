/**
 * @leaven-graphql/errors - Formatter tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import {
  GraphQLError,
  parse,
  type FieldNode,
  type OperationDefinitionNode,
} from 'graphql';
import {
  formatError,
  formatErrors,
  maskError,
  isLeavenError,
  errorToGraphQL,
  fromFormattedError,
} from './formatter';
import {
  LeavenError,
  ValidationError,
  AuthenticationError,
  NotFoundError,
} from './errors';
import { ErrorCode } from './codes';

describe('isLeavenError', () => {
  test('should return true for LeavenError', () => {
    const error = new LeavenError('Test');
    expect(isLeavenError(error)).toBe(true);
  });

  test('should return true for ValidationError', () => {
    const error = new ValidationError('Test');
    expect(isLeavenError(error)).toBe(true);
  });

  test('should return false for regular Error', () => {
    const error = new Error('Test');
    expect(isLeavenError(error)).toBe(false);
  });

  test('should return false for non-error', () => {
    expect(isLeavenError('string')).toBe(false);
    expect(isLeavenError(null)).toBe(false);
    expect(isLeavenError(undefined)).toBe(false);
  });
});

describe('errorToGraphQL', () => {
  test('should return a coded GraphQLError as-is', () => {
    const graphqlError = new GraphQLError('Test', {
      extensions: { code: ErrorCode.FORBIDDEN },
    });
    const result = errorToGraphQL(graphqlError);
    expect(result).toBe(graphqlError);
  });

  test('should assign INTERNAL_ERROR to a GraphQLError with no code', () => {
    const graphqlError = new GraphQLError('boom');
    const result = errorToGraphQL(graphqlError);

    expect(result).toBeInstanceOf(GraphQLError);
    expect(result.message).toBe('boom');
    expect(result.extensions.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  test('should preserve locations, path and originalError when adding a code', () => {
    const document = parse('{ user { name } }');
    const operation = document.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const cause = new Error('cause');
    const graphqlError = new GraphQLError('boom', {
      nodes: field,
      path: ['user'],
      originalError: cause,
      extensions: { hint: 'check the query' },
    });

    const result = errorToGraphQL(graphqlError);

    expect(result.extensions.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(result.extensions.hint).toBe('check the query');
    expect(result.locations).toEqual([{ line: 1, column: 3 }]);
    expect(result.path).toEqual(['user']);
    expect(result.originalError).toBe(cause);
  });

  test('should convert LeavenError to GraphQLError', () => {
    const leavenError = new LeavenError('Test', ErrorCode.BAD_REQUEST);
    const result = errorToGraphQL(leavenError);

    expect(result).toBeInstanceOf(GraphQLError);
    expect(result.message).toBe('Test');
    expect(result.extensions?.code).toBe(ErrorCode.BAD_REQUEST);
  });

  test('should convert regular Error to GraphQLError', () => {
    const error = new Error('Test error');
    const result = errorToGraphQL(error);

    expect(result).toBeInstanceOf(GraphQLError);
    expect(result.message).toBe('Test error');
    expect(result.extensions?.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  test('should convert string to GraphQLError', () => {
    const result = errorToGraphQL('String error');

    expect(result).toBeInstanceOf(GraphQLError);
    expect(result.message).toBe('String error');
  });
});

describe('maskError', () => {
  test('should not mask LeavenError', () => {
    // Go through the real conversion path used by formatError()
    const leavenError = new LeavenError('Test', ErrorCode.BAD_REQUEST);
    const graphqlError = errorToGraphQL(leavenError);
    const result = maskError(graphqlError, { maskErrors: true });

    expect(result.message).toBe('Test');
    expect(result.extensions?.code).toBe(ErrorCode.BAD_REQUEST);
  });

  test('should not mask LeavenError with INTERNAL_ERROR code', () => {
    const leavenError = new LeavenError('Intentional internal error');
    const graphqlError = errorToGraphQL(leavenError);
    const result = maskError(graphqlError, { maskErrors: true });

    expect(result.message).toBe('Intentional internal error');
  });

  test('should not mask GraphQLError carrying a known Leaven code', () => {
    const error = new GraphQLError('Access denied', {
      extensions: { code: ErrorCode.FORBIDDEN },
    });
    const result = maskError(error, { maskErrors: true });

    expect(result.message).toBe('Access denied');
    expect(result.extensions?.code).toBe(ErrorCode.FORBIDDEN);
  });

  test('should not mask validation errors', () => {
    const error = new GraphQLError('Validation failed', {
      extensions: { code: ErrorCode.VALIDATION_ERROR },
    });
    const result = maskError(error, { maskErrors: true });

    expect(result.message).toBe('Validation failed');
  });

  test('should mask internal errors when enabled', () => {
    const error = new GraphQLError('Database connection failed');
    const result = maskError(error, { maskErrors: true });

    expect(result.message).toBe('An unexpected error occurred');
  });

  test('should use custom masked message', () => {
    const error = new GraphQLError('Internal error');
    const result = maskError(error, {
      maskErrors: true,
      maskedMessage: 'Something went wrong',
    });

    expect(result.message).toBe('Something went wrong');
  });

  test('should not mask when disabled', () => {
    const error = new GraphQLError('Internal error');
    const result = maskError(error, { maskErrors: false });

    expect(result.message).toBe('Internal error');
  });

  test('should use custom shouldMask function', () => {
    const error = new GraphQLError('Test');
    const result = maskError(error, {
      maskErrors: true,
      shouldMask: () => false,
    });

    expect(result.message).toBe('Test');
  });

  test('should include locations', () => {
    // Build the error from a parsed document so `locations` is actually
    // populated — RedisDocumentCache.reviveError relies on maskError()
    // emitting this property.
    const document = parse('{ user { name } }');
    const operation = document.definitions[0] as OperationDefinitionNode;
    const field = operation.selectionSet.selections[0] as FieldNode;
    const error = new GraphQLError('Test', { nodes: field });

    expect(error.locations).toEqual([{ line: 1, column: 3 }]);

    const result = maskError(error, { maskErrors: false });

    expect(result.message).toBe('Test');
    expect(result.locations).toEqual([{ line: 1, column: 3 }]);
  });

  test('should include path', () => {
    const error = new GraphQLError('Test', {
      path: ['user', 'name'],
    });
    const result = maskError(error, { maskErrors: false });

    expect(result.path).toEqual(['user', 'name']);
  });

  test('should include extensions', () => {
    const error = new GraphQLError('Test', {
      extensions: { code: 'TEST', custom: 'value' },
    });
    const result = maskError(error, { maskErrors: false });

    expect(result.extensions?.code).toBe('TEST');
    expect(result.extensions?.custom).toBe('value');
  });

  test('should include stack trace when enabled', () => {
    const original = new Error('Test');
    const error = new GraphQLError('Test', {
      originalError: original,
      extensions: { code: 'TEST' },
    });
    const result = maskError(error, {
      maskErrors: false,
      includeStackTrace: true,
    });

    expect(result.extensions?.stackTrace).toBeDefined();
  });

  test('should include stack trace when error has no extensions', () => {
    const error = new GraphQLError('Test');
    const result = maskError(error, {
      maskErrors: false,
      includeStackTrace: true,
    });

    expect(result.extensions?.stackTrace).toBeDefined();
  });

  test('should use custom formatter', () => {
    const error = new GraphQLError('Test');
    const result = maskError(error, {
      formatter: (err, masked) => ({
        message: masked ? 'Masked' : err.message,
        extensions: { formatted: true },
      }),
    });

    expect(result.extensions?.formatted).toBe(true);
  });
});

describe('formatError', () => {
  test('should format LeavenError', () => {
    const error = new LeavenError('Test');
    const result = formatError(error);

    expect(result.message).toBe('Test');
  });

  test('should format regular Error', () => {
    const error = new Error('Test');
    const result = formatError(error);

    expect(result.message).toBe('Test');
  });

  test('should format GraphQLError', () => {
    const error = new GraphQLError('Test');
    const result = formatError(error);

    expect(result.message).toBe('Test');
  });

  test('should give a bare GraphQLError a fallback code', () => {
    const result = formatError(new GraphQLError('boom'));

    expect(result.message).toBe('boom');
    expect(result.extensions?.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  test('should apply options', () => {
    const error = new Error('Internal error');
    const result = formatError(error, { maskErrors: true });

    expect(result.message).toBe('An unexpected error occurred');
  });

  test('should not mask AuthenticationError when masking is enabled', () => {
    const result = formatError(new AuthenticationError('Please log in'), {
      maskErrors: true,
    });

    expect(result.message).toBe('Please log in');
    expect(result.extensions?.code).toBe('UNAUTHENTICATED');
  });

  test('should preserve message and code of Leaven errors when masking is enabled', () => {
    const result = formatError(
      new NotFoundError('User not found', {
        resourceType: 'User',
        resourceId: '123',
      }),
      { maskErrors: true }
    );

    expect(result.message).toBe('User not found');
    expect(result.extensions?.code).toBe(ErrorCode.NOT_FOUND);
    expect(result.extensions?.resourceType).toBe('User');
  });
});

describe('formatErrors', () => {
  test('should format array of errors', () => {
    const errors = [
      new LeavenError('Error 1'),
      new Error('Error 2'),
      new GraphQLError('Error 3'),
    ];
    const results = formatErrors(errors);

    expect(results.length).toBe(3);
    expect(results[0]?.message).toBe('Error 1');
    expect(results[1]?.message).toBe('Error 2');
    expect(results[2]?.message).toBe('Error 3');
  });

  test('should apply options to all errors', () => {
    const errors = [new Error('Error 1'), new Error('Error 2')];
    const results = formatErrors(errors, { maskErrors: true });

    expect(results[0]?.message).toBe('An unexpected error occurred');
    expect(results[1]?.message).toBe('An unexpected error occurred');
  });
});

describe('fromFormattedError', () => {
  test('should rebuild message, path, locations and extensions', () => {
    const rebuilt = fromFormattedError({
      message: 'Field failed',
      path: ['user', 0, 'name'],
      locations: [{ line: 2, column: 5 }],
      extensions: { code: ErrorCode.NOT_FOUND, resourceType: 'User' },
    });

    expect(rebuilt).toBeInstanceOf(GraphQLError);
    expect(rebuilt.message).toBe('Field failed');
    expect(rebuilt.path).toEqual(['user', 0, 'name']);
    expect(rebuilt.locations).toEqual([{ line: 2, column: 5 }]);
    expect(rebuilt.extensions).toEqual({ code: ErrorCode.NOT_FOUND, resourceType: 'User' });
  });

  test('should round-trip through formatError without loss', () => {
    const formatted = {
      message: 'Please log in',
      path: ['me'],
      locations: [{ line: 1, column: 3 }],
      extensions: { code: ErrorCode.UNAUTHENTICATED },
    };

    expect(formatError(fromFormattedError(formatted), { maskErrors: true })).toEqual(formatted);
  });

  test('should let an uncoded formatted error be masked', () => {
    const result = formatError(fromFormattedError({ message: 'connect ECONNREFUSED' }), {
      maskErrors: true,
    });

    expect(result).toEqual({
      message: 'An unexpected error occurred',
      extensions: { code: ErrorCode.INTERNAL_ERROR },
    });
  });

  test('should not alias the formatted error arrays or extensions', () => {
    const formatted = {
      message: 'x',
      path: ['a'],
      locations: [{ line: 1, column: 1 }],
      extensions: { code: ErrorCode.BAD_REQUEST },
    };
    const rebuilt = fromFormattedError(formatted);

    expect(rebuilt.path).not.toBe(formatted.path);
    expect(rebuilt.locations).not.toBe(formatted.locations);
    expect(rebuilt.extensions).not.toBe(formatted.extensions);
  });

  test('should omit locations when the formatted error has none', () => {
    expect(fromFormattedError({ message: 'x', locations: [] }).locations).toBeUndefined();
  });
});
