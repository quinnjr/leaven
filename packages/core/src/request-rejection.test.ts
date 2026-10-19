/**
 * @leaven-graphql/core - Pre-execution rejection marking tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import {
  GraphQLBoolean,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  versionInfo,
} from 'graphql';
import { ValidationError } from '@leaven-graphql/errors';
import { LeavenExecutor, isRequestRejection, type ExecutorConfig } from './index';

let resolverRuns = 0;

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: { type: GraphQLString, resolve: () => 'world' },
      flag: {
        type: GraphQLBoolean,
        args: { on: { type: new GraphQLNonNull(GraphQLBoolean) } },
        resolve: (_root, args: { on: boolean }) => args.on,
      },
      boom: {
        type: GraphQLString,
        resolve: () => {
          throw new ValidationError('bad value');
        },
      },
      nested: {
        type: new GraphQLObjectType({
          name: 'Nested',
          fields: () => ({ inner: { type: GraphQLString, resolve: () => 'x' } }),
        }),
        resolve: () => ({}),
      },
    },
  }),
  mutation: new GraphQLObjectType({
    name: 'Mutation',
    fields: {
      record: {
        type: GraphQLString,
        resolve: () => {
          resolverRuns++;
          return 'ok';
        },
      },
    },
  }),
  subscription: new GraphQLObjectType({
    name: 'Subscription',
    fields: {
      ticks: {
        type: GraphQLInt,
        args: { from: { type: new GraphQLNonNull(GraphQLInt) } },
        subscribe: async function* () {
          yield { ticks: 1 };
        },
      },
      guarded: {
        type: GraphQLInt,
        subscribe: () => {
          throw new ValidationError('not allowed');
        },
      },
    },
  }),
});

function executor(config: Partial<ExecutorConfig> = {}): LeavenExecutor {
  return new LeavenExecutor({ schema, ...config });
}

/** A document cache whose read (and optionally write) runs the given functions */
function failingCache(
  read: () => unknown,
  write: () => unknown = () => undefined
): ExecutorConfig['cache'] {
  return {
    get: read,
    getWithValidation: read,
    set: write,
    setValidation: write,
    setWithValidation: write,
    has: () => false,
    delete: () => false,
    clear: () => {},
    size: () => 0,
  } as unknown as ExecutorConfig['cache'];
}

async function executeResponse(query: string, config: Partial<ExecutorConfig> = {}, extra = {}) {
  return (await executor(config).execute({ query, ...extra })).response;
}

