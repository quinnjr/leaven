/**
 * @leaven-graphql/nestjs - Interceptors
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  Injectable,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { GraphQLError } from 'graphql';
import { errorToGraphQL, maskError } from '@leaven-graphql/errors';
import {
  COMPLEXITY_KEY,
  CACHE_KEY,
  type CacheHintOptions,
  type ComplexityEstimator,
} from './decorators';
import { normalizeHttpException } from './http-exception';
import { getGqlArgs, getGqlContext, getGqlInfo } from './execution-context';

/**
 * Logging interceptor for GraphQL operations
 *
 * Logs timing and operation information for debugging. Successful
 * resolutions are logged via `console.log`; failures are logged via
 * `console.error` with the error attached, then rethrown unchanged.
 *
 * @example
 * ```typescript
 * @UseInterceptors(LoggingInterceptor)
 * @Resolver(() => User)
 * export class UserResolver {
 *   // ...
 * }
 * ```
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const className = context.getClass().name;
    const methodName = context.getHandler().name;
    const start = performance.now();

    return next.handle().pipe(
      tap(() => {
        const duration = (performance.now() - start).toFixed(2);
        // eslint-disable-next-line no-console -- the documented output channel of this interceptor
        console.log(`[GraphQL] ${className}.${methodName} - ${duration}ms`);
      }),
      catchError((error) => {
        const duration = (performance.now() - start).toFixed(2);
        console.error(`[GraphQL] ${className}.${methodName} - ${duration}ms - failed:`, error);
        return throwError(() => error);
      })
    );
  }
}

/**
 * Error formatting interceptor
 *
 * Catches errors and formats them consistently by delegating to
 * `@leaven-graphql/errors`. Leaven errors keep their message and error
 * code; unexpected errors are masked in production (message replaced,
 * code set to `INTERNAL_ERROR`) and carry their stack trace in
 * `extensions.stackTrace` in development. The caught error is never
 * mutated — a new `GraphQLError` is thrown instead.
 *
 * @example
 * ```typescript
 * @UseInterceptors(ErrorFormattingInterceptor)
 * @Resolver(() => User)
 * export class UserResolver {
 *   // ...
 * }
 * ```
 */
@Injectable()
export class ErrorFormattingInterceptor implements NestInterceptor {
  public intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error) => {
        // Format the error
        const formattedError = this.formatError(error);
        return throwError(() => formattedError);
      })
    );
  }

  /**
   * Format an error for GraphQL response
   *
   * Returns a new `GraphQLError` built from the formatted representation
   * rather than mutating the input error.
   *
   * `GraphQLError` derives `locations` from the `nodes`, or the
   * `source`/`positions`, handed to its constructor — never from a `locations`
   * field — so those are carried over from the converted error. Without them a
   * client would lose the source position that the driver's own formatting
   * path (`formatError`) preserves. A masked error keeps only the sanitised
   * locations `maskError` returned; when it returned none, none are rebuilt
   * here.
   */
  private formatError(error: unknown): GraphQLError {
    const isProduction = process.env.NODE_ENV === 'production';
    const source = errorToGraphQL(normalizeHttpException(error));
    const formatted = maskError(source, {
      maskErrors: isProduction,
      includeStackTrace: !isProduction,
    });
    const keepLocations = formatted.locations !== undefined;

    return new GraphQLError(formatted.message, {
      nodes: keepLocations ? source.nodes : undefined,
      source: keepLocations ? source.source : undefined,
      positions: keepLocations ? source.positions : undefined,
      path: formatted.path,
      extensions: formatted.extensions,
    });
  }
}

