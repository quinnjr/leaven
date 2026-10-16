/**
 * @leaven-graphql/nestjs - Driver tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { GraphQLSchema, GraphQLObjectType, GraphQLString, parse } from 'graphql';
import { calculateQueryDepth } from '@leaven-graphql/core';
import { AuthenticationError, ValidationError } from '@leaven-graphql/errors';
import { LeavenDriver } from './driver';
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
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
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
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test('should keep the real message for unexpected errors in development', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      try {
        const executor = driver.getExecutor();
        (executor as unknown as { execute: () => Promise<never> }).execute =
          async () => {
            throw new Error('connection refused on port 5432');
          };

        const result = await driver.execute('{ hello }');

        expect(result.errors?.length).toBe(1);
        expect(result.errors?.[0]?.message).toBe('connection refused on port 5432');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test('should include a stack trace when includeStacktraceInErrorResponses is set', async () => {
      const originalEnv = process.env.NODE_ENV;
      // Production would normally mask; the stack-trace flag must win, since
      // a masked error carries no stack to include.
      process.env.NODE_ENV = 'production';

      try {
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
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
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
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        driver = new LeavenDriver({ schema });
        await driver.onModuleInit();

        const result = await driver.execute(INTROSPECTION_QUERY);

        expect(result.errors?.length).toBeGreaterThan(0);
        expect(result.data).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
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
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
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
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
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

    test('should enable playground in development by default', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      driver = new LeavenDriver({});
      expect(driver.isPlaygroundEnabled()).toBe(true);

      process.env.NODE_ENV = originalEnv;
    });

    test('should disable playground in production by default', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      driver = new LeavenDriver({});
      expect(driver.isPlaygroundEnabled()).toBe(false);

      process.env.NODE_ENV = originalEnv;
    });

    test('should respect explicit playground setting', () => {
      driver = new LeavenDriver({ playground: true });
      expect(driver.isPlaygroundEnabled()).toBe(true);

      driver = new LeavenDriver({ playground: false });
      expect(driver.isPlaygroundEnabled()).toBe(false);
    });

    test('should enable introspection in development by default', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      driver = new LeavenDriver({});
      expect(driver.isIntrospectionEnabled()).toBe(true);

      process.env.NODE_ENV = originalEnv;
    });

    test('should disable introspection in production by default', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      driver = new LeavenDriver({});
      expect(driver.isIntrospectionEnabled()).toBe(false);

      process.env.NODE_ENV = originalEnv;
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
    test('should cleanup on module destroy', async () => {
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

    test('should escape and cap a hostile content type echoed in the error', async () => {
      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'Content-Type': `text/\u001b[2Jplain${'x'.repeat(1000)}` },
        body: '{ hello }',
      });

      let caught: unknown;
      try {
        await driver.handleRequest(request, new Response());
      } catch (error) {
        caught = error;
      }

      const message = (caught as ValidationError).message;
      expect(message).toContain('text/\\x1b[2Jplain');
      expect(message).not.toMatch(/[\u0000-\u001f]/);
      expect(message.length).toBeLessThan(400);
    });

    test('should reject POST requests with an unsupported content type', async () => {
      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{ hello }',
      });
      const response = new Response();

      let caught: unknown;
      try {
        await driver.handleRequest(request, response);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).message).toContain('Unsupported content type');
      expect((caught as ValidationError).statusCode).toBe(400);
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
