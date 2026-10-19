/**
 * @leaven-graphql/nestjs - Decorators
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import { GQL_RESOLVER_ARGS, getGqlContext } from './execution-context';

/**
 * Metadata key for resolver complexity
 */
export const COMPLEXITY_KEY = 'leaven:complexity';

/**
 * Metadata key for field deprecation
 */
export const DEPRECATED_KEY = 'leaven:deprecated';

/**
 * Metadata key for field description
 */
export const DESCRIPTION_KEY = 'leaven:description';

/**
 * Metadata key for caching
 */
export const CACHE_KEY = 'leaven:cache';

/**
 * Metadata key for subscription filter
 */
export const SUBSCRIPTION_FILTER_KEY = 'leaven:subscription:filter';

/**
 * Extractor backing the {@link Context} decorator.
 *
 * @internal Exported for testing only.
 */
export function contextExtractor(data: string | undefined, ctx: ExecutionContext): unknown {
  const gqlContext = getGqlContext(ctx);

  if (data) {
    return gqlContext[data];
  }

  return gqlContext;
}

/**
 * Inject the GraphQL context
 *
 * @example
 * ```typescript
 * @Query(() => User)
 * async me(@Context() ctx: GqlContext) {
 *   return ctx.req.user;
 * }
 * ```
 */
export const Context = createParamDecorator(contextExtractor);

/**
 * Extractor backing the {@link Info} decorator.
 *
 * @internal Exported for testing only.
 */
export function infoExtractor(_data: unknown, ctx: ExecutionContext): unknown {
  return ctx.getArgs()[GQL_RESOLVER_ARGS.INFO];
}

/**
 * Inject the GraphQL info object
 *
 * @example
 * ```typescript
 * @Query(() => [Post])
 * async posts(@Info() info: GraphQLResolveInfo) {
 *   // Access field selection, etc.
 * }
 * ```
 */
export const Info = createParamDecorator(infoExtractor);

/**
 * Extractor backing the {@link Root} decorator.
 *
 * @internal Exported for testing only.
 */
export function rootExtractor(_data: unknown, ctx: ExecutionContext): unknown {
  return ctx.getArgs()[GQL_RESOLVER_ARGS.ROOT];
}

/**
 * Inject the root/parent value
 *
 * @example
 * ```typescript
 * @ResolveField(() => String)
 * async fullName(@Root() user: User) {
 *   return `${user.firstName} ${user.lastName}`;
 * }
 * ```
 */
export const Root = createParamDecorator(rootExtractor);

/**
 * Alias for Root decorator
 */
export const Parent = Root;

/**
 * Extractor backing the {@link Args} decorator.
 *
 * @internal Exported for testing only.
 */
export function argsExtractor(data: string | undefined, ctx: ExecutionContext): unknown {
  const gqlArgs = ctx.getArgs()[GQL_RESOLVER_ARGS.ARGS] as
    | Record<string, unknown>
    | undefined;

  if (data) {
    return gqlArgs?.[data];
  }

  return gqlArgs;
}

/**
 * Inject resolver arguments
 *
 * @example
 * ```typescript
 * @Query(() => User)
 * async user(@Args('id') id: string) {
 *   return this.userService.findById(id);
 * }
 * ```
 */
export const Args = createParamDecorator(argsExtractor);

/**
 * Set complexity for a resolver
 *
 * @example
 * ```typescript
 * @Query(() => [Post])
 * @Complexity(10)
 * async posts() {
 *   return this.postService.findAll();
 * }
 * ```
 */
export function Complexity(value: number | ComplexityEstimator): MethodDecorator {
  return SetMetadata(COMPLEXITY_KEY, value);
}

/**
 * Complexity estimator function type
 */
export type ComplexityEstimator = (options: ComplexityEstimatorArgs) => number;

/**
 * Arguments for complexity estimator
 */
export interface ComplexityEstimatorArgs {
  field: unknown;
  args: Record<string, unknown>;
  childComplexity: number;
}

/**
 * Mark a field as deprecated
 *
 * @remarks
 * Records the reason under {@link DEPRECATED_KEY}. `SchemaBuilderService`
 * reads it off the resolver functions passed via the `resolvers` option and
 * sets the matching field's `deprecationReason`, so the field is marked
 * `@deprecated` in the emitted schema. A pre-built `schema` is used as
 * given, so annotate its fields there instead.
 *
 * @example
 * ```typescript
 * @Query(() => String)
 * @Deprecated('Use newField instead')
 * async oldField() {
 *   return 'deprecated';
 * }
 * ```
 */
export function Deprecated(reason: string): MethodDecorator {
  return SetMetadata(DEPRECATED_KEY, reason);
}

