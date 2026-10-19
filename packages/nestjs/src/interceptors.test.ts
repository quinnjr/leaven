/**
 * @leaven-graphql/nestjs - Interceptors tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { of, throwError } from 'rxjs';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { GraphQLError, Source } from 'graphql';
import { withNodeEnv } from './test-utils/env';
import { ValidationError } from '@leaven-graphql/errors';
import { InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import {
  LoggingInterceptor,
  ErrorFormattingInterceptor,
  ComplexityInterceptor,
  CachingInterceptor,
  MetricsInterceptor,
} from './interceptors';

function createMockContext(): ExecutionContext {
  return {
    getHandler: () => ({ name: 'testMethod' }),
    getClass: () => ({ name: 'TestClass' }),
    getArgs: () => [{}, {}, {}, {}],
    getType: () => 'graphql',
    switchToHttp: () => ({} as any),
    switchToRpc: () => ({} as any),
    switchToWs: () => ({} as any),
    getArgByIndex: () => ({} as any),
  } as unknown as ExecutionContext;
}

function createMockCallHandler(returnValue: unknown = 'success'): CallHandler {
  return {
    handle: () => of(returnValue),
  };
}

function createErrorCallHandler(error: Error): CallHandler {
  return {
    handle: () => throwError(() => error),
  };
}

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let consoleLogSpy: ReturnType<typeof mock>;
  let consoleErrorSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    consoleLogSpy = mock(() => {});
    consoleErrorSpy = mock(() => {});
    console.log = consoleLogSpy;
    console.error = consoleErrorSpy;
  });

  test('should log successful execution', async () => {
    const context = createMockContext();
    const handler = createMockCallHandler();

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        next: (value) => {
          expect(value).toBe('success');
        },
        complete: () => {
          expect(consoleLogSpy).toHaveBeenCalled();
          resolve();
        },
      });
    });
  });

  test('should include timing in log', async () => {
    const context = createMockContext();
    const handler = createMockCallHandler();

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        complete: () => {
          const logCall = consoleLogSpy.mock.calls[0][0];
          expect(logCall).toContain('[GraphQL]');
          expect(logCall).toContain('TestClass.testMethod');
          expect(logCall).toContain('ms');
          resolve();
        },
      });
    });
  });

  test('should log failures with timing and error, then rethrow', async () => {
    const context = createMockContext();
    const error = new Error('resolver blew up');
    const handler = createErrorCallHandler(error);

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        error: (err) => {
          expect(err).toBe(error);
          expect(consoleErrorSpy).toHaveBeenCalled();
          expect(consoleLogSpy).not.toHaveBeenCalled();
          const [message, loggedError] = consoleErrorSpy.mock.calls[0];
          expect(message).toContain('[GraphQL]');
          expect(message).toContain('TestClass.testMethod');
          expect(message).toContain('ms');
          expect(loggedError).toBe(error);
          resolve();
        },
      });
    });
  });
});

describe('ErrorFormattingInterceptor', () => {
  let interceptor: ErrorFormattingInterceptor;

  beforeEach(() => {
    interceptor = new ErrorFormattingInterceptor();
  });

  test('should pass through successful results', async () => {
    const context = createMockContext();
    const handler = createMockCallHandler({ data: 'test' });

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        next: (value) => {
          expect(value).toEqual({ data: 'test' });
          resolve();
        },
      });
    });
  });

  test('should format unexpected errors with a code and stack trace in development', async () => {
    const context = createMockContext();
    const error = new Error('Test error');
    const handler = createErrorCallHandler(error);

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        error: (err) => {
          expect(err).toBeInstanceOf(GraphQLError);
          expect(err).not.toBe(error);
          expect(err.message).toBe('Test error');
          expect(err.extensions?.code).toBe('INTERNAL_ERROR');
          expect(err.extensions?.stackTrace).toBeDefined();
          resolve();
        },
      });
    });
  });

  test('should map an HttpException to its code and keep its message in production', async () => {
    await withNodeEnv('production', async () => {
      const result$ = interceptor.intercept(
        createMockContext(),
        createErrorCallHandler(new UnauthorizedException('Token expired'))
      );
      const err = await new Promise<GraphQLError>((resolve) => {
        result$.subscribe({ error: (e) => resolve(e) });
      });
      expect(err.extensions?.code).toBe('UNAUTHENTICATED');
      expect(err.message).toBe('Token expired');
    });
  });

  test('should still mask a 5xx HttpException in production', async () => {
    await withNodeEnv('production', async () => {
      const result$ = interceptor.intercept(
        createMockContext(),
        createErrorCallHandler(new InternalServerErrorException('db password leaked'))
      );
      const err = await new Promise<GraphQLError>((resolve) => {
        result$.subscribe({ error: (e) => resolve(e) });
      });
      expect(err.message).not.toContain('db password leaked');
      expect(err.extensions?.code).toBe('INTERNAL_ERROR');
    });
  });

  test('should preserve the source locations of the caught error', async () => {
    const context = createMockContext();
    // `locations` is derived from source + positions, so a formatter that
    // rebuilds the error from message/path/extensions alone silently loses
    // the position a client would otherwise get from the driver.
    const error = new GraphQLError('Cannot query field "nope"', {
      source: new Source('{ nope }'),
      positions: [2],
      extensions: { code: 'VALIDATION_ERROR' },
    });
    const handler = createErrorCallHandler(error);

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        error: (err) => {
          expect(err).toBeInstanceOf(GraphQLError);
          expect(err).not.toBe(error);
          expect(err.locations).toEqual([{ line: 1, column: 3 }]);
          resolve();
        },
      });
    });
  });

  test('should keep code and message for Leaven errors, even in production', async () => {
    await withNodeEnv('production', async () => {
      const context = createMockContext();
      const error = new ValidationError('Invalid email address');
      const handler = createErrorCallHandler(error);

      const result$ = interceptor.intercept(context, handler);

      await new Promise<void>((resolve) => {
        result$.subscribe({
          error: (err) => {
            expect(err).toBeInstanceOf(GraphQLError);
            expect(err.message).toBe('Invalid email address');
            expect(err.extensions?.code).toBe('VALIDATION_ERROR');
            resolve();
          },
        });
      });
    });
  });

  test('should mask unexpected errors in production without mutating the original', async () => {
    await withNodeEnv('production', async () => {
      const context = createMockContext();
      const error = new Error('connection refused: db password hunter2');
      const originalStack = error.stack;
      const handler = createErrorCallHandler(error);

      const result$ = interceptor.intercept(context, handler);

      await new Promise<void>((resolve) => {
        result$.subscribe({
          error: (err) => {
            expect(err).toBeInstanceOf(GraphQLError);
            expect(err).not.toBe(error);
            expect(err.message).toBe('An unexpected error occurred');
            expect(err.extensions?.code).toBe('INTERNAL_ERROR');
            expect(err.extensions?.stackTrace).toBeUndefined();
            // The caught error must not be mutated
            expect(error.message).toBe('connection refused: db password hunter2');
            expect(error.stack).toBe(originalStack);
            resolve();
          },
        });
      });
    });
  });

  test('should keep the locations but not the message of a masked error', async () => {
    await withNodeEnv('production', async () => {
      const context = createMockContext();
      const error = new GraphQLError('table "users_pii" is missing', {
        source: new Source('{ nope }'),
        positions: [2],
      });
      const handler = createErrorCallHandler(error);

      const result$ = interceptor.intercept(context, handler);

      await new Promise<void>((resolve) => {
        result$.subscribe({
          error: (err) => {
            expect(err.message).toBe('An unexpected error occurred');
            expect(err.locations).toEqual([{ line: 1, column: 3 }]);
            expect(JSON.stringify(err)).not.toContain('users_pii');
            resolve();
          },
        });
      });
    });
  });

  test('should handle non-Error objects', async () => {
    const context = createMockContext();
    const handler = {
      handle: () => throwError(() => 'string error'),
    };

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        error: (err) => {
          expect(err).toBeInstanceOf(GraphQLError);
          expect(err.message).toBe('string error');
          expect(err.extensions?.code).toBe('INTERNAL_ERROR');
          resolve();
        },
      });
    });
  });
});

describe('ComplexityInterceptor', () => {
  let interceptor: ComplexityInterceptor;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    interceptor = new ComplexityInterceptor(reflector);
  });

  test('should store resolved field complexity in context', async () => {
    reflector.get = () => 10;

    const gqlContext: Record<string, unknown> = {};
    const context = {
      ...createMockContext(),
      getArgs: () => [{}, {}, gqlContext, {}],
    } as ExecutionContext;

    const handler = createMockCallHandler();

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        complete: () => {
          expect(gqlContext._resolvedFieldComplexity).toBe(10);
          resolve();
        },
      });
    });
  });

  test('should call a complexity estimator with the field info and args and add its number', async () => {
    const received: unknown[] = [];
    const estimator = (options: {
      field: unknown;
      args: Record<string, unknown>;
      childComplexity: number;
    }): number => {
      received.push(options);
      return (options.args.limit as number) * 2;
    };
    reflector.get = (() => estimator) as unknown as Reflector['get'];

    const info = { fieldName: 'users' };
    const gqlContext: Record<string, unknown> = { _resolvedFieldComplexity: 3 };
    const context = {
      ...createMockContext(),
      getArgs: () => [{}, { limit: 5 }, gqlContext, info],
    } as ExecutionContext;

    const result$ = interceptor.intercept(context, createMockCallHandler());

    await new Promise<void>((resolve) => {
      result$.subscribe({
        complete: () => {
          expect(received).toEqual([{ field: info, args: { limit: 5 }, childComplexity: 0 }]);
          expect(gqlContext._resolvedFieldComplexity).toBe(13);
          resolve();
        },
      });
    });
  });

  test('should not fail the field when a complexity estimator throws', async () => {
    reflector.get = (() => () => {
      throw new Error('estimator exploded');
    }) as unknown as Reflector['get'];
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    const gqlContext: Record<string, unknown> = { _resolvedFieldComplexity: 4 };
    const context = {
      ...createMockContext(),
      getArgs: () => [{}, {}, gqlContext, {}],
    } as ExecutionContext;

    const values: unknown[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        interceptor.intercept(context, createMockCallHandler('field-value')).subscribe({
          next: (value) => values.push(value),
          error: reject,
          complete: resolve,
        });
      });
    } finally {
      console.error = originalError;
    }

    expect(values).toEqual(['field-value']);
    expect(gqlContext._resolvedFieldComplexity).toBe(4);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test.each([[Number.NaN], [Number.POSITIVE_INFINITY], ['7']])(
    'should ignore a non-finite or non-number estimator result (%p)',
    async (estimate) => {
      reflector.get = (() => () => estimate) as unknown as Reflector['get'];

      const gqlContext: Record<string, unknown> = { _resolvedFieldComplexity: 4 };
      const context = {
        ...createMockContext(),
        getArgs: () => [{}, {}, gqlContext, {}],
      } as ExecutionContext;

      await new Promise<void>((resolve) => {
        interceptor.intercept(context, createMockCallHandler()).subscribe({
          complete: resolve,
        });
      });

      expect(gqlContext._resolvedFieldComplexity).toBe(4);
    }
  );

  test('should sum complexity across multiple fields instead of overwriting', async () => {
    const complexities = [10, 5];
    let call = 0;
    reflector.get = () => complexities[call++];

    const gqlContext: Record<string, unknown> = {};
    const context = {
      ...createMockContext(),
      getArgs: () => [{}, {}, gqlContext, {}],
    } as ExecutionContext;

    for (let i = 0; i < complexities.length; i++) {
      await new Promise<void>((resolve) => {
        interceptor.intercept(context, createMockCallHandler()).subscribe({
          complete: resolve,
        });
      });
    }

    expect(gqlContext._resolvedFieldComplexity).toBe(15);
  });

  test('should never overwrite the driver complexity the guard enforces', async () => {
    reflector.get = () => 10;

    // Simulates the driver having already populated _queryComplexity, the key
    // ComplexityGuard compares. The interceptor's observational tally must
    // stay on its own key.
    const gqlContext: Record<string, unknown> = { _queryComplexity: 7 };
    const context = {
      ...createMockContext(),
      getArgs: () => [{}, {}, gqlContext, {}],
    } as ExecutionContext;

    const handler = createMockCallHandler();

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        complete: () => {
          expect(gqlContext._queryComplexity).toBe(7);
          expect(gqlContext._resolvedFieldComplexity).toBe(10);
          resolve();
        },
      });
    });
  });

  test('should not set complexity if not defined', async () => {
    reflector.get = () => undefined;

    const gqlContext: Record<string, unknown> = {};
    const context = {
      ...createMockContext(),
      getArgs: () => [{}, {}, gqlContext, {}],
    } as ExecutionContext;

    const handler = createMockCallHandler();

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        complete: () => {
          expect(gqlContext._resolvedFieldComplexity).toBeUndefined();
          expect(gqlContext._queryComplexity).toBeUndefined();
          resolve();
        },
      });
    });
  });
});

describe('CachingInterceptor', () => {
  let interceptor: CachingInterceptor;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    interceptor = new CachingInterceptor(reflector);
  });

  test('should pass through when no cache hint', async () => {
    reflector.get = () => undefined;

    const context = createMockContext();
    const handler = createMockCallHandler({ data: 'test' });

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        next: (value) => {
          expect(value).toEqual({ data: 'test' });
          resolve();
        },
      });
    });
  });

  test('should apply the hint only under an Apollo-style info.cacheControl', async () => {
    // `info.cacheControl` is an Apollo Server construct. Nothing in Leaven's
    // execution path attaches it, so this exercises a compatibility shim, not
    // a supported Leaven configuration — see the interceptor's @deprecated tag.
    reflector.get = () => ({ maxAge: 3600, scope: 'PUBLIC' });

    const cacheControl = {
      setCacheHint: mock(() => {}),
    };
    const context = {
      ...createMockContext(),
      getArgs: () => [{}, {}, {}, { cacheControl }],
    } as ExecutionContext;

    const handler = createMockCallHandler();

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        complete: () => {
          expect(cacheControl.setCacheHint).toHaveBeenCalledWith({
            maxAge: 3600,
            scope: 'PUBLIC',
          });
          resolve();
        },
      });
    });
  });

  test('should be a no-op for the info Leaven actually supplies', async () => {
    // The GraphQLResolveInfo Leaven passes carries no `cacheControl`, so a
    // decorated resolver observes nothing at all: the hint is dropped and the
    // value passes straight through.
    reflector.get = () => ({ maxAge: 3600, scope: 'PUBLIC' });

    const info: Record<string, unknown> = { fieldName: 'settings' };
    const context = {
      ...createMockContext(),
      getArgs: () => [{}, {}, {}, info],
    } as ExecutionContext;

    const result$ = interceptor.intercept(context, createMockCallHandler({ data: 'x' }));

    const seen: unknown[] = [];
    await new Promise<void>((resolve) => {
      result$.subscribe({
        next: (value) => seen.push(value),
        complete: resolve,
      });
    });

    expect(seen).toEqual([{ data: 'x' }]);
    expect(Object.keys(info)).toEqual(['fieldName']);
  });
});

describe('MetricsInterceptor', () => {
  let interceptor: MetricsInterceptor;

  beforeEach(() => {
    interceptor = new MetricsInterceptor();
  });

  test('should record successful operations', async () => {
    const context = createMockContext();
    const handler = createMockCallHandler();

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        complete: () => {
          const metrics = interceptor.getMetrics();
          const key = 'TestClass.testMethod';

          expect(metrics.has(key)).toBe(true);
          expect(metrics.get(key)?.successCount).toBe(1);
          expect(metrics.get(key)?.errorCount).toBe(0);
          resolve();
        },
      });
    });
  });

  test('should record error operations', async () => {
    const context = createMockContext();
    const handler = createErrorCallHandler(new Error('Test error'));

    const result$ = interceptor.intercept(context, handler);

    await new Promise<void>((resolve) => {
      result$.subscribe({
        error: () => {
          const metrics = interceptor.getMetrics();
          const key = 'TestClass.testMethod';

          expect(metrics.has(key)).toBe(true);
          expect(metrics.get(key)?.errorCount).toBe(1);
          resolve();
        },
      });
    });
  });

  test('should aggregate multiple operations', async () => {
    const context = createMockContext();
    const handler = createMockCallHandler();

    // Execute multiple times
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => {
        interceptor.intercept(context, handler).subscribe({
          complete: resolve,
        });
      });
    }

    const metrics = interceptor.getMetrics();
    const key = 'TestClass.testMethod';

    expect(metrics.get(key)?.totalCount).toBe(5);
    expect(metrics.get(key)?.successCount).toBe(5);
  });

  test('should return summary with calculated fields', async () => {
    const context = createMockContext();
    const handler = createMockCallHandler();

    await new Promise<void>((resolve) => {
      interceptor.intercept(context, handler).subscribe({
        complete: resolve,
      });
    });

    const summary = interceptor.getSummary();

    expect(summary.length).toBe(1);
    expect(summary[0].operation).toBe('TestClass.testMethod');
    expect(summary[0].averageDuration).toBeGreaterThanOrEqual(0);
    expect(summary[0].errorRate).toBe(0);
  });

  test('should reset metrics', async () => {
    const context = createMockContext();
    const handler = createMockCallHandler();

    await new Promise<void>((resolve) => {
      interceptor.intercept(context, handler).subscribe({
        complete: resolve,
      });
    });

    expect(interceptor.getMetrics().size).toBe(1);

    interceptor.reset();

    expect(interceptor.getMetrics().size).toBe(0);
  });

  test('should calculate min and max durations', async () => {
    const context = createMockContext();

    // Execute with varying delays
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => {
        interceptor.intercept(context, createMockCallHandler()).subscribe({
          complete: resolve,
        });
      });
    }

    const metrics = interceptor.getMetrics();
    const key = 'TestClass.testMethod';

    expect(metrics.get(key)?.minDuration).toBeGreaterThanOrEqual(0);
    expect(metrics.get(key)?.maxDuration).toBeGreaterThanOrEqual(0);
  });

  test('should maintain sane extrema for error-only sequences', async () => {
    const context = createMockContext();

    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => {
        interceptor.intercept(context, createErrorCallHandler(new Error('fail'))).subscribe({
          error: () => resolve(),
        });
      });
    }

    const metrics = interceptor.getMetrics().get('TestClass.testMethod');

    expect(metrics?.errorCount).toBe(3);
    expect(metrics?.successCount).toBe(0);
    expect(Number.isFinite(metrics?.minDuration ?? Infinity)).toBe(true);
    expect(metrics?.minDuration).toBeGreaterThanOrEqual(0);
    expect(metrics?.maxDuration).toBeGreaterThanOrEqual(metrics?.minDuration ?? 0);
  });
});
