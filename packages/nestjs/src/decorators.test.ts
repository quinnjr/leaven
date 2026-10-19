/**
 * @leaven-graphql/nestjs - Decorators tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import {
  COMPLEXITY_KEY,
  DEPRECATED_KEY,
  DESCRIPTION_KEY,
  CACHE_KEY,
  SUBSCRIPTION_FILTER_KEY,
  Complexity,
  Deprecated,
  Description,
  CacheHint,
  SubscriptionFilter,
  Decorators,
  createContextDecorator,
  Context,
  Info,
  Root,
  Parent,
  Args,
  contextExtractor,
  infoExtractor,
  rootExtractor,
  argsExtractor,
  filterAsyncIterator,
} from './decorators';

function createMockExecutionContext(overrides: {
  root?: unknown;
  args?: unknown;
  context?: unknown;
  info?: unknown;
} = {}): ExecutionContext {
  // `in`-checks (not destructuring defaults) so an explicit `args: undefined`
  // is passed through rather than replaced by the default value.
  const root = 'root' in overrides ? overrides.root : { id: 'root1' };
  const args = 'args' in overrides ? overrides.args : { id: '123', name: 'test' };
  const context =
    'context' in overrides
      ? overrides.context
      : { user: { id: 'user1' }, db: { connected: true }, req: {}, res: {} };
  const info = 'info' in overrides ? overrides.info : { fieldName: 'testField' };

  return {
    getArgs: () => [root, args, context, info],
    getArgByIndex: (index: number) => [root, args, context, info][index],
    getHandler: () => function testMethod() {},
    getClass: () => class TestClass {},
    getType: () => 'graphql',
    switchToHttp: () => ({} as any),
    switchToRpc: () => ({} as any),
    switchToWs: () => ({} as any),
  } as unknown as ExecutionContext;
}

describe('Param decorators', () => {
  describe('Context', () => {
    test('should be a param decorator factory', () => {
      expect(typeof Context).toBe('function');
      expect(typeof Context()).toBe('function');
    });

    test('should return the full GraphQL context when no key is given', () => {
      const ctx = createMockExecutionContext({
        context: { user: { id: 'user1' }, req: {}, res: {} },
      });

      const result = contextExtractor(undefined, ctx) as Record<string, unknown>;

      expect(result.user).toEqual({ id: 'user1' });
    });

    test('should return a single context property for the keyed form', () => {
      const ctx = createMockExecutionContext({
        context: { db: { connected: true }, req: {}, res: {} },
      });

      expect(contextExtractor('db', ctx)).toEqual({ connected: true });
    });

    test('should return undefined for a missing context key', () => {
      const ctx = createMockExecutionContext({
        context: { req: {}, res: {} },
      });

      expect(contextExtractor('missing', ctx)).toBeUndefined();
    });
  });

  describe('Info', () => {
    test('should be a param decorator factory', () => {
      expect(typeof Info).toBe('function');
      expect(typeof Info()).toBe('function');
    });

    test('should return the GraphQL resolve info (4th resolver argument)', () => {
      const info = { fieldName: 'users' };
      const ctx = createMockExecutionContext({ info });

      expect(infoExtractor(undefined, ctx)).toBe(info);
    });
  });

  describe('Root / Parent', () => {
    test('should be param decorator factories', () => {
      expect(typeof Root).toBe('function');
      expect(typeof Root()).toBe('function');
    });

    test('should alias Parent to Root', () => {
      expect(Parent).toBe(Root);
    });

    test('should return the root value (1st resolver argument)', () => {
      const root = { id: '42', firstName: 'Ada' };
      const ctx = createMockExecutionContext({ root });

      expect(rootExtractor(undefined, ctx)).toBe(root);
    });
  });

  describe('Args', () => {
    test('should be a param decorator factory', () => {
      expect(typeof Args).toBe('function');
      expect(typeof Args()).toBe('function');
    });

    test('should return all resolver arguments when no key is given', () => {
      const args = { id: '123', filter: { active: true } };
      const ctx = createMockExecutionContext({ args });

      expect(argsExtractor(undefined, ctx)).toBe(args);
    });

    test('should return a single argument for the keyed form', () => {
      const ctx = createMockExecutionContext({ args: { id: '123', name: 'test' } });

      expect(argsExtractor('id', ctx)).toBe('123');
    });

    test('should return undefined for a missing argument key', () => {
      const ctx = createMockExecutionContext({ args: {} });

      expect(argsExtractor('missing', ctx)).toBeUndefined();
    });

    test('should tolerate undefined resolver arguments', () => {
      const ctx = createMockExecutionContext({ args: undefined });

      expect(argsExtractor(undefined, ctx)).toBeUndefined();
      expect(argsExtractor('id', ctx)).toBeUndefined();
    });
  });
});

describe('Decorators', () => {
  describe('Complexity', () => {
    test('should set complexity metadata with number', () => {
      class TestClass {
        @Complexity(10)
        testMethod() {}
      }

      const metadata = Reflect.getMetadata(COMPLEXITY_KEY, TestClass.prototype.testMethod);
      expect(metadata).toBe(10);
    });

    test('should set complexity metadata with function', () => {
      const estimator = ({ childComplexity }: { childComplexity: number }) =>
        childComplexity * 2;

      class TestClass {
        @Complexity(estimator)
        testMethod() {}
      }

      const metadata = Reflect.getMetadata(COMPLEXITY_KEY, TestClass.prototype.testMethod);
      expect(metadata).toBe(estimator);
      expect(metadata({ childComplexity: 5 })).toBe(10);
    });
  });

  describe('Deprecated', () => {
    test('should set deprecated metadata', () => {
      class TestClass {
        @Deprecated('Use newMethod instead')
        testMethod() {}
      }

      const metadata = Reflect.getMetadata(DEPRECATED_KEY, TestClass.prototype.testMethod);
      expect(metadata).toBe('Use newMethod instead');
    });
  });

  describe('Description', () => {
    test('should set description metadata', () => {
      class TestClass {
        @Description('This is a test method')
        testMethod() {}
      }

      const metadata = Reflect.getMetadata(DESCRIPTION_KEY, TestClass.prototype.testMethod);
      expect(metadata).toBe('This is a test method');
    });
  });

  describe('CacheHint', () => {
    test('should set cache hint with maxAge', () => {
      class TestClass {
        @CacheHint({ maxAge: 3600 })
        testMethod() {}
      }

      const metadata = Reflect.getMetadata(CACHE_KEY, TestClass.prototype.testMethod);
      expect(metadata).toEqual({ maxAge: 3600 });
    });

    test('should set cache hint with scope', () => {
      class TestClass {
        @CacheHint({ maxAge: 60, scope: 'PUBLIC' })
        testMethod() {}
      }

      const metadata = Reflect.getMetadata(CACHE_KEY, TestClass.prototype.testMethod);
      expect(metadata).toEqual({ maxAge: 60, scope: 'PUBLIC' });
    });
  });

  describe('SubscriptionFilter', () => {
    test('should set subscription filter metadata', () => {
      const filterFn = (payload: { id: number }, variables: { id: number }) =>
        payload.id === variables.id;

      class TestClass {
        @SubscriptionFilter(filterFn)
        testSubscription() {}
      }

      const metadata = Reflect.getMetadata(SUBSCRIPTION_FILTER_KEY, TestClass.prototype.testSubscription);
      expect(metadata).toBe(filterFn);
    });

    test('should drop events the filter rejects', async () => {
      class TestClass {
        @SubscriptionFilter((payload: unknown, variables: unknown) => {
          return (
            (payload as { postId: number }).postId === (variables as { postId: number }).postId
          );
        })
        public commentAdded(): AsyncGenerator<{ postId: number; body: string }> {
          return (async function* () {
            yield { postId: 1, body: 'first' };
            yield { postId: 2, body: 'other post' };
            yield { postId: 1, body: 'second' };
          })();
        }
      }

      // The wrapper must return the iterable synchronously, so a direct
      // caller can `for await` the method's return value.
      const iterator = new TestClass().commentAdded(undefined, { postId: 1 });
      expect(typeof (iterator as AsyncGenerator<unknown>)[Symbol.asyncIterator]).toBe(
        'function'
      );

      const received: string[] = [];
      for await (const event of iterator) {
        received.push(event.body);
      }

      expect(received).toEqual(['first', 'second']);
    });

    test('should filter a promise-returning source and preserve the promise', async () => {
      class TestClass {
        @SubscriptionFilter(
          (payload: unknown, variables: unknown) =>
            (payload as { postId: number }).postId ===
            (variables as { postId: number }).postId
        )
        public async commentAdded(): Promise<
          AsyncGenerator<{ postId: number; body: string }>
        > {
          await Promise.resolve();
          return (async function* () {
            yield { postId: 1, body: 'first' };
            yield { postId: 2, body: 'other post' };
            yield { postId: 1, body: 'second' };
          })();
        }
      }

      const pending = new TestClass().commentAdded(undefined, { postId: 1 });
      expect(pending).toBeInstanceOf(Promise);

      const received: string[] = [];
      for await (const event of await pending) {
        received.push(event.body);
      }

      expect(received).toEqual(['first', 'second']);
    });

    test('should drop only the offending event when the filter throws', async () => {
      const originalConsoleError = console.error;
      const logged: unknown[] = [];
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };

      try {
        class TestClass {
          @SubscriptionFilter((payload: unknown) => {
            if ((payload as { id: number }).id === 2) {
              throw new Error('filter exploded');
            }
            return true;
          })
          public events(): AsyncGenerator<{ id: number }> {
            return (async function* () {
              yield { id: 1 };
              yield { id: 2 };
              yield { id: 3 };
            })();
          }
        }

        const ids: number[] = [];
        for await (const event of new TestClass().events(undefined, {})) {
          ids.push(event.id);
        }

        expect(ids).toEqual([1, 3]);
        expect(logged).toHaveLength(1);
      } finally {
        console.error = originalConsoleError;
      }
    });

    test('should not close the source a second time on normal completion', async () => {
      let returnCalls = 0;

      class TestClass {
        @SubscriptionFilter(() => true)
        public events(): AsyncIterable<{ n: number }> {
          const inner = (async function* () {
            yield { n: 1 };
          })();

          return {
            [Symbol.asyncIterator]: () => ({
              next: () => inner.next(),
              return: (value?: unknown) => {
                returnCalls += 1;
                return inner.return(value as { n: number });
              },
            }),
          } as AsyncIterable<{ n: number }>;
        }
      }

      const seen: number[] = [];
      for await (const event of new TestClass().events(undefined, {})) {
        seen.push(event.n);
      }

      expect(seen).toEqual([1]);
      // The source exhausted itself; `for await` must not call return() again.
      expect(returnCalls).toBe(0);
    });

    test('should propagate the source error rather than a cleanup error', async () => {
      class TestClass {
        @SubscriptionFilter(() => true)
        public events(): AsyncIterable<{ n: number }> {
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(new Error('AuthorizationError: token expired')),
              return: () => Promise.reject(new Error('cleanup exploded')),
            }),
          } as AsyncIterable<{ n: number }>;
        }
      }

      const iterator = new TestClass().events(undefined, {});

      await expect(
        (async () => {
          for await (const _event of iterator) {
            // consume
          }
        })()
      ).rejects.toThrow('AuthorizationError: token expired');
    });

    test('should propagate cancellation through the filter to the source', async () => {
      let cleanedUp = false;

      class TestClass {
        @SubscriptionFilter(() => true)
        public ticks(): AsyncGenerator<{ n: number }> {
          return (async function* () {
            try {
              let n = 0;
              while (true) {
                yield { n: n++ };
              }
            } finally {
              cleanedUp = true;
            }
          })();
        }
      }

      const iterator = new TestClass().ticks(undefined, {});
      await iterator.next();
      await iterator.return?.(undefined);

      expect(cleanedUp).toBe(true);
    });

    test('should forward return() to an idle source immediately', async () => {
      // A pub/sub-style source parked between events: `next()` settles only
      // once the source itself is returned.
      let returnCalls = 0;
      let release: ((step: IteratorResult<{ n: number }>) => void) | undefined;
      const source: AsyncIterableIterator<{ n: number }> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () =>
          new Promise<IteratorResult<{ n: number }>>((resolve) => {
            release = resolve;
          }),
        return: async () => {
          returnCalls += 1;
          release?.({ value: undefined, done: true });
          return { value: undefined, done: true };
        },
      };

      class TestClass {
        @SubscriptionFilter(() => true)
        public events(): AsyncIterableIterator<{ n: number }> {
          return source;
        }
      }

      const iterator = new TestClass().events(undefined, {});
      const pending = iterator.next();
      // Let the filter reach the source's pending next().
      await Promise.resolve();

      await iterator.return?.(undefined);

      expect(returnCalls).toBe(1);
      expect(await pending).toEqual({ value: undefined, done: true });

      // Already cancelled: neither next() nor a second return() touches the source.
      expect(await iterator.next()).toEqual({ value: undefined, done: true });
      await iterator.return?.(undefined);
      expect(returnCalls).toBe(1);
    });

    test('should await asynchronous filters', async () => {
      class TestClass {
        @SubscriptionFilter(async (payload: unknown) => {
          await Promise.resolve();
          return (payload as { keep: boolean }).keep;
        })
        public events(): AsyncGenerator<{ keep: boolean; id: number }> {
          return (async function* () {
            yield { keep: false, id: 1 };
            yield { keep: true, id: 2 };
          })();
        }
      }

      const iterator = new TestClass().events(undefined, {});

      const ids: number[] = [];
      for await (const event of iterator) {
        ids.push(event.id);
      }

      expect(ids).toEqual([2]);
    });

    test('should execute filter function correctly', () => {
      const filterFn = (payload: { id: number }, variables: { id: number }) =>
        payload.id === variables.id;

      class TestClass {
        @SubscriptionFilter(filterFn)
        testSubscription() {}
      }

      const metadata = Reflect.getMetadata(SUBSCRIPTION_FILTER_KEY, TestClass.prototype.testSubscription);
      expect(metadata({ id: 1 }, { id: 1 })).toBe(true);
      expect(metadata({ id: 1 }, { id: 2 })).toBe(false);
    });
  });

  describe('createContextDecorator', () => {
    test('should create a decorator factory', () => {
      const CurrentUser = createContextDecorator<{ id: string }>('user');
      expect(typeof CurrentUser).toBe('function');
    });

    test('should return a parameter decorator', () => {
      const CurrentUser = createContextDecorator<{ id: string }>('user');
      const decorator = CurrentUser();
      expect(typeof decorator).toBe('function');
    });
  });

  describe('Decorators', () => {
    test('should compose multiple decorators', () => {
      class TestClass {
        @Decorators(Complexity(10), Description('A test method'))
        testMethod() {}
      }

      const complexityMeta = Reflect.getMetadata(COMPLEXITY_KEY, TestClass.prototype.testMethod);
      const descMeta = Reflect.getMetadata(DESCRIPTION_KEY, TestClass.prototype.testMethod);

      expect(complexityMeta).toBe(10);
      expect(descMeta).toBe('A test method');
    });
  });

  describe('metadata keys', () => {
    test('should have correct complexity key', () => {
      expect(COMPLEXITY_KEY).toBe('leaven:complexity');
    });

    test('should have correct deprecated key', () => {
      expect(DEPRECATED_KEY).toBe('leaven:deprecated');
    });

    test('should have correct description key', () => {
      expect(DESCRIPTION_KEY).toBe('leaven:description');
    });

    test('should have correct cache key', () => {
      expect(CACHE_KEY).toBe('leaven:cache');
    });

    test('should have correct subscription filter key', () => {
      expect(SUBSCRIPTION_FILTER_KEY).toBe('leaven:subscription:filter');
    });
  });
});

describe('filterAsyncIterator', () => {
  /** A hand-rolled source that counts calls to its optional methods. */
  function createSource(
    values: number[],
    methods: { throw?: boolean; return?: boolean } = {}
  ): { iterable: AsyncIterable<number>; calls: { throw: number; return: number } } {
    const calls = { throw: 0, return: 0 };
    let index = 0;
    const iterator: AsyncIterator<number> = {
      next: async (): Promise<IteratorResult<number>> =>
        index < values.length
          ? { value: values[index++] as number, done: false }
          : { value: undefined, done: true },
    };
    if (methods.throw) {
      iterator.throw = async (): Promise<IteratorResult<number>> => {
        calls.throw++;
        return { value: undefined, done: true };
      };
    }
    if (methods.return) {
      iterator.return = async (): Promise<IteratorResult<number>> => {
        calls.return++;
        return { value: undefined, done: true };
      };
    }
    return { iterable: { [Symbol.asyncIterator]: () => iterator }, calls };
  }

  test('should finish when the source next() rejects, without closing or pulling it again', async () => {
    let returns = 0;
    let nexts = 0;
    const failure = new Error('source failed');
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<number>> => {
          nexts++;
          throw failure;
        },
        return: async (): Promise<IteratorResult<number>> => {
          returns++;
          return { value: undefined, done: true };
        },
      }),
    };
    const filtered = filterAsyncIterator(iterable, () => true);

    await expect(filtered.next()).rejects.toBe(failure);
    await filtered.return!();
    expect(returns).toBe(0);
    expect(await filtered.next()).toEqual({ value: undefined, done: true });
    expect(nexts).toBe(1);
  });

  test('should forward throw() to a source that has throw exactly once and resolve done', async () => {
    const { iterable, calls } = createSource([1, 2], { throw: true, return: true });
    const filtered = filterAsyncIterator(iterable, () => true);

    await expect(filtered.throw!(new Error('cancel'))).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(calls.throw).toBe(1);
    expect(calls.return).toBe(0);
    // Finished: no further events.
    expect(await filtered.next()).toEqual({ value: undefined, done: true });
  });

  test('should close a source that catches the thrown error and yields instead of finishing', async () => {
    let finallyRan = false;
    async function* source(): AsyncGenerator<number> {
      try {
        yield 1;
      } catch {
        yield 2;
      } finally {
        finallyRan = true;
      }
    }
    const filtered = filterAsyncIterator(source(), () => true);
    expect(await filtered.next()).toEqual({ value: 1, done: false });

    await expect(filtered.throw!(new Error('cancel'))).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(finallyRan).toBe(true);
    expect(await filtered.next()).toEqual({ value: undefined, done: true });
  });

  test('should call return() once and reject with the error when throw() hits a source without throw', async () => {
    const { iterable, calls } = createSource([1, 2], { return: true });
    const filtered = filterAsyncIterator(iterable, () => true);
    const error = new Error('cancel');

    await expect(filtered.throw!(error)).rejects.toBe(error);
    expect(calls.return).toBe(1);
  });

  test('should rethrow without touching the source when throw() is called after the iterator is done', async () => {
    const { iterable, calls } = createSource([], { throw: true, return: true });
    const filtered = filterAsyncIterator(iterable, () => true);
    expect(await filtered.next()).toEqual({ value: undefined, done: true });

    const error = new Error('late');
    await expect(filtered.throw!(error)).rejects.toBe(error);
    expect(calls.throw).toBe(0);
    expect(calls.return).toBe(0);
  });

  test('should not call source.return when return() follows natural source completion', async () => {
    const { iterable, calls } = createSource([1, 2, 3], { return: true });
    const filtered = filterAsyncIterator(iterable, (n) => n % 2 === 1);

    const seen: number[] = [];
    for (let step = await filtered.next(); !step.done; step = await filtered.next()) {
      seen.push(step.value);
    }
    expect(seen).toEqual([1, 3]);

    expect(await filtered.return!()).toEqual({ value: undefined, done: true });
    expect(calls.return).toBe(0);
  });
});