/**
 * Add description to a field
 *
 * @remarks
 * Records the text under {@link DESCRIPTION_KEY}. `SchemaBuilderService`
 * reads it off the resolver functions passed via the `resolvers` option and
 * sets the matching field's description, so the text appears in the emitted
 * schema and in introspection. A pre-built `schema` is used as given, so
 * describe its fields there instead.
 *
 * @example
 * ```typescript
 * @Query(() => User)
 * @Description('Fetch the currently authenticated user')
 * async me() {
 *   return this.authService.getCurrentUser();
 * }
 * ```
 */
export function Description(text: string): MethodDecorator {
  return SetMetadata(DESCRIPTION_KEY, text);
}

/**
 * Enable caching for a resolver
 *
 * @deprecated Has no effect; removal target 0.3.0. The hint is only applied by
 * `CachingInterceptor`, which requires `info.cacheControl` — an Apollo Server
 * construct that Leaven never attaches to `GraphQLResolveInfo`. The metadata is
 * recorded under {@link CACHE_KEY} but nothing in the library reads it.
 *
 * @example
 * ```typescript
 * @Query(() => Settings)
 * @CacheHint({ maxAge: 3600 })
 * async settings() {
 *   return this.settingsService.getAll();
 * }
 * ```
 */
export function CacheHint(options: CacheHintOptions): MethodDecorator {
  return SetMetadata(CACHE_KEY, options);
}

/**
 * Cache hint options
 */
export interface CacheHintOptions {
  /**
   * Maximum age in seconds
   */
  maxAge?: number;

  /**
   * Cache scope
   */
  scope?: 'PUBLIC' | 'PRIVATE';
}

/**
 * Yield only the source events a predicate accepts.
 *
 * Hand-written rather than an `async function*` on purpose. A generator's
 * `return()` is queued behind its pending `next()`, so cancelling a filtered
 * stream while the source is idle (the normal state of a pub/sub-backed
 * subscription between events) could not reach the source until the next
 * event arrived: the subscription transport would wait out its teardown
 * deadline, abandon the iterator and leak the topic subscription. Here
 * `return()` and `throw()` are forwarded straight to the source, whatever
 * `next()` is doing, and rejected events are skipped inside `next()`.
 *
 * The source is only closed by an explicit `return()`/`throw()` from the
 * consumer: a source that completes or fails on its own is never closed a
 * second time, which would replace an in-flight error with a cleanup error
 * and, for shared engines, release a topic subscription twice.
 *
 * A predicate that throws drops the offending event and is reported to
 * `console.error` rather than tearing down the whole subscription.
 *
 * @internal Shared by {@link SubscriptionFilter}, the `filter` option of the
 * `Subscription` decorator, and `LeavenGraphQLDriver.subscriptionWithFilter`
 * (`@nestjs/graphql`'s `filter` option).
 */
export function filterAsyncIterator<T>(
  source: AsyncIterable<T>,
  predicate: (payload: T) => boolean | Promise<boolean>
): AsyncIterableIterator<T> {
  let iterator: AsyncIterator<T> | undefined;
  let done = false;

  // Acquired lazily, as `for await` would, so a non-iterable source still
  // fails on first use rather than when the resolver method is called.
  const acquire = (): AsyncIterator<T> => {
    iterator ??= source[Symbol.asyncIterator]();
    return iterator;
  };
  const finished = (): IteratorResult<T> => ({ value: undefined, done: true });

  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
      return this;
    },

    async next(): Promise<IteratorResult<T>> {
      while (!done) {
        let step: IteratorResult<T>;
        try {
          step = await acquire().next();
        } catch (error) {
          // A failed source is finished: never pull from or close it again.
          done = true;
          throw error;
        }
        // Cancelled while the source was pending: the late event is dropped.
        if (done) {
          break;
        }
        if (step.done) {
          done = true;
          return finished();
        }

        let accepted: boolean;
        try {
          accepted = await predicate(step.value);
        } catch (error) {
          console.error('Subscription filter threw; dropping event:', error);
          continue;
        }

        if (accepted && !done) {
          return { value: step.value, done: false };
        }
      }
      return finished();
    },

    async return(value?: unknown): Promise<IteratorResult<T>> {
      if (done) {
        return finished();
      }
      done = true;
      const target = acquire();
      if (target.return) {
        await target.return(value);
      }
      return finished();
    },

    async throw(error?: unknown): Promise<IteratorResult<T>> {
      if (!done) {
        done = true;
        const target = acquire();
        if (target.throw) {
          const step = await target.throw(error);
          // The source caught the error and yielded: it is still suspended,
          // and our return() is a no-op from here on, so close it now.
          if (!step.done && target.return) {
            await target.return();
          }
          return finished();
        }
        if (target.return) {
          await target.return();
        }
      }
      throw error;
    },
  };
}