describe('isRequestRejection', () => {
  describe('execute: rejected before any resolver runs', () => {
    test.each([
      ['a syntax error', '{ hello', {}, {}],
      ['a validation error', '{ nope }', {}, {}],
      ['a depth limit', '{ nested { inner } }', { maxDepth: 1 }, {}],
      ['a maxTokens limit', '{ hello hello hello }', { parseOptions: { maxTokens: 2 } }, {}],
      [
        'a complexity limit',
        '{ hello }',
        { compilerOptions: { calculateComplexity: true }, maxComplexity: 0 },
        {},
      ],
      ['an unknown operation name', 'query A { hello }', {}, { operationName: 'B' }],
      [
        'a variable coercion error',
        'query ($on: Boolean!) { flag(on: $on) }',
        {},
        { variables: { on: 'yes' } },
      ],
    ])('should mark %s', async (_label, query, config, extra) => {
      const response = await executeResponse(query, config as Partial<ExecutorConfig>, extra);
      expect(response.errors?.length).toBeGreaterThan(0);
      expect(response.data).toBeUndefined();
      expect(isRequestRejection(response)).toBe(true);
    });
  });

  describe('execute: failures before execution starts', () => {
    test.each(['onParse', 'onParsed', 'onValidate', 'onValidated'] as const)(
      'should mark a %s throw',
      async (hook) => {
        resolverRuns = 0;
        const response = await executeResponse('mutation { record }', {
          hooks: {
            [hook]: () => {
              throw new Error(`${hook} failed`);
            },
          },
        });
        expect(resolverRuns).toBe(0);
        expect(response.data).toBeUndefined();
        expect(response.errors?.length).toBe(1);
        expect(isRequestRejection(response)).toBe(true);
      }
    );

    test('should mark a rejecting async onParse hook', async () => {
      const response = await executeResponse('{ hello }', {
        hooks: { onParse: () => Promise.reject(new Error('denied')) },
      });
      expect(isRequestRejection(response)).toBe(true);
    });

    test('should still run the request when a document cache write fails', async () => {
      const response = await executeResponse('{ hello }', {
        cache: failingCache(() => null, () => {
          throw new Error('redis down');
        }),
      });
      expect(response.data).toEqual({ hello: 'world' });
      expect(isRequestRejection(response)).toBe(false);
    });
  });

  describe('operation type the schema does not support', () => {
    // graphql 17 rejects it during validation (VALIDATION_ERROR); on graphql 16
    // validation passes and the executor's own check answers BAD_REQUEST
    const expectedCode = versionInfo.major >= 17 ? 'VALIDATION_ERROR' : 'BAD_REQUEST';
    const queryOnly = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
      }),
    });

    test('should reject a mutation with a coded rejection', async () => {
      const { response } = await new LeavenExecutor({ schema: queryOnly }).execute({
        query: 'mutation { record }',
      });
      expect(response.data).toBeUndefined();
      expect(response.errors?.length).toBe(1);
      expect(response.errors?.[0]?.extensions?.code).toBe(expectedCode);
      expect(isRequestRejection(response)).toBe(true);
    });

    test('should reject a subscription with a coded rejection', async () => {
      const response = await new LeavenExecutor({ schema: queryOnly }).subscribe({
        query: 'subscription { ticks }',
      });
      expect('errors' in response).toBe(true);
      const errors = (response as { errors?: Array<{ extensions?: { code?: string } }> }).errors;
      expect(errors?.[0]?.extensions?.code).toBe(expectedCode);
      expect(isRequestRejection(response)).toBe(true);
    });

    test('should leave queries unaffected', async () => {
      const { response } = await new LeavenExecutor({ schema: queryOnly }).execute({
        query: '{ hello }',
      });
      expect(response.data).toEqual({ hello: 'world' });
      expect(isRequestRejection(response)).toBe(false);
    });
  });

  describe('execute: not rejections', () => {
    test('should not mark a successful response', async () => {
      expect(isRequestRejection(await executeResponse('{ hello }'))).toBe(false);
    });

    test('should not mark a resolver error', async () => {
      const response = await executeResponse('{ boom }');
      expect(response.errors?.[0]?.extensions?.code).toBe('VALIDATION_ERROR');
      expect(isRequestRejection(response)).toBe(false);
    });

    test('should not mark an onExecuted throw, even a coded one', async () => {
      resolverRuns = 0;
      const response = await executeResponse('mutation { record }', {
        hooks: {
          onExecuted: () => {
            throw new ValidationError('audit failed');
          },
        },
      });
      expect(resolverRuns).toBe(1);
      expect(response.data).toBeUndefined();
      expect(response.errors?.[0]?.extensions?.code).toBe('VALIDATION_ERROR');
      expect(isRequestRejection(response)).toBe(false);
    });

    test('should not mark an onExecute throw', async () => {
      const response = await executeResponse('{ hello }', {
        hooks: {
          onExecute: () => {
            throw new ValidationError('denied');
          },
        },
      });
      expect(response.errors?.length).toBe(1);
      expect(isRequestRejection(response)).toBe(false);
    });

    test('should treat a cache read failure as a miss, not a failure', async () => {
      const response = await executeResponse('{ hello }', {
        cache: {
          get: () => undefined,
          getWithValidation: () => {
            throw new Error('redis down');
          },
          set: () => {},
          setValidation: () => {},
          setWithValidation: () => {},
          has: () => false,
          delete: () => false,
          clear: () => {},
          size: () => 0,
        } as unknown as ExecutorConfig['cache'],
      });
      expect(response.errors).toBeUndefined();
      expect(response.data).toEqual({ hello: 'world' });
      expect(isRequestRejection(response)).toBe(false);
    });

    test('should be identity-based: a copy of a rejection is not marked', async () => {
      const response = await executeResponse('{ nope }');
      expect(isRequestRejection(response)).toBe(true);
      expect(isRequestRejection({ ...response })).toBe(false);
    });

    test.each([undefined, null, 'x', 1])('should return false for %p', (value) => {
      expect(isRequestRejection(value)).toBe(false);
    });
  });

  describe('subscribe', () => {
    test('should mark a validation rejection', async () => {
      expect(isRequestRejection(await executor().subscribe({ query: 'subscription { nope }' }))).toBe(
        true
      );
    });

    test('should mark a syntax error', async () => {
      expect(isRequestRejection(await executor().subscribe({ query: 'subscription {' }))).toBe(true);
    });

    test('should mark a variable coercion error', async () => {
      const result = await executor().subscribe({
        query: 'subscription ($from: Int!) { ticks(from: $from) }',
        variables: { from: 'one' },
      });
      expect(isRequestRejection(result)).toBe(true);
    });

    test.each(['onParse', 'onParsed', 'onValidate', 'onValidated'] as const)(
      'should mark a %s throw',
      async (hook) => {
        const result = await executor({
          hooks: {
            [hook]: () => {
              throw new Error(`${hook} failed`);
            },
          },
        }).subscribe({ query: 'subscription { ticks(from: 1) }' });
        expect(Symbol.asyncIterator in result).toBe(false);
        expect(isRequestRejection(result)).toBe(true);
      }
    );

    test('should treat a document cache read failure as a miss and subscribe', async () => {
      const cacheErrors: Error[] = [];
      const result = await executor({
        cache: failingCache(() => Promise.reject(new Error('redis down'))),
        hooks: { onCacheError: (error) => void cacheErrors.push(error) },
      }).subscribe({ query: 'subscription { ticks(from: 1) }' });
      expect(Symbol.asyncIterator in result).toBe(true);
      expect(isRequestRejection(result)).toBe(false);
      expect(cacheErrors[0]?.message).toBe('redis down');
      await (result as AsyncIterableIterator<unknown>).return?.();
    });

    test('should not mark a subscribe resolver that throws a coded error', async () => {
      const result = await executor().subscribe({ query: 'subscription { guarded }' });
      expect(Symbol.asyncIterator in result).toBe(false);
      expect((result as { errors?: Array<{ path?: unknown }> }).errors?.[0]?.path).toEqual([
        'guarded',
      ]);
      expect(isRequestRejection(result)).toBe(false);
    });

    test('should not mark an onExecute throw', async () => {
      const result = await executor({
        hooks: {
          onExecute: () => {
            throw new ValidationError('denied');
          },
        },
      }).subscribe({ query: 'subscription { ticks(from: 1) }' });
      expect(isRequestRejection(result)).toBe(false);
    });
  });
});