/**
 * Complexity tracking interceptor
 *
 * Tracks query complexity for monitoring. Field complexity declared via
 * `@Complexity()` — a fixed number, or an estimator called with
 * `{ field: info, args, childComplexity: 0 }` — is accumulated onto the request context's
 * `_resolvedFieldComplexity` key, so multiple fields resolved in one request
 * sum rather than overwrite each other.
 *
 * This measurement is **observational only**. It deliberately does not touch
 * `_queryComplexity`, the key the driver assigns per request and
 * `ComplexityGuard` compares: NestJS runs guards before interceptors, so a
 * value accumulated here can never influence the guard for its own request,
 * and writing to that key would only corrupt the driver's static estimate —
 * making later fields of a query answer for work they did not do. Read
 * `_resolvedFieldComplexity` from logging, metrics, or a plugin after
 * execution.
 *
 * @example
 * ```typescript
 * @UseInterceptors(ComplexityInterceptor)
 * @Resolver(() => User)
 * export class UserResolver {
 *   @Query(() => [User])
 *   @Complexity(10)
 *   async users() {
 *     return this.userService.findAll();
 *   }
 * }
 * ```
 */
@Injectable()
export class ComplexityInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const declared = this.reflector.get<number | ComplexityEstimator | undefined>(
      COMPLEXITY_KEY,
      context.getHandler()
    );

    if (declared !== undefined) {
      // `@Complexity()` accepts either a fixed cost or an estimator. An
      // estimator is evaluated against this field's resolve info and args;
      // `childComplexity` is 0 because the interceptor runs before the
      // children resolve and so cannot know their cost.
      const complexity = this.resolveComplexity(declared, context);

      // Accumulate on the interceptor's own key — never the driver's
      // `_queryComplexity`, which `ComplexityGuard` enforces. A non-finite
      // cost (NaN, Infinity, or a non-number from an estimator) would corrupt
      // the running total, so it is skipped.
      const gqlContext = getGqlContext<Record<string, unknown> | undefined>(context);
      if (gqlContext && complexity !== undefined) {
        const current =
          typeof gqlContext._resolvedFieldComplexity === 'number'
            ? gqlContext._resolvedFieldComplexity
            : 0;
        gqlContext._resolvedFieldComplexity = current + complexity;
      }
    }

    return next.handle();
  }

  /**
   * Evaluate a declared `@Complexity()` cost.
   *
   * An estimator that throws must not break the resolver it annotates, so its
   * error is logged and the field contributes nothing. Only a finite number is
   * returned; anything else yields `undefined`.
   */
  private resolveComplexity(
    declared: number | ComplexityEstimator,
    context: ExecutionContext
  ): number | undefined {
    let complexity: unknown = declared;

    if (typeof declared === 'function') {
      try {
        complexity = declared({
          field: getGqlInfo(context),
          args: getGqlArgs<Record<string, unknown> | undefined>(context) ?? {},
          childComplexity: 0,
        });
      } catch (error) {
        console.error('[leaven] @Complexity estimator threw; skipping field cost', error);
        return undefined;
      }
    }

    return typeof complexity === 'number' && Number.isFinite(complexity)
      ? complexity
      : undefined;
  }
}

/**
 * Caching interceptor
 *
 * Forwards a `@CacheHint()` to `info.cacheControl.setCacheHint()`.
 *
 * @deprecated Has no effect; removal target 0.3.0. `info.cacheControl` is an
 * Apollo Server construct, and nothing in Leaven's execution path attaches it,
 * so in every supported configuration this interceptor does nothing and
 * `@CacheHint` has no observable effect. Emit `Cache-Control` from the HTTP
 * layer instead. Retained only so existing configurations keep compiling, and
 * so a resolver executed under an Apollo-compatible `info` still gets its hint.
 *
 * @example
 * ```typescript
 * @UseInterceptors(CachingInterceptor)
 * @Resolver(() => Settings)
 * export class SettingsResolver {
 *   @Query(() => Settings)
 *   @CacheHint({ maxAge: 3600, scope: 'PUBLIC' })
 *   async settings() {
 *     return this.settingsService.getAll();
 *   }
 * }
 * ```
 */
