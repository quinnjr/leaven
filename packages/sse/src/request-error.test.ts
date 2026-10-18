/**
 * @leaven-graphql/sse - Request error classification tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { LeavenExecutor } from '@leaven-graphql/core';
import { ValidationError } from '@leaven-graphql/errors';
import { isRequestError } from './request-error';

const executor = new LeavenExecutor({
  schema: new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        hello: { type: GraphQLString, resolve: () => 'world' },
        bad: {
          type: GraphQLString,
          resolve: () => {
            throw new ValidationError('bad');
          },
        },
      },
    }),
  }),
});

describe('isRequestError', () => {
  test('should be true for a response the executor rejected before execution', async () => {
    const { response } = await executor.execute({ query: '{ nope }' });
    expect(isRequestError(response)).toBe(true);
  });

  test('should be false for a copy of a rejected response', async () => {
    const { response } = await executor.execute({ query: '{ nope }' });
    expect(isRequestError({ ...response })).toBe(false);
  });

  test('should be false for a look-alike response the executor did not produce', () => {
    expect(
      isRequestError({ errors: [{ message: 'x', extensions: { code: 'VALIDATION_ERROR' } }] })
    ).toBe(false);
  });

  test('should be false for a coded resolver error', async () => {
    const { response } = await executor.execute({ query: '{ bad }' });
    expect(response.errors?.[0]?.extensions?.code).toBe('VALIDATION_ERROR');
    expect(isRequestError(response)).toBe(false);
  });

  test('should be false for a successful response', async () => {
    const { response } = await executor.execute({ query: '{ hello }' });
    expect(isRequestError(response)).toBe(false);
  });
});
