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

const schema = new GraphQLSchema({
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
});

const executor = new LeavenExecutor({ schema });

type Hook = 'onParse' | 'onParsed' | 'onValidate' | 'onValidated' | 'onExecute' | 'onExecuted';

/** An executor whose only hook throws */
function throwingHook(hook: Hook): LeavenExecutor {
  return new LeavenExecutor({
    schema,
    hooks: {
      [hook]: () => {
        throw new Error(`${hook} failed`);
      },
    },
  });
}

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

  test.each(['onParse', 'onParsed', 'onValidate', 'onValidated'] as const)(
    'should be true when %s throws before execution starts',
    async (hook) => {
      const { response } = await throwingHook(hook).execute({ query: '{ hello }' });
      expect(isRequestError(response)).toBe(true);
      const result = await throwingHook(hook).subscribe({ query: '{ hello }' });
      expect(isRequestError(result as typeof response)).toBe(true);
    }
  );

  test.each(['onExecute', 'onExecuted'] as const)(
    'should be false when %s throws after execution started',
    async (hook) => {
      const { response } = await throwingHook(hook).execute({ query: '{ hello }' });
      expect(response.errors?.length).toBe(1);
      expect(isRequestError(response)).toBe(false);
    }
  );

  test('should be false when the document cache read fails (a cache miss)', async () => {
    const read = (): Promise<never> => Promise.reject(new Error('redis down'));
    const cached = new LeavenExecutor({
      schema,
      cache: {
        get: read,
        getWithValidation: read,
        set: () => undefined,
        setValidation: () => undefined,
        setWithValidation: () => undefined,
        has: () => false,
        delete: () => false,
        clear: () => undefined,
        size: () => 0,
      } as unknown as ConstructorParameters<typeof LeavenExecutor>[0]['cache'],
    });
    const { response } = await cached.execute({ query: '{ hello }' });
    expect(response.data).toEqual({ hello: 'world' });
    expect(isRequestError(response)).toBe(false);
  });
});