@Injectable()
export class CachingInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const cacheHint = this.reflector.get<CacheHintOptions | undefined>(
      CACHE_KEY,
      context.getHandler()
    );

    return next.handle().pipe(
      tap(() => {
        if (cacheHint) {
          // Store cache hints for response processing
          const gqlInfo = getGqlInfo<
            { cacheControl?: { setCacheHint(hint: CacheHintOptions): void } } | undefined
          >(context);
          if (gqlInfo?.cacheControl) {
            gqlInfo.cacheControl.setCacheHint({
              maxAge: cacheHint.maxAge,
              scope: cacheHint.scope,
            });
          }
        }
      })
    );
  }
}

/**
 * Metrics interceptor
 *
 * Collects metrics for GraphQL operations.
 *
 * @example
 * ```typescript
 * @UseInterceptors(MetricsInterceptor)
 * @Resolver(() => User)
 * export class UserResolver {
 *   // ...
 * }
 * ```
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  private readonly metrics = new Map<string, OperationMetrics>();

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const className = context.getClass().name;
    const methodName = context.getHandler().name;
    const key = `${className}.${methodName}`;
    const start = performance.now();

    return next.handle().pipe(
      tap(() => {
        const duration = performance.now() - start;
        this.recordSuccess(key, duration);
      }),
      catchError((error) => {
        const duration = performance.now() - start;
        this.recordError(key, duration);
        return throwError(() => error);
      })
    );
  }

  /**
   * Record a successful operation
   */
  private recordSuccess(key: string, duration: number): void {
    const metrics = this.getOrCreateMetrics(key);
    metrics.totalCount++;
    metrics.successCount++;
    metrics.totalDuration += duration;
    metrics.lastDuration = duration;
    metrics.minDuration = Math.min(metrics.minDuration, duration);
    metrics.maxDuration = Math.max(metrics.maxDuration, duration);
  }

  /**
   * Record an error
   */
  private recordError(key: string, duration: number): void {
    const metrics = this.getOrCreateMetrics(key);
    metrics.totalCount++;
    metrics.errorCount++;
    metrics.totalDuration += duration;
    metrics.lastDuration = duration;
    metrics.minDuration = Math.min(metrics.minDuration, duration);
    metrics.maxDuration = Math.max(metrics.maxDuration, duration);
  }

  /**
   * Get or create metrics for a key
   */
  private getOrCreateMetrics(key: string): OperationMetrics {
    let metrics = this.metrics.get(key);
    if (!metrics) {
      metrics = {
        totalCount: 0,
        successCount: 0,
        errorCount: 0,
        totalDuration: 0,
        lastDuration: 0,
        minDuration: Infinity,
        maxDuration: 0,
      };
      this.metrics.set(key, metrics);
    }
    return metrics;
  }

  /**
   * Get all metrics
   */
  public getMetrics(): Map<string, OperationMetrics> {
    return new Map(this.metrics);
  }

  /**
   * Get metrics summary
   */
  public getSummary(): MetricsSummary[] {
    return Array.from(this.metrics.entries()).map(([operation, metrics]) => ({
      operation,
      ...metrics,
      averageDuration: metrics.totalCount > 0 ? metrics.totalDuration / metrics.totalCount : 0,
      errorRate: metrics.totalCount > 0 ? metrics.errorCount / metrics.totalCount : 0,
    }));
  }

  /**
   * Reset all metrics
   */
  public reset(): void {
    this.metrics.clear();
  }
}

/**
 * Operation metrics
 */
export interface OperationMetrics {
  totalCount: number;
  successCount: number;
  errorCount: number;
  totalDuration: number;
  lastDuration: number;
  minDuration: number;
  maxDuration: number;
}

/**
 * Metrics summary for an operation
 */
export interface MetricsSummary extends OperationMetrics {
  operation: string;
  averageDuration: number;
  errorRate: number;
}
