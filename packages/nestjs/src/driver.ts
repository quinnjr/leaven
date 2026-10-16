/**
 * @leaven-graphql/nestjs - Leaven Driver for NestJS GraphQL
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import {
  GraphQLError,
  parse,
  print,
  type GraphQLSchema,
  type DocumentNode,
} from 'graphql';
import {
  LeavenExecutor,
  calculateQueryDepth,
  compileQuery,
  type ExecutorConfig,
  type ParseOptions,
} from '@leaven-graphql/core';
import { ValidationError, formatError, isLeavenError } from '@leaven-graphql/errors';
import type {
  LeavenModuleOptions,
  GqlContext,
  GraphQLFormattedError,
} from './types';

/**
 * Request handler result
 */
export interface HandlerResult<TData = Record<string, unknown>> {
  data?: TData | null;
  errors?: readonly GraphQLFormattedError[];
  extensions?: Record<string, unknown>;
}

/**
 * Memoized static analysis of one query document.
 *
 * Both values depend only on the document, the operation name, and the schema,
 * so they are safe to reuse across requests until the schema changes.
 */
interface QueryAnalysis {
  depth: number;
  complexity: number;
}

/**
 * Leaven Driver for NestJS GraphQL
 *
 * This driver integrates Leaven's high-performance GraphQL execution
 * with NestJS's dependency injection and module system.
 */
/**
 * Default `parseOptions.maxTokens`: generous for real documents, but bounds
 * the lexing, parsing and validation work one request can demand.
 */
export const DEFAULT_MAX_TOKENS = 10_000;

@Injectable()
export class LeavenDriver implements OnModuleInit, OnModuleDestroy {
  private executor: LeavenExecutor | null = null;
  private schema: GraphQLSchema | null = null;
  private readonly options: LeavenModuleOptions;

  /** Maximum number of memoized query analyses retained */
  private static readonly MAX_ANALYSIS_ENTRIES = 1000;

  /**
   * LRU of {@link QueryAnalysis} keyed by query string and operation name.
   * Cleared whenever the schema changes, since complexity is schema-dependent.
   */
  private readonly analysisCache = new Map<string, QueryAnalysis>();

  constructor(options: LeavenModuleOptions) {
    this.options = options;
  }

  /**
   * Initialize the driver with a schema
   */
  public async onModuleInit(): Promise<void> {
    if (this.options.schema) {
      this.schema = this.options.schema;
      this.initializeExecutor();
    }
  }

  /**
   * Cleanup resources on module destroy
   *
   * `LeavenExecutor.clearCaches()` is genuinely asynchronous for a remote
   * cache (Redis `FLUSH`), so it is awaited: dropping the promise would both
   * leave the clear unfinished and turn a rejecting cache into an unhandled
   * rejection during shutdown.
   */
  public async onModuleDestroy(): Promise<void> {
    if (this.executor) {
      await this.executor.clearCaches();
      this.executor = null;
    }
    this.analysisCache.clear();
  }

  /**
   * Set the GraphQL schema
   */
  public setSchema(schema: GraphQLSchema): void {
    this.schema = schema;
    this.initializeExecutor();
  }

  /**
   * Get the current schema
   */
  public getSchema(): GraphQLSchema | null {
    return this.schema;
  }

