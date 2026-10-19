/**
 * @leaven-graphql/nestjs - Driver tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { GraphQLSchema, GraphQLObjectType, GraphQLString, parse } from 'graphql';
import { calculateQueryDepth } from '@leaven-graphql/core';
import {
  AuthenticationError,
  ErrorCode,
  LeavenError,
  ValidationError,
} from '@leaven-graphql/errors';
import { LeavenDriver } from './driver';
import { withNodeEnv } from './test-utils/env';
import type { FormatErrorFn, GqlContext, LeavenModuleOptions } from './types';

describe('LeavenDriver', () => {
  let driver: LeavenDriver;
  let schema: GraphQLSchema;

  beforeEach(() => {
    schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          hello: {
            type: GraphQLString,
            resolve: () => 'world',
          },
          echo: {
            type: GraphQLString,
            args: {
              message: { type: GraphQLString },
            },
            resolve: (_, args) => args.message,
          },
        },
      }),
    });
  });

  afterEach(async () => {
    await driver?.onModuleDestroy();
  });

  describe('initialization', () => {
    test('should initialize with schema', async () => {
      const options: LeavenModuleOptions = { schema };
      driver = new LeavenDriver(options);
      await driver.onModuleInit();

      expect(driver.getSchema()).toBe(schema);
      expect(driver.getExecutor()).not.toBeNull();
    });

    test('should initialize without schema', async () => {
      const options: LeavenModuleOptions = {};
      driver = new LeavenDriver(options);
      await driver.onModuleInit();

      expect(driver.getSchema()).toBeNull();
      expect(driver.getExecutor()).toBeNull();
    });

    test('should allow setting schema after initialization', async () => {
      const options: LeavenModuleOptions = {};
      driver = new LeavenDriver(options);
      await driver.onModuleInit();

      driver.setSchema(schema);

      expect(driver.getSchema()).toBe(schema);
      expect(driver.getExecutor()).not.toBeNull();
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      const options: LeavenModuleOptions = { schema };
      driver = new LeavenDriver(options);
      await driver.onModuleInit();
    });

    test('should execute a simple query', async () => {
      const result = await driver.execute('{ hello }');

      expect(result.data).toEqual({ hello: 'world' });
      expect(result.errors).toBeUndefined();
    });

    test('should execute a parsed DocumentNode', async () => {
      const result = await driver.execute(parse('{ hello }'));

      expect(result.data).toEqual({ hello: 'world' });
      expect(result.errors).toBeUndefined();
    });

    test('should execute query with variables', async () => {
      const result = await driver.execute(
        'query Echo($msg: String) { echo(message: $msg) }',
        { msg: 'test message' }
      );

      expect(result.data).toEqual({ echo: 'test message' });
      expect(result.errors).toBeUndefined();
    });

    test('should handle execution errors', async () => {
      const errorSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            error: {
              type: GraphQLString,
              resolve: () => {
                throw new Error('Test error');
              },
            },
          },
        }),
      });

      driver.setSchema(errorSchema);
      const result = await driver.execute('{ error }');

      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    describe('production masking of reported errors', () => {
      const maskSchema = (): GraphQLSchema =>
        new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query',
            fields: {
              crash: {
                type: GraphQLString,
                resolve: () => {
                  throw new Error('db password hunter2');
                },
              },
              auth: {
                type: GraphQLString,
                resolve: () => {
                  throw new AuthenticationError('Log in first');
                },
              },
              internal: {
                type: GraphQLString,
                resolve: () => {
                  throw new LeavenError('Upstream unavailable', ErrorCode.INTERNAL_ERROR);
                },
              },
              nestAuth: {
                type: GraphQLString,
                resolve: () => {
                  throw new UnauthorizedException('Session expired');
                },
              },
              nestCrash: {
                type: GraphQLString,
                resolve: () => {
                  throw new InternalServerErrorException('db password hunter2');
                },
              },
            },
          }),
        });

      async function run(
        query: string,
        env: string,
        options: Partial<LeavenModuleOptions> = {}
      ): Promise<Awaited<ReturnType<LeavenDriver['execute']>>> {
        return withNodeEnv(env, async () => {
          const masking = new LeavenDriver({ schema: maskSchema(), ...options });
          await masking.onModuleInit();
          try {
            return await masking.execute(query);
          } finally {
            await masking.onModuleDestroy();
          }
        });
      }

      test('should mask a resolver error in production', async () => {
        const result = await run('{ crash }', 'production');

        expect(result.data).toEqual({ crash: null });
        expect(result.errors).toEqual([
          {
            message: 'An unexpected error occurred',
            locations: [{ line: 1, column: 3 }],
            path: ['crash'],
            extensions: { code: 'INTERNAL_ERROR' },
          },
        ]);
      });

      test('should keep an intentional Leaven error in production, even INTERNAL_ERROR', async () => {
        const auth = await run('{ auth }', 'production');
        expect(auth.errors?.[0]?.message).toBe('Log in first');
        expect(auth.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
        expect(auth.errors?.[0]?.path).toEqual(['auth']);

        const internal = await run('{ internal }', 'production');
        expect(internal.errors?.[0]?.message).toBe('Upstream unavailable');
      });

      test("should map a resolver's NestJS HttpException to its code in production, unmasked", async () => {
        const result = await run('{ nestAuth }', 'production');

        expect(result.errors?.[0]?.message).toBe('Session expired');
        expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
        expect(result.errors?.[0]?.extensions?.statusCode).toBe(401);
        expect(result.errors?.[0]?.path).toEqual(['nestAuth']);
      });

      test('should still mask a 5xx NestJS HttpException in production', async () => {
        const result = await run('{ nestCrash }', 'production');

        expect(result.errors?.[0]?.message).toBe('An unexpected error occurred');
        expect(result.errors?.[0]?.extensions?.code).toBe('INTERNAL_ERROR');
      });

      test('should not mask a resolver error outside production', async () => {
        const result = await run('{ crash }', 'development');

        expect(result.errors?.[0]?.message).toBe('db password hunter2');
        expect(result.errors?.[0]?.path).toEqual(['crash']);
      });

      test('should not mask when includeStacktraceInErrorResponses is set', async () => {
        const result = await run('{ crash }', 'production', {
          includeStacktraceInErrorResponses: true,
        });

        expect(result.errors?.[0]?.message).toBe('db password hunter2');
      });

      test('should hand the masked error to formatError', async () => {
        const seen: string[] = [];
        const result = await run('{ crash }', 'production', {
          formatError: (error) => {
            seen.push(error.message);
            return error;
          },
        });

        expect(seen).toEqual(['An unexpected error occurred']);
        expect(result.errors?.[0]?.message).toBe('An unexpected error occurred');
      });
    });

    describe('errors the executor catches itself', () => {
      const caught = { message: 'compiler blew up: secret-dsn', extensions: { code: 'INTERNAL_ERROR' } };

      async function runCaught(env: string, options: Partial<LeavenModuleOptions> = {}) {
        return withNodeEnv(env, async () => {
          const d = new LeavenDriver({ schema, ...options });
          await d.onModuleInit();
          try {
            const executor = d.getExecutor() as unknown as {
              execute: () => Promise<unknown>;
              subscribe: () => Promise<unknown>;
            };
            executor.execute = async () => ({ response: { errors: [caught] } });
            executor.subscribe = async () =>
              (async function* () {
                yield { errors: [caught] };
              })();
            const result = await d.execute('{ hello }');
            const stream = (await d.subscribe('subscription { x }')) as AsyncIterableIterator<{
              errors?: readonly { message: string }[];
            }>;
            const first = await stream.next();
            return { result, streamed: first.value };
          } finally {
            await d.onModuleDestroy();
          }
        });
      }

      test('should mask a pipeline-caught internal error in production', async () => {
        const { result, streamed } = await runCaught('production');
        expect(result.errors?.[0]?.message).toBe('An unexpected error occurred');
        expect(streamed.errors?.[0]?.message).toBe('An unexpected error occurred');
      });

      test('should not mask it when stacktraces are enabled', async () => {
        const { result, streamed } = await runCaught('production', {
          includeStacktraceInErrorResponses: true,
        });
        expect(result.errors?.[0]?.message).toBe(caught.message);
        expect(streamed.errors?.[0]?.message).toBe(caught.message);
      });
    });

    test('should throw if executor not initialized', async () => {
      const emptyDriver = new LeavenDriver({});
      await emptyDriver.onModuleInit();

      await expect(emptyDriver.execute('{ hello }')).rejects.toThrow(
        'Executor not initialized'
      );
    });

    test('should include metrics when enabled', async () => {
      const metricsDriver = new LeavenDriver({ schema, metrics: true });
      await metricsDriver.onModuleInit();

      const result = await metricsDriver.execute('{ hello }');

      expect(result.extensions?.metrics).toBeDefined();
      await metricsDriver.onModuleDestroy();
    });

    test('should format errors when formatter provided', async () => {
      const formatError = (error: { message: string }) => ({
        ...error,
        message: `Formatted: ${error.message}`,
      });

      const formattedDriver = new LeavenDriver({
        schema: new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query',
            fields: {
              error: {
                type: GraphQLString,
                resolve: () => {
                  throw new Error('Original error');
                },
              },
            },
          }),
        }),
        formatError,
      });
      await formattedDriver.onModuleInit();

      const result = await formattedDriver.execute('{ error }');

      expect(result.errors?.[0]?.message).toContain('Formatted:');
      await formattedDriver.onModuleDestroy();
    });

    test('should format subscription errors with the same formatter as execute', async () => {
      const formatError = (error: { message: string }): { message: string } => ({
        ...error,
        message: `Formatted: ${error.message}`,
      });

      const formattedDriver = new LeavenDriver({
        schema: new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query',
            fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
          }),
        }),
        formatError,
      });
      await formattedDriver.onModuleInit();

      const result = await formattedDriver.subscribe('subscription { nope }');

      expect(Symbol.asyncIterator in result).toBe(false);
      const errors = (result as { errors?: Array<{ message: string }> }).errors;
      expect(errors?.[0]?.message).toContain('Formatted:');
      await formattedDriver.onModuleDestroy();
    });

    test('should format the errors of every subscription event with the same formatter', async () => {
      const formatError = (error: { message: string }): { message: string } => ({
        ...error,
        message: `Formatted: ${error.message}`,
      });

      const formattedDriver = new LeavenDriver({
        schema: new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query',
            fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
          }),
          subscription: new GraphQLObjectType({
            name: 'Subscription',
            fields: {
              poisoned: {
                type: GraphQLString,
                subscribe: async function* (): AsyncGenerator<{ poisoned: string }> {
                  yield { poisoned: 'a' };
                  yield { poisoned: 'b' };
                },
                resolve: (payload: { poisoned: string }) => {
                  if (payload.poisoned === 'a') {
                    throw new Error('internal detail');
                  }
                  return payload.poisoned;
                },
              },
            },
          }),
        }),
        formatError,
      });
      await formattedDriver.onModuleInit();

      const result = await formattedDriver.subscribe('subscription { poisoned }');
      expect(Symbol.asyncIterator in result).toBe(true);

      const events: Array<{ data?: unknown; errors?: readonly { message: string }[] }> = [];
      for await (const event of result as AsyncIterableIterator<{
        data?: unknown;
        errors?: readonly { message: string }[];
      }>) {
        events.push(event);
      }

      expect(events[0]?.errors?.[0]?.message).toBe('Formatted: internal detail');
      expect(events[1]?.errors).toBeUndefined();
      expect(events[1]?.data).toEqual({ poisoned: 'b' });
      await formattedDriver.onModuleDestroy();
    });

    test('should expose formatThrownError with the masking rules of execute', async () => {
      await withNodeEnv('production', async () => {
        const plain = new LeavenDriver({});
        expect(plain.formatThrownError(new Error('dsn leaked'))).toEqual({
          message: 'An unexpected error occurred',
          extensions: { code: 'INTERNAL_ERROR' },
        });
        expect(plain.formatThrownError(new AuthenticationError('Log in')).message).toBe('Log in');
      });
    });

    test('should map a thrown HttpException in formatThrownError and keep a 5xx masked', async () => {
      await withNodeEnv('production', async () => {
        const plain = new LeavenDriver({});
        const mapped = plain.formatThrownError(new UnauthorizedException('bad token'));
        expect(mapped.message).toBe('bad token');
        expect(mapped.extensions?.code).toBe('UNAUTHENTICATED');
        expect(plain.formatThrownError(new InternalServerErrorException('db down'))).toEqual({
          message: 'An unexpected error occurred',
          extensions: { code: 'INTERNAL_ERROR' },
        });
      });
    });

    test('should invoke formatError with exactly one argument', async () => {
      const receivedArgCounts: number[] = [];
      const formatError = ((...args: unknown[]) => {
        receivedArgCounts.push(args.length);
        return args[0];
      }) as FormatErrorFn;

      const arityDriver = new LeavenDriver({
        schema: new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query',
            fields: {
              error: {
                type: GraphQLString,
                resolve: () => {
                  throw new Error('Boom');
                },
              },
            },
          }),
        }),
        formatError,
      });
      await arityDriver.onModuleInit();

      const result = await arityDriver.execute('{ error }');

      expect(result.errors?.length).toBe(1);
      expect(receivedArgCounts).toEqual([1]);
      await arityDriver.onModuleDestroy();
    });

    test('should preserve Leaven error codes when execution throws', async () => {
      const executor = driver.getExecutor();
      (executor as unknown as { execute: () => Promise<never> }).execute =
        async () => {
          throw new AuthenticationError('Token expired');
        };

      const result = await driver.execute('{ hello }');

      expect(result.errors?.length).toBe(1);
      expect(result.errors?.[0]?.message).toBe('Token expired');
      expect(result.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    });

    test('should mask unexpected errors in production when execution throws', async () => {
      await withNodeEnv('production', async () => {
        const executor = driver.getExecutor();
        (executor as unknown as { execute: () => Promise<never> }).execute =
          async () => {
            throw new Error('database connection string leaked');
          };

        const result = await driver.execute('{ hello }');

        expect(result.errors?.length).toBe(1);
        expect(result.errors?.[0]?.message).toBe('An unexpected error occurred');
        expect(result.errors?.[0]?.message).not.toContain('database');
        expect(result.errors?.[0]?.extensions?.code).toBe('INTERNAL_ERROR');
      });
    });

    test('should keep the real message for unexpected errors in development', async () => {
      await withNodeEnv('development', async () => {
        const executor = driver.getExecutor();
        (executor as unknown as { execute: () => Promise<never> }).execute =
          async () => {
            throw new Error('connection refused on port 5432');
          };

        const result = await driver.execute('{ hello }');

        expect(result.errors?.length).toBe(1);
        expect(result.errors?.[0]?.message).toBe('connection refused on port 5432');
      });
    });

    test('should include a stack trace when includeStacktraceInErrorResponses is set', async () => {
      // Production would normally mask; the stack-trace flag must win, since
      // a masked error carries no stack to include.
      await withNodeEnv('production', async () => {
        const stackDriver = new LeavenDriver({
          schema,
          includeStacktraceInErrorResponses: true,
        });
        await stackDriver.onModuleInit();

        const executor = stackDriver.getExecutor();
        (executor as unknown as { execute: () => Promise<never> }).execute =
          async () => {
            throw new Error('boom with a stack');
          };

        const result = await stackDriver.execute('{ hello }');

        expect(result.errors?.[0]?.message).toBe('boom with a stack');
        const stackTrace = result.errors?.[0]?.extensions?.stackTrace;
        expect(Array.isArray(stackTrace)).toBe(true);
        expect((stackTrace as string[])[0]).toContain('boom with a stack');

        await stackDriver.onModuleDestroy();
      });
    });
  });

  describe('query analysis', () => {
    function makeContext(): GqlContext {
      return {
        req: new Request('http://localhost/graphql'),
        res: new Response(),
      };
    }

    beforeEach(async () => {
      // Analysis only runs when a limit is configured; the limit here is
      // deliberately generous so the executor never rejects on its own.
      driver = new LeavenDriver({ schema, maxComplexity: 1000 });
      await driver.onModuleInit();
    });

    test('should skip analysis entirely when no limit is configured', async () => {
      const unlimited = new LeavenDriver({ schema });
      await unlimited.onModuleInit();

      const context = makeContext();
      const result = await unlimited.execute('{ hello }', undefined, context);

      expect(result.data).toEqual({ hello: 'world' });
      const target = context as Record<string, unknown>;
      expect(target._queryDepth).toBeUndefined();
      expect(target._queryComplexity).toBeUndefined();

      await unlimited.onModuleDestroy();
    });

    test('should run analysis when only maxDepth is configured', async () => {
      const depthOnly = new LeavenDriver({ schema, maxDepth: 10 });
      await depthOnly.onModuleInit();

      const context = makeContext();
      await depthOnly.execute('{ hello }', undefined, context);

      const target = context as Record<string, unknown>;
      expect(target._queryDepth).toBe(1);
      expect(typeof target._queryComplexity).toBe('number');

      await depthOnly.onModuleDestroy();
    });

    test('should memoize analysis per document instead of re-parsing', async () => {
      const first = makeContext();
      await driver.execute('{ hello }', undefined, first);

      // Removing the schema breaks analysis outright: a second run that still
      // reports finite values can only have come from the memo.
      (driver as unknown as { schema: GraphQLSchema | null }).schema = null;

      const logged: unknown[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]): void => {
        logged.push(args);
      };

      const second = makeContext();
      try {
        await driver.execute('{ hello }', undefined, second);
      } finally {
        console.error = originalConsoleError;
      }

      const target = second as Record<string, unknown>;
      expect(target._queryDepth).toBe((first as Record<string, unknown>)._queryDepth);
      expect(target._queryComplexity).toBe(
        (first as Record<string, unknown>)._queryComplexity
      );
      expect(Number.isFinite(target._queryComplexity as number)).toBe(true);
      expect(logged.length).toBe(0);
    });

    test('should cap the memo by bytes and skip oversized documents', async () => {
      const internals = driver as unknown as {
        analysisCache: Map<string, unknown>;
        analysisBytes: number;
      };
      const perEntryCap = LeavenDriver.MAX_ANALYSIS_BYTES / 10;
      // A comment pads the document without adding tokens
      const oversized = `{ hello }\n#${'x'.repeat(Math.ceil(perEntryCap / 2))}`;

      await driver.execute(oversized, undefined, makeContext());
      expect(internals.analysisCache.size).toBe(0);
      expect(internals.analysisBytes).toBe(0);

      await driver.execute('{ hello }', undefined, makeContext());
      expect(internals.analysisCache.size).toBe(1);
      expect(internals.analysisBytes).toBeGreaterThan(0);

      // Fill well past the byte budget with documents just under the cap
      const nearCap = Math.floor(perEntryCap / 2) - 200;
      for (let i = 0; i < 15; i++) {
        await driver.execute(`{ hello }\n#${i}${'y'.repeat(nearCap)}`, undefined, makeContext());
      }
      expect(internals.analysisBytes).toBeLessThanOrEqual(LeavenDriver.MAX_ANALYSIS_BYTES);
      expect(internals.analysisCache.size).toBeLessThan(16);

      await driver.clearCaches();
      expect(internals.analysisBytes).toBe(0);
    });

    test('should key the memo by operation name', async () => {
      const query = 'query A { hello } query B { hello echo(message: "x") }';

      const a = makeContext();
      await driver.execute(query, undefined, a, 'A');
      const b = makeContext();
      await driver.execute(query, undefined, b, 'B');

      expect((a as Record<string, unknown>)._queryComplexity).toBe(1);
      expect((b as Record<string, unknown>)._queryComplexity).toBe(2);
    });

    test('should record depth and complexity on the context', async () => {
      const context = makeContext();

      await driver.execute('{ hello }', undefined, context);

      const target = context as Record<string, unknown>;
      expect(target._queryDepth).toBe(1);
      expect(typeof target._queryComplexity).toBe('number');
      expect(Number.isFinite(target._queryComplexity as number)).toBe(true);
    });

    test('should agree with the core depth calculation', async () => {
      const query = '{ hello ... on Query { echo(message: "x") } }';
      const context = makeContext();

      await driver.execute(query, undefined, context);

      expect((context as Record<string, unknown>)._queryDepth).toBe(
        calculateQueryDepth(parse(query))
      );
    });

    test('should leave analysis fields unset for a syntax error', async () => {
      const context = makeContext();

      await driver.execute('{ hello', undefined, context);

      const target = context as Record<string, unknown>;
      expect(target._queryDepth).toBeUndefined();
      expect(target._queryComplexity).toBeUndefined();
    });

    test('should fail closed when analysis throws', async () => {
      // A driver whose schema disappeared cannot compute complexity: the
      // limits must not silently stop being enforced.
      (driver as unknown as { schema: GraphQLSchema | null }).schema = null;

      const context = makeContext();
      const logged: unknown[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]): void => {
        logged.push(args);
      };

      try {
        await driver.execute('{ hello }', undefined, context);
      } finally {
        console.error = originalConsoleError;
      }

      const target = context as Record<string, unknown>;
      expect(target._queryDepth).toBe(Number.POSITIVE_INFINITY);
      expect(target._queryComplexity).toBe(Number.POSITIVE_INFINITY);
      expect(logged.length).toBe(1);
    });
  });

  describe('introspection enforcement', () => {
    const INTROSPECTION_QUERY = '{ __schema { types { name } } }';

    test('should reject introspection queries when introspection is disabled', async () => {
      driver = new LeavenDriver({ schema, introspection: false });
      await driver.onModuleInit();

      const result = await driver.execute(INTROSPECTION_QUERY);

      expect(result.data).toBeUndefined();
      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.errors?.[0]?.message).toContain('introspection');
    });

    test('should allow introspection queries when introspection is enabled', async () => {
      driver = new LeavenDriver({ schema, introspection: true });
      await driver.onModuleInit();

      const result = await driver.execute(INTROSPECTION_QUERY);

      expect(result.errors).toBeUndefined();
      expect(result.data?.__schema).toBeDefined();
    });

    test('should disable introspection by default in production', async () => {
      await withNodeEnv('production', async () => {
        driver = new LeavenDriver({ schema });
        await driver.onModuleInit();

        const result = await driver.execute(INTROSPECTION_QUERY);

        expect(result.errors?.length).toBeGreaterThan(0);
        expect(result.data).toBeUndefined();
      });
    });
  });

  describe('depth enforcement', () => {
    function buildNestedSchema(): GraphQLSchema {
      const child: GraphQLObjectType = new GraphQLObjectType({
        name: 'Child',
        fields: () => ({
          leaf: { type: GraphQLString, resolve: () => 'leaf' },
        }),
      });
      const parent = new GraphQLObjectType({
        name: 'Parent',
        fields: { child: { type: child, resolve: () => ({}) } },
      });
      return new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: { parent: { type: parent, resolve: () => ({}) } },
        }),
      });
    }

    test('should reject a query deeper than maxDepth', async () => {
      driver = new LeavenDriver({ schema: buildNestedSchema(), maxDepth: 2 });
      await driver.onModuleInit();

      const result = await driver.execute('{ parent { child { leaf } } }');

      expect(result.data).toBeUndefined();
      expect(result.errors?.[0]?.message).toContain(
        'Query depth of 3 exceeds maximum allowed depth of 2'
      );
    });

    test('should allow a query within maxDepth', async () => {
      driver = new LeavenDriver({ schema: buildNestedSchema(), maxDepth: 5 });
      await driver.onModuleInit();

      const result = await driver.execute('{ parent { child { leaf } } }');

      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ parent: { child: { leaf: 'leaf' } } });
    });
  });

  describe('parseOptions', () => {
    test('should reject documents over the default 10000-token budget', async () => {
      driver = new LeavenDriver({ schema });
      await driver.onModuleInit();

      const result = await driver.execute(`{ ${'hello '.repeat(10_001)} }`);
      expect(result.data).toBeUndefined();
      expect(result.errors?.[0]?.message).toMatch(/tokens/i);
    });

    test('should apply a configured maxTokens', async () => {
      driver = new LeavenDriver({ schema, parseOptions: { maxTokens: 3 } });
      await driver.onModuleInit();

      const result = await driver.execute('{ hello hello hello }');
      expect(result.errors?.[0]?.message).toMatch(/tokens/i);
      expect(driver.getParseOptions().maxTokens).toBe(3);
    });

    test('should default maxTokens to 10000', () => {
      expect(new LeavenDriver({ schema }).getParseOptions().maxTokens).toBe(10_000);
    });

    test('should allow opting out with maxTokens: Infinity', async () => {
      driver = new LeavenDriver({ schema, parseOptions: { maxTokens: Infinity } });
      await driver.onModuleInit();

      expect(driver.getParseOptions().maxTokens).toBe(Infinity);
      const result = await driver.execute('{ hello hello hello }');
      expect(result.errors).toBeUndefined();
    });
  });

  describe('subscribe', () => {
    beforeEach(async () => {
      driver = new LeavenDriver({ schema });
      await driver.onModuleInit();
    });

    test('should resolve with errors for a syntactically invalid document', async () => {
      const result = await driver.subscribe('subscription { unclosed');

      expect(Symbol.asyncIterator in result).toBe(false);
      const errors = (result as { errors?: readonly { message: string }[] }).errors;
      expect(errors?.length).toBe(1);
      expect(errors?.[0]?.message).toContain('Syntax Error');
    });

    test('should resolve with errors for a document that fails validation', async () => {
      const result = await driver.subscribe('subscription { nope }');

      expect(Symbol.asyncIterator in result).toBe(false);
      expect(
        (result as { errors?: readonly unknown[] }).errors?.length
      ).toBeGreaterThan(0);
    });

    test('should mask unexpected errors in production, as execute does', async () => {
      await withNodeEnv('production', async () => {
        const executor = driver.getExecutor();
        (executor as unknown as { subscribe: () => Promise<never> }).subscribe =
          async () => {
            throw new Error('redis password hunter2');
          };

        const result = await driver.subscribe('subscription { ticks }');

        const errors = (result as {
          errors?: readonly { message: string; extensions?: Record<string, unknown> }[];
        }).errors;
        expect(errors?.length).toBe(1);
        expect(errors?.[0]?.message).toBe('An unexpected error occurred');
        expect(errors?.[0]?.message).not.toContain('hunter2');
        expect(errors?.[0]?.extensions?.code).toBe('INTERNAL_ERROR');
      });
    });

    describe('formatted stream forwarding in production', () => {
      interface SourceSpy {
        returnCalls: unknown[];
        throwCalls: unknown[];
      }

      /**
       * Subscribe under production (so the stream is always wrapped) to a
       * hand-built source iterator, optionally without a `throw` method.
       */
      async function subscribeTo(withThrow: boolean): Promise<{
        stream: AsyncIterableIterator<unknown>;
        spy: SourceSpy;
      }> {
        const spy: SourceSpy = { returnCalls: [], throwCalls: [] };
        const source: AsyncIterableIterator<unknown> = {
          [Symbol.asyncIterator]() {
            return this;
          },
          next: async () => ({ value: { data: { x: 1 } }, done: false }),
          return: async (value?: unknown) => {
            spy.returnCalls.push(value);
            return { value: undefined, done: true };
          },
          ...(withThrow
            ? {
                throw: async (error?: unknown) => {
                  spy.throwCalls.push(error);
                  return { value: undefined, done: true };
                },
              }
            : {}),
        };
        (driver.getExecutor() as unknown as { subscribe: () => Promise<unknown> }).subscribe =
          async () => source;
        const stream = (await driver.subscribe('subscription { x }')) as AsyncIterableIterator<unknown>;
        expect(stream).not.toBe(source);
        return { stream, spy };
      }

      test('should forward return() to the source exactly once', async () => {
        await withNodeEnv('production', async () => {
          const { stream, spy } = await subscribeTo(true);
          const step = await stream.return?.('bye');
          expect(step).toEqual({ value: undefined, done: true });
          expect(spy.returnCalls).toEqual(['bye']);
          expect(spy.throwCalls).toEqual([]);
        });
      });

      test('should forward throw() to the source exactly once', async () => {
        await withNodeEnv('production', async () => {
          const { stream, spy } = await subscribeTo(true);
          const boom = new Error('boom');
          const step = await stream.throw?.(boom);
          expect(step).toEqual({ value: undefined, done: true });
          expect(spy.throwCalls).toEqual([boom]);
          expect(spy.returnCalls).toEqual([]);
        });
      });

      test('should rethrow from throw() when the source has no throw method', async () => {
        await withNodeEnv('production', async () => {
          const { stream, spy } = await subscribeTo(false);
          const boom = new Error('boom');
          await expect(stream.throw?.(boom)).rejects.toBe(boom);
          expect(spy.returnCalls).toEqual([]);
        });
      });
    });

    test('should still reject when the executor is not initialized', async () => {
      const emptyDriver = new LeavenDriver({});
      await emptyDriver.onModuleInit();

      await expect(emptyDriver.subscribe('subscription { ticks }')).rejects.toThrow(
        'Executor not initialized'
      );
    });
  });

  describe('configuration', () => {
    test('should return default path', () => {
      driver = new LeavenDriver({});
      expect(driver.getPath()).toBe('/graphql');
    });

    test('should return custom path', () => {
      driver = new LeavenDriver({ path: '/api/graphql' });
      expect(driver.getPath()).toBe('/api/graphql');
    });

    test('should enable playground in development by default', async () => {
      await withNodeEnv('development', async () => {
        driver = new LeavenDriver({});
        expect(driver.isPlaygroundEnabled()).toBe(true);
      });
    });

    test('should disable playground in production by default', async () => {
      await withNodeEnv('production', async () => {
        driver = new LeavenDriver({});
        expect(driver.isPlaygroundEnabled()).toBe(false);
      });
    });

    test('should respect explicit playground setting', () => {
      driver = new LeavenDriver({ playground: true });
      expect(driver.isPlaygroundEnabled()).toBe(true);

      driver = new LeavenDriver({ playground: false });
      expect(driver.isPlaygroundEnabled()).toBe(false);
    });

    test('should enable introspection in development by default', async () => {
      await withNodeEnv('development', async () => {
        driver = new LeavenDriver({});
        expect(driver.isIntrospectionEnabled()).toBe(true);
      });
    });

    test('should disable introspection in production by default', async () => {
      await withNodeEnv('production', async () => {
        driver = new LeavenDriver({});
        expect(driver.isIntrospectionEnabled()).toBe(false);
      });
    });
  });

  describe('cache operations', () => {
    beforeEach(async () => {
      const options: LeavenModuleOptions = {
        schema,
        cache: { maxSize: 100 },
      };
      driver = new LeavenDriver(options);
      await driver.onModuleInit();
    });

    test('should return cache stats', async () => {
      // Execute a query to populate cache
      await driver.execute('{ hello }');

      // `getCacheStats` returns a promise (a remote cache answers
      // asynchronously); asserting on the unresolved promise would pass for
      // any implementation at all.
      const stats = await driver.getCacheStats();

      expect(stats?.document?.size).toBeGreaterThan(0);
      expect(stats?.compiled.maxSize).toBeGreaterThan(0);
    });

    test('should clear caches', async () => {
      // Execute a query to populate cache
      await driver.execute('{ hello }');
      expect((await driver.getCacheStats())?.document?.size).toBeGreaterThan(0);

      await driver.clearCaches();

      expect((await driver.getCacheStats())?.document?.size).toBe(0);
      expect(driver.getExecutor()).not.toBeNull();
    });

    test('should await the executor clear on module destroy', async () => {
      await driver.execute('{ hello }');

      const executor = driver.getExecutor();
      let cleared = false;
      const originalClear = executor!.clearCaches.bind(executor);
      (executor as unknown as { clearCaches: () => Promise<void> }).clearCaches =
        async () => {
          await originalClear();
          cleared = true;
        };

      await driver.onModuleDestroy();

      expect(cleared).toBe(true);
      expect(driver.getExecutor()).toBeNull();
    });

    test('should propagate a rejecting cache clear instead of floating it', async () => {
      const executor = driver.getExecutor();
      (executor as unknown as { clearCaches: () => Promise<void> }).clearCaches =
        async () => {
          throw new Error('redis unavailable');
        };

      await expect(driver.clearCaches()).rejects.toThrow('redis unavailable');

      // Restore so the suite's afterEach teardown does not rethrow
      (executor as unknown as { clearCaches: () => Promise<void> }).clearCaches =
        async () => {};
    });

    test('should return null stats when executor not initialized', () => {
      const emptyDriver = new LeavenDriver({});
      expect(emptyDriver.getCacheStats()).toBeNull();
    });
  });

  describe('cleanup', () => {
    test('should clean up on module destroy', async () => {
      const options: LeavenModuleOptions = { schema };
      driver = new LeavenDriver(options);
      await driver.onModuleInit();

      expect(driver.getExecutor()).not.toBeNull();

      await driver.onModuleDestroy();

      // Executor should be cleared
      expect(driver.getExecutor()).toBeNull();
    });
  });

  describe('handleRequest', () => {
    beforeEach(async () => {
      const options: LeavenModuleOptions = { schema };
      driver = new LeavenDriver(options);
      await driver.onModuleInit();
    });

    test('should handle JSON POST request', async () => {
      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ hello }' }),
      });
      const response = new Response();

      const result = await driver.handleRequest(request, response);

      expect(result.data).toEqual({ hello: 'world' });
    });

    test('should handle application/graphql POST request', async () => {
      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/graphql' },
        body: '{ hello }',
      });
      const response = new Response();

      const result = await driver.handleRequest(request, response);

      expect(result.data).toEqual({ hello: 'world' });
    });


    test('should reject an empty application/graphql body with a ValidationError', async () => {
      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/graphql' },
      });
      const response = new Response();

      let caught: unknown;
      try {
        await driver.handleRequest(request, response);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).statusCode).toBe(400);
      expect((caught as ValidationError).code).toBe('VALIDATION_ERROR');
    });

    test.each([
      ['a missing query', JSON.stringify({ variables: {} }), 'Query is required'],
      ['a non-string query', JSON.stringify({ query: 42 }), 'Query is required'],
      ['an empty query', JSON.stringify({ query: '' }), 'Query is required'],
      ['a JSON null body', 'null', 'Request body must be a JSON object'],
      ['a JSON array body', '[]', 'Request body must be a JSON object'],
      ['malformed JSON', '{ not json', 'Invalid JSON body'],
      [
        'a string variables',
        JSON.stringify({ query: '{ a }', variables: '{"a":1}' }),
        '"variables" must be a JSON object',
      ],
      [
        'an array variables',
        JSON.stringify({ query: '{ a }', variables: [1] }),
        '"variables" must be a JSON object',
      ],
      [
        'a non-string operationName',
        JSON.stringify({ query: '{ a }', operationName: 5 }),
        '"operationName" must be a string',
      ],
    ])('should reject a JSON POST with %s as a ValidationError', async (_label, body, message) => {
      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      let caught: unknown;
      try {
        await driver.handleRequest(request, new Response());
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).message).toBe(message);
      expect((caught as ValidationError).statusCode).toBe(400);
    });

    test.each([
      ['text/plain'],
      ['text/plain; x=application/json'],
      ['text/plain;application/json'],
      ['text/plain; x=application/graphql'],
      [`text/\u001b[2Jplain${'x'.repeat(1000)}`],
      [''],
    ])('should reject POST with unsupported content type %p as a 415', async (contentType) => {
      // `x-graphql-csrf` gets the request past CSRF prevention to the
      // Content-Type dispatch.
      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: contentType
          ? { 'Content-Type': contentType, 'x-graphql-csrf': '1' }
          : { 'x-graphql-csrf': '1' },
        body: '{"query":"{ hello }"}',
      });

      let caught: unknown;
      try {
        await driver.handleRequest(request, new Response());
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(LeavenError);
      expect((caught as LeavenError).message).toBe(
        'Unsupported Content-Type: expected application/json or application/graphql'
      );
      expect((caught as LeavenError).code).toBe(ErrorCode.BAD_REQUEST);
      expect((caught as LeavenError).statusCode).toBe(415);
    });

    describe('csrfPrevention', () => {
      const formRequest = (headers: Record<string, string> = {}): Request =>
        new Request('http://localhost/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
          body: 'query=%7B%20hello%20%7D',
        });

      test.each([
        ['application/x-www-form-urlencoded'],
        ['multipart/form-data; boundary=x'],
        ['text/plain'],
        [''],
      ])('should reject a %p POST without a preflight header as a 400 before the context factory', async (contentType) => {
        let contextCalls = 0;
        const guarded = new LeavenDriver({
          schema,
          context: () => {
            contextCalls += 1;
            return {};
          },
        });
        await guarded.onModuleInit();
        const request = new Request('http://localhost/graphql', {
          method: 'POST',
          headers: contentType ? { 'Content-Type': contentType } : {},
          body: '{"query":"{ hello }"}',
        });

        const caught = await guarded.handleRequest(request, new Response()).catch((e: unknown) => e);

        expect(caught).toBeInstanceOf(LeavenError);
        expect((caught as LeavenError).message).toStartWith(
          'This request is blocked by CSRF prevention: '
        );
        expect((caught as LeavenError).code).toBe(ErrorCode.BAD_REQUEST);
        expect((caught as LeavenError).statusCode).toBe(400);
        expect(contextCalls).toBe(0);
      });

      test('should normalise an HttpException thrown by the context factory', async () => {
        const guarded = new LeavenDriver({
          schema,
          context: () => {
            throw new UnauthorizedException('No session');
          },
        });
        await guarded.onModuleInit();
        const request = new Request('http://localhost/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-graphql-csrf': '1' },
          body: '{"query":"{ hello }"}',
        });

        const caught = await guarded.handleRequest(request, new Response()).catch((e: unknown) => e);

        expect(caught).toBeInstanceOf(LeavenError);
        expect((caught as LeavenError).code).toBe(ErrorCode.UNAUTHENTICATED);
        expect((caught as LeavenError).statusCode).toBe(401);
      });

      test('should pass a form POST carrying x-graphql-csrf on to the Content-Type check', async () => {
        const caught = await driver
          .handleRequest(formRequest({ 'x-graphql-csrf': '1' }), new Response())
          .catch((e: unknown) => e);

        expect((caught as LeavenError).statusCode).toBe(415);
      });

      test('should not apply to GET', async () => {
        const result = await driver.handleRequest(
          new Request('http://localhost/graphql?query=%7B%20hello%20%7D'),
          new Response()
        );

        expect(result.data).toEqual({ hello: 'world' });
      });

      test('should be skipped when csrfPrevention is false', async () => {
        const open = new LeavenDriver({ schema, csrfPrevention: false });
        await open.onModuleInit();

        const caught = await open.handleRequest(formRequest(), new Response()).catch((e: unknown) => e);

        expect((caught as LeavenError).statusCode).toBe(415);
      });

      test('should throw a TypeError at construction for an invalid header name', () => {
        expect(
          () => new LeavenDriver({ schema, csrfPrevention: { requestHeaders: ['a:b'] } })
        ).toThrow(TypeError);
      });
    });

    test.each([
      ['application/json; charset=utf-8', '{"query":"{ hello }"}'],
      ['Application/JSON', '{"query":"{ hello }"}'],
      ['application/graphql; charset=utf-8', '{ hello }'],
    ])('should still accept content type %p', async (contentType, body) => {
      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      });
      const result = await driver.handleRequest(request, new Response());
      expect(result.data).toEqual({ hello: 'world' });
    });

    test('should reject malformed variables with a ValidationError', async () => {
      const query = 'query Echo($msg: String) { echo(message: $msg) }';
      const request = new Request(
        `http://localhost/graphql?query=${encodeURIComponent(query)}&variables=${encodeURIComponent('{not-json')}`
      );
      const response = new Response();

      let caught: unknown;
      try {
        await driver.handleRequest(request, response);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).message).toContain('malformed JSON');
      expect((caught as ValidationError).code).toBe('VALIDATION_ERROR');
    });

    test('should handle GET request with query params', async () => {
      const request = new Request(
        'http://localhost/graphql?query=' + encodeURIComponent('{ hello }')
      );
      const response = new Response();

      const result = await driver.handleRequest(request, response);

      expect(result.data).toEqual({ hello: 'world' });
    });

    test('should handle GET request with variables', async () => {
      const query = 'query Echo($msg: String) { echo(message: $msg) }';
      const variables = JSON.stringify({ msg: 'test' });
      const request = new Request(
        `http://localhost/graphql?query=${encodeURIComponent(query)}&variables=${encodeURIComponent(variables)}`
      );
      const response = new Response();

      const result = await driver.handleRequest(request, response);

      expect(result.data).toEqual({ echo: 'test' });
    });

    test.each([['[1]'], ['5'], ['"x"']])(
      'should reject GET variables that are not a JSON object (%s)',
      async (variables) => {
        const request = new Request(
          `http://localhost/graphql?query=${encodeURIComponent('{ hello }')}&variables=${encodeURIComponent(variables)}`
        );

        let caught: unknown;
        try {
          await driver.handleRequest(request, new Response());
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(ValidationError);
        expect((caught as ValidationError).message).toBe('"variables" must be a JSON object');
        expect((caught as ValidationError).statusCode).toBe(400);
      }
    );

    describe('mutations over GET', () => {
      let mutationDriver: LeavenDriver;
      let mutationRuns: number;
      let contextCalls: number;

      beforeEach(async () => {
        mutationRuns = 0;
        contextCalls = 0;
        const mutationSchema = new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query',
            fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
          }),
          mutation: new GraphQLObjectType({
            name: 'Mutation',
            fields: {
              bump: {
                type: GraphQLString,
                resolve: () => {
                  mutationRuns++;
                  return 'bumped';
                },
              },
            },
          }),
        });
        mutationDriver = new LeavenDriver({
          schema: mutationSchema,
          context: () => {
            contextCalls++;
            return {};
          },
        });
        await mutationDriver.onModuleInit();
      });

      afterEach(async () => {
        await mutationDriver.onModuleDestroy();
      });

      const get = (query: string, operationName?: string): Request =>
        new Request(
          `http://localhost/graphql?query=${encodeURIComponent(query)}` +
            (operationName ? `&operationName=${encodeURIComponent(operationName)}` : '')
        );

      test('should reject a GET mutation with a 405 BAD_REQUEST before running it or the context factory', async () => {
        let caught: unknown;
        try {
          await mutationDriver.handleRequest(get('mutation { bump }'), new Response());
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(LeavenError);
        expect((caught as LeavenError).statusCode).toBe(405);
        expect((caught as LeavenError).code).toBe(ErrorCode.BAD_REQUEST);
        expect((caught as LeavenError).extensions.allow).toBe('POST');
        expect(mutationRuns).toBe(0);
        expect(contextCalls).toBe(0);
      });

      test('should select the operation by operationName when deciding', async () => {
        const doc = 'query Q { hello } mutation M { bump }';

        const result = await mutationDriver.handleRequest(get(doc, 'Q'), new Response());
        expect(result.data).toEqual({ hello: 'world' });

        await expect(
          mutationDriver.handleRequest(get(doc, 'M'), new Response())
        ).rejects.toMatchObject({ statusCode: 405 });
        expect(mutationRuns).toBe(0);
      });

      test('should run a POST mutation', async () => {
        const request = new Request('http://localhost/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'mutation { bump }' }),
        });

        const result = await mutationDriver.handleRequest(request, new Response());
        expect(result.data).toEqual({ bump: 'bumped' });
      });

      test('should leave an unparseable GET query to execution', async () => {
        const result = await mutationDriver.handleRequest(get('mutation {'), new Response());
        expect(result.errors?.length).toBeGreaterThan(0);
        expect(mutationRuns).toBe(0);
      });

      test.each(['HEAD', 'PUT', 'DELETE', 'PATCH'])(
        'should reject a %s request with a 405 before running a mutation or the context factory',
        async (method) => {
          const request = new Request(
            `http://localhost/graphql?query=${encodeURIComponent('mutation { bump }')}`,
            { method }
          );

          let caught: unknown;
          try {
            await mutationDriver.handleRequest(request, new Response());
          } catch (error) {
            caught = error;
          }

          expect(caught).toBeInstanceOf(LeavenError);
          expect((caught as LeavenError).statusCode).toBe(405);
          expect((caught as LeavenError).code).toBe(ErrorCode.BAD_REQUEST);
          expect((caught as LeavenError).extensions.allow).toBe('GET, POST');
          expect(mutationRuns).toBe(0);
          expect(contextCalls).toBe(0);
        }
      );

      test('should still run a GET query', async () => {
        const result = await mutationDriver.handleRequest(get('{ hello }'), new Response());
        expect(result.data).toEqual({ hello: 'world' });
      });
    });

    describe('maxBodySize', () => {
      const post = (
        body: BodyInit,
        contentType = 'application/json',
        headers: Record<string, string> = {}
      ): Request =>
        new Request('http://localhost/graphql', {
          method: 'POST',
          headers: { 'Content-Type': contentType, ...headers },
          body,
        });

      async function rejection(request: Request, target: LeavenDriver = driver): Promise<unknown> {
        try {
          await target.handleRequest(request, new Response());
        } catch (error) {
          return error;
        }
        return undefined;
      }

      function expectTooLarge(caught: unknown): void {
        expect(caught).toBeInstanceOf(LeavenError);
        expect((caught as LeavenError).code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
        expect((caught as LeavenError).statusCode).toBe(413);
      }

      test('should default to 1_000_000 bytes', async () => {
        const padding = ' '.repeat(1_000_001);
        expectTooLarge(await rejection(post(`{"query":"{ hello }"}${padding}`)));

        const fits = post(JSON.stringify({ query: '{ hello }' }));
        expect((await driver.handleRequest(fits, new Response())).data).toEqual({
          hello: 'world',
        });
      });

      test('should reject an oversized Content-Length without reading the body', async () => {
        const small = new LeavenDriver({ schema, maxBodySize: 10 });
        await small.onModuleInit();
        const request = post('{"query":"{ hello }"}', 'application/json', {
          'Content-Length': '11',
        });

        expectTooLarge(await rejection(request, small));
        expect(request.bodyUsed).toBe(false);
        await small.onModuleDestroy();
      });

      test('should enforce the limit while reading when Content-Length is absent or lying', async () => {
        const small = new LeavenDriver({ schema, maxBodySize: 10 });
        await small.onModuleInit();
        const chunks = ['{"query":', '"{ hello }"}'];
        const stream = (): ReadableStream<Uint8Array> =>
          new ReadableStream<Uint8Array>({
            pull(controller): void {
              const next = chunks.length ? chunks.shift() : undefined;
              if (next === undefined) {
                controller.close();
              } else {
                controller.enqueue(new TextEncoder().encode(next));
              }
            },
          });

        expectTooLarge(await rejection(post(stream()), small));
        chunks.push('{"query":', '"{ hello }"}');
        expectTooLarge(
          await rejection(post(stream(), 'application/json', { 'Content-Length': '5' }), small)
        );
        await small.onModuleDestroy();
      });

      test('should apply to application/graphql bodies', async () => {
        const small = new LeavenDriver({ schema, maxBodySize: 5 });
        await small.onModuleInit();
        expectTooLarge(await rejection(post('{ hello }', 'application/graphql'), small));
        await small.onModuleDestroy();
      });

      test('should reject a body whose read fails with a coded BAD_REQUEST', async () => {
        const reset = new Error('socket reset');
        const stream = new ReadableStream<Uint8Array>({
          pull(controller): void {
            controller.error(reset);
          },
        });

        const caught = await rejection(post(stream));

        expect(caught).toBeInstanceOf(LeavenError);
        expect((caught as LeavenError).code).toBe(ErrorCode.BAD_REQUEST);
        expect((caught as LeavenError).statusCode).toBe(400);
        expect((caught as LeavenError).message).toBe('Failed to read request body');
        expect((caught as LeavenError).originalError).toBe(reset);
      });

      test('should reject a body not read within bodyReadTimeoutMs', async () => {
        const slow = new LeavenDriver({ schema, bodyReadTimeoutMs: 20 });
        await slow.onModuleInit();
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => {}),
          cancel(): void {
            cancelled = true;
          },
        });

        const started = Date.now();
        const caught = await rejection(post(stream), slow);

        expect(Date.now() - started).toBeLessThan(2_000);
        expect(caught).toBeInstanceOf(LeavenError);
        expect((caught as LeavenError).code).toBe(ErrorCode.BAD_REQUEST);
        expect((caught as LeavenError).statusCode).toBe(400);
        expect((caught as LeavenError).message).toBe(
          'Timed out reading request body after 20ms'
        );
        expect(cancelled).toBe(true);
        await slow.onModuleDestroy();
      });

      test('should accept a body at exactly the limit', async () => {
        const body = JSON.stringify({ query: '{ hello }' });
        const exact = new LeavenDriver({ schema, maxBodySize: new TextEncoder().encode(body).length });
        await exact.onModuleInit();
        const result = await exact.handleRequest(post(body), new Response());
        expect(result.data).toEqual({ hello: 'world' });
        await exact.onModuleDestroy();
      });
    });

    test('should treat GET variables=null as no variables', async () => {
      const request = new Request(
        `http://localhost/graphql?query=${encodeURIComponent('{ hello }')}&variables=null`
      );

      const result = await driver.handleRequest(request, new Response());

      expect(result.data).toEqual({ hello: 'world' });
    });

    test('should throw a 400 ValidationError for a missing query', async () => {
      const request = new Request('http://localhost/graphql');
      const response = new Response();

      let caught: unknown;
      try {
        await driver.handleRequest(request, response);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).message).toContain('Query is required');
      expect((caught as ValidationError).statusCode).toBe(400);
    });

    test('should use custom context factory', async () => {
      const contextDriver = new LeavenDriver({
        schema: new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query',
            fields: {
              user: {
                type: GraphQLString,
                resolve: (_, __, ctx) => ctx.userId,
              },
            },
          }),
        }),
        context: async () => ({ userId: 'user-123' }),
      });
      await contextDriver.onModuleInit();

      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ user }' }),
      });
      const response = new Response();

      const result = await contextDriver.handleRequest(request, response);

      expect(result.data).toEqual({ user: 'user-123' });
      await contextDriver.onModuleDestroy();
    });
  });
});