/**
 * Replace a method descriptor with one that filters the async iterable the
 * original method produces.
 *
 * The wrapper is deliberately synchronous: when the original method returns
 * an async iterable directly, so does the wrapper, so a direct caller can
 * still write `for await (const x of resolver.messageAdded())`. Only when the
 * original returns a promise does the wrapper return one.
 *
 * @internal Shared by {@link SubscriptionFilter} and the `filter` option of
 * the `Subscription` decorator, so a correctness fix lands in one place.
 */
export function wrapWithFilter(
  descriptor: PropertyDescriptor,
  filter: (payload: unknown, variables: unknown, context: unknown) => boolean | Promise<boolean>
): void {
  const original = descriptor.value as unknown;

  if (typeof original !== 'function') {
    return;
  }

  descriptor.value = function (this: unknown, ...args: unknown[]): unknown {
    const source = (original as (...a: unknown[]) => unknown).apply(this, args);

    const variables = args[GQL_RESOLVER_ARGS.ARGS];
    const context = args[GQL_RESOLVER_ARGS.CONTEXT];
    const predicate = (payload: unknown): boolean | Promise<boolean> =>
      filter(payload, variables, context);

    return source instanceof Promise
      ? source.then((resolved) =>
          filterAsyncIterator(resolved as AsyncIterable<unknown>, predicate)
        )
      : filterAsyncIterator(source as AsyncIterable<unknown>, predicate);
  };
}

/**
 * Add filter to subscription
 *
 * Wraps the decorated method so the async iterator it returns yields only
 * the events the predicate accepts. The predicate receives the published
 * payload along with the resolver's arguments and context, and may be
 * asynchronous. Rejected events are dropped without reaching the client.
 *
 * The wrapper preserves the original method's return kind: an async iterable
 * stays an async iterable (so direct callers can `for await` it), and a
 * promise stays a promise.
 *
 * The predicate is also recorded under {@link SUBSCRIPTION_FILTER_KEY} so a
 * schema builder can inspect it.
 *
 * The variables and context come from the raw `(root, args, context, info)`
 * arguments the method is called with, so do not combine it with NestJS
 * parameter decorators such as `@Args`. On the code-first
 * `LeavenGraphQLDriver` path use the `filter` option of `@nestjs/graphql`'s
 * `@Subscription` instead.
 *
 * @example
 * ```typescript
 * // The payload is what was published: { commentAdded: comment }
 * @SubscriptionFilter(
 *   (payload, variables) =>
 *     (payload as { commentAdded: { postId: string } }).commentAdded.postId ===
 *     (variables as { postId: string }).postId
 * )
 * commentAdded(_root: unknown, _args: { postId: string }) {
 *   return pubSub.asyncIterator('COMMENT_ADDED');
 * }
 * ```
 */
export function SubscriptionFilter(
  filter: (payload: unknown, variables: unknown, context: unknown) => boolean | Promise<boolean>
): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    wrapWithFilter(descriptor as PropertyDescriptor, filter);

    // Applied last so the metadata lands on the wrapper that replaces the
    // original method on the prototype.
    return SetMetadata(SUBSCRIPTION_FILTER_KEY, filter)(target, propertyKey, descriptor);
  };
}

/**
 * Compose multiple decorators
 *
 * @example
 * ```typescript
 * @Query(() => [Post])
 * @PublicQuery() // combines Complexity, Description, and CacheHint
 * async publicPosts() {
 *   return this.postService.findPublic();
 * }
 *
 * function PublicQuery() {
 *   return Decorators(
 *     Complexity(5),
 *     Description('Fetch public posts'),
 *     CacheHint({ maxAge: 60, scope: 'PUBLIC' })
 *   );
 * }
 * ```
 */
export function Decorators(...decorators: MethodDecorator[]): MethodDecorator {
  return applyDecorators(...decorators);
}

/**
 * Create a custom context decorator
 *
 * The underlying param decorator is built once per created decorator, not on
 * every application, so applying the returned decorator at many call sites
 * reuses a single factory.
 *
 * @example
 * ```typescript
 * export const CurrentUser = createContextDecorator<User>('user');
 *
 * // Usage:
 * @Query(() => Profile)
 * async profile(@CurrentUser() user: User) {
 *   return this.profileService.getByUserId(user.id);
 * }
 * ```
 */
export function createContextDecorator<T>(key: string): () => ParameterDecorator {
  const decorator = createParamDecorator((_data: unknown, ctx: ExecutionContext): T => {
    const gqlContext = getGqlContext(ctx);
    return gqlContext[key] as T;
  });

  return () => decorator();
}