  /**
   * Effective parser options: the configured `parseOptions` with `maxTokens`
   * defaulted to {@link DEFAULT_MAX_TOKENS}.
   */
  public getParseOptions(): ParseOptions {
    return {
      ...this.options.parseOptions,
      maxTokens: this.options.parseOptions?.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  }

  /**
   * Get the executor instance
   */
  public getExecutor(): LeavenExecutor | null {
    return this.executor;
  }

  /**
   * Initialize the Leaven executor
   *
   * Every option the executor understands is forwarded here. In particular
   * `introspection` and `maxDepth` are *enforced by the executor* — the former
   * by validating with `NoSchemaIntrospectionCustomRule`, the latter by
   * rejecting over-deep documents at parse time — so omitting either would
   * leave a documented option silently inert.
   */
  private initializeExecutor(): void {
    if (!this.schema) {
      throw new Error('Schema must be set before initializing executor');
    }

    const config: ExecutorConfig = {
      schema: this.schema,
      cache: this.options.cache,
      metrics: this.options.metrics,
      maxComplexity: this.options.maxComplexity,
      maxDepth: this.options.maxDepth,
      parseOptions: this.getParseOptions(),
      introspection: this.isIntrospectionEnabled(),
    };

    // Complexity is schema-dependent, so a new schema invalidates every
    // memoized analysis.
    this.analysisCache.clear();

    this.executor = new LeavenExecutor(config);
  }

  /**
   * Execute a GraphQL request
   *
   * When `maxComplexity` or `maxDepth` is configured, the query is statically
   * analyzed before execution and its complexity and depth are recorded on the
   * provided context as `_queryComplexity` and `_queryDepth`, the keys read by
   * `ComplexityGuard` and `DepthGuard`. With neither limit configured the
   * analysis is skipped — see {@link attachQueryAnalysis}.
   */
  public async execute<TData = Record<string, unknown>>(
    query: string | DocumentNode,
    variables?: Record<string, unknown>,
    context?: GqlContext,
    operationName?: string
  ): Promise<HandlerResult> {
    if (!this.executor) {
      throw new Error('Executor not initialized. Set schema first.');
    }

    const queryString = typeof query === 'string' ? query : print(query);

    if (context) {
      this.attachQueryAnalysis(query, queryString, context, operationName);
    }

    try {
      const result = await this.executor.execute<TData>({
        query: queryString,
        variables,
        operationName,
      }, context);

      const response = result.response;

      // Format errors if formatter is provided. The formatter has an arity-1
      // contract, so it must not be handed to `map` directly (which would
      // also pass the index and array).
      let formattedErrors =
        response.errors as unknown as readonly GraphQLFormattedError[] | undefined;
      if (formattedErrors && this.options.formatError) {
        const formatErrorFn = this.options.formatError;
        formattedErrors = formattedErrors.map((error) => formatErrorFn(error));
      }

      // Add metrics to extensions if enabled
      let extensions = response.extensions;
      if (this.options.metrics && result.metrics) {
        extensions = {
          ...extensions,
          metrics: result.metrics,
        };
      }

      return {
        data: response.data as Record<string, unknown> | null | undefined,
        errors: formattedErrors,
        extensions,
      };
    } catch (error) {
      return { errors: [this.formatThrownError(error)] };
    }
  }

  /**
   * Turn an error thrown out of the executor into a response error.
   *
   * Leaven errors keep their code, extensions, and message as-is. Unexpected
   * errors are masked only in production — masking them in development would
   * hide the real message from the developer — and
   * `includeStacktraceInErrorResponses` suppresses masking outright, since a
   * masked error carries no stack to include. A configured `formatError` gets
   * the last word, exactly as it does for errors the executor reports itself.
   */
  private formatThrownError(error: unknown): GraphQLFormattedError {
    const isProduction = process.env.NODE_ENV === 'production';
    const includeStack = this.options.includeStacktraceInErrorResponses ?? false;
    const formattedError = formatError(error, {
      maskErrors: !isLeavenError(error) && isProduction && !includeStack,
      includeStackTrace: includeStack,
    }) as GraphQLFormattedError;

    return this.options.formatError
      ? this.options.formatError(formattedError)
      : formattedError;
  }

  /**
   * Start a GraphQL subscription.
   *
   * Resolves to an async iterator of results when the operation subscribes
   * successfully, or to a {@link HandlerResult} carrying `errors` when the
   * document fails to parse or validate. Callers must distinguish the two by
   * testing for `Symbol.asyncIterator`. This method rejects only when the
   * driver has no executor — every error raised while subscribing is reported
   * through `errors`, and masked in production, exactly as in {@link execute}.
   *
   * As with {@link execute}, complexity and depth are recorded on the context
   * — when a limit is configured — so the guards apply to subscriptions as
   * well as queries.
   */
  public async subscribe<TData = Record<string, unknown>>(
    query: string | DocumentNode,
    variables?: Record<string, unknown>,
    context?: GqlContext,
    operationName?: string
  ): Promise<AsyncIterableIterator<HandlerResult<TData>> | HandlerResult<TData>> {
    if (!this.executor) {
      throw new Error('Executor not initialized. Set schema first.');
    }

    const queryString = typeof query === 'string' ? query : print(query);

    if (context) {
      this.attachQueryAnalysis(query, queryString, context, operationName);
    }

    try {
      const result = await this.executor.subscribe<TData>(
        { query: queryString, variables, operationName },
        context
      );

      if (!(Symbol.asyncIterator in result)) {
        let errors = result.errors as unknown as readonly GraphQLFormattedError[] | undefined;
        if (errors && this.options.formatError) {
          const formatErrorFn = this.options.formatError;
          errors = errors.map((error) => formatErrorFn(error));
        }
        return { errors } as HandlerResult<TData>;
      }

      return result as unknown as AsyncIterableIterator<HandlerResult<TData>>;
    } catch (error) {
      // `LeavenExecutor.subscribe` throws (rather than returning errors) on a
      // syntax error, an over-depth document, or a failure inside a subscribe
      // resolver. The documented contract is that only a missing executor
      // rejects, so those surface as a `HandlerResult` here.
      return { errors: [this.formatThrownError(error)] } as HandlerResult<TData>;
    }
  }

  /**
   * Handle an HTTP request
   */
  public async handleRequest(
    request: Request,
    response: Response
  ): Promise<HandlerResult> {
    const body = await this.parseRequestBody(request);
    const context = await this.createContext(request, response);

    return this.execute(
      body.query,
      body.variables,
      context,
      body.operationName
    );
  }

  /**
   * Parse the request body
   *
   * POST requests are dispatched on their content type: `application/json`
   * bodies carry `{ query, variables, operationName }`, and
   * `application/graphql` bodies (per the GraphQL-over-HTTP spec) carry the
   * raw query string. Other methods read the operation from URL parameters.
   */
  private async parseRequestBody(request: Request): Promise<{
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
  }> {
    const contentType = request.headers.get('content-type') ?? '';

    if (request.method === 'POST') {
      if (contentType.includes('application/json')) {
        const body = await request.json() as Record<string, unknown>;
        return {
          query: body.query as string,
          variables: body.variables as Record<string, unknown> | undefined,
          operationName: body.operationName as string | undefined,
        };
      }

      if (contentType.includes('application/graphql')) {
        const query = await request.text();
        if (!query) {
          throw new ValidationError('Query is required');
        }
        return { query };
      }

      throw new ValidationError(
        `Unsupported content type "${contentType || '(none)'}": use application/json or application/graphql`
      );
    }

    // GET (and other) requests carry the operation in URL query params
    const url = new URL(request.url);
    const query = url.searchParams.get('query');
    const variables = url.searchParams.get('variables');
    const operationName = url.searchParams.get('operationName');

    if (!query) {
      throw new ValidationError('Query is required');
    }

    let parsedVariables: Record<string, unknown> | undefined;
    if (variables) {
      try {
        parsedVariables = JSON.parse(variables) as Record<string, unknown>;
      } catch {
        throw new ValidationError(
          'The "variables" query parameter contains malformed JSON'
        );
      }
    }

    return {
      query,
      variables: parsedVariables,
      operationName: operationName ?? undefined,
    };
  }

  /**
   * Create context for the request
   */
  private async createContext(
    request: Request,
    response: Response
  ): Promise<GqlContext> {
    const baseContext: GqlContext = {
      req: request,
      res: response,
    };

    if (this.options.context) {
      const customContext = await this.options.context(request, response);
      return { ...baseContext, ...customContext };
    }

    return baseContext;
  }

  /**
   * Analyze the query and record its complexity and depth on the request
   * context under the `_queryComplexity` / `_queryDepth` keys that
   * `ComplexityGuard` and `DepthGuard` enforce.
   *
   * Analysis is **skipped entirely** unless `maxComplexity` or `maxDepth` is
   * configured. It costs a full uncached `parse()` plus a full uncached
   * complexity compilation on top of the executor's own (LRU-cached) parse and
   * compile — roughly 2.6x the work of the request itself for a small query —
   * and with no limit configured both guards receive the module's `Infinity`
   * sentinel and have nothing to enforce.
   *
   * When a limit *is* configured, the result is memoized in a small LRU keyed
   * by query text and operation name, so the surcharge is paid once per
   * distinct document rather than once per request.
   *
   * A document that fails to parse is left to the executor, which reports the
   * syntax error as a proper GraphQL error response — no limit can be
   * meaningfully enforced on a document that never executes.
   *
   * Every other failure (a broken compiler, a missing schema, a depth
   * traversal that throws) is an *analysis* failure: it is logged and both
   * fields are set to `Infinity` so the guards fail closed. Leaving them unset
   * would hand an attacker who finds one query shape that trips the analyzer
   * an unlimited-complexity channel. Failures are never memoized.
   */
  private attachQueryAnalysis(
    query: string | DocumentNode,
    queryString: string,
    context: GqlContext,
    operationName?: string
  ): void {
    if (
      this.options.maxComplexity === undefined &&
      this.options.maxDepth === undefined
    ) {
      return;
    }

    const target = context as Record<string, unknown>;
    const cacheKey = `${queryString}\x00${operationName ?? ''}`;

    const memoized = this.analysisCache.get(cacheKey);
    if (memoized) {
      // Refresh LRU recency (Map preserves insertion order)
      this.analysisCache.delete(cacheKey);
      this.analysisCache.set(cacheKey, memoized);
      target._queryDepth = memoized.depth;
      target._queryComplexity = memoized.complexity;
      return;
    }

    let document: DocumentNode;
    try {
      const { graphqlOptions, maxTokens } = this.getParseOptions();
      document =
        typeof query === 'string' ? parse(query, { ...graphqlOptions, maxTokens }) : query;
    } catch (error) {
      if (error instanceof GraphQLError) {
        // Genuine syntax error: defer to the executor.
        return;
      }
      this.recordAnalysisFailure(target, error);
      return;
    }

    try {
      const depth = calculateQueryDepth(document);

      if (!this.schema) {
        throw new Error('Schema is not set; query complexity cannot be computed');
      }

      const complexity = compileQuery(this.schema, document, operationName, {
        calculateComplexity: true,
      }).complexity;

      target._queryDepth = depth;
      target._queryComplexity = complexity;
      this.memoizeAnalysis(cacheKey, { depth, complexity });
    } catch (error) {
      this.recordAnalysisFailure(target, error);
    }
  }

  /**
   * Store an analysis result, evicting the least recently used entry when the
   * cache is full.
   */
  private memoizeAnalysis(key: string, analysis: QueryAnalysis): void {
    if (this.analysisCache.size >= LeavenDriver.MAX_ANALYSIS_ENTRIES) {
      const oldest = this.analysisCache.keys().next().value;
      if (oldest !== undefined) {
        this.analysisCache.delete(oldest);
      }
    }
    this.analysisCache.set(key, analysis);
  }

  /**
   * Record a fail-closed sentinel for both analysis fields and log the cause.
   *
   * `Infinity` exceeds every finite limit, so a configured `ComplexityGuard`
   * or `DepthGuard` rejects the request rather than letting it through
   * unmeasured.
   */
  private recordAnalysisFailure(
    target: Record<string, unknown>,
    error: unknown
  ): void {
    console.error('[Leaven] Query analysis failed; failing closed:', error);
    target._queryDepth = Number.POSITIVE_INFINITY;
    target._queryComplexity = Number.POSITIVE_INFINITY;
  }

  /**
   * Check if playground should be enabled
   */
  public isPlaygroundEnabled(): boolean {
    if (this.options.playground !== undefined) {
      return this.options.playground;
    }
    return process.env.NODE_ENV !== 'production';
  }

  /**
   * Check if introspection should be enabled
   *
   * This is the value handed to the executor as `ExecutorConfig.introspection`,
   * which installs `NoSchemaIntrospectionCustomRule` when it is `false`, so a
   * caller may also use it to decide whether to serve a schema-browsing UI.
   */
  public isIntrospectionEnabled(): boolean {
    if (this.options.introspection !== undefined) {
      return this.options.introspection;
    }
    return process.env.NODE_ENV !== 'production';
  }

  /**
   * Get the GraphQL path
   */
  public getPath(): string {
    return this.options.path ?? '/graphql';
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): ReturnType<LeavenExecutor['getCacheStats']> | null {
    return this.executor?.getCacheStats() ?? null;
  }

  /**
   * Clear all caches
   *
   * Awaited rather than fired and forgotten: `clearCaches` is asynchronous for
   * a remote cache, so a floated promise would leave the clear unfinished and
   * a rejecting cache unhandled.
   */
  public async clearCaches(): Promise<void> {
    this.analysisCache.clear();
    await this.executor?.clearCaches();
  }
}
