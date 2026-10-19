/**
 * @leaven-graphql/nestjs - Leaven Driver for NestJS GraphQL
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import {
  GraphQLError,
  OperationTypeNode,
  getOperationAST,
  parse,
  print,
  type GraphQLSchema,
  type DocumentNode,
  type GraphQLFormattedError as GraphQLJsFormattedError,
} from 'graphql';
import {
  LeavenExecutor,
  calculateQueryDepth,
  compileQuery,
  escapeLog,
  type ExecutorConfig,
  type ParseOptions,
} from '@leaven-graphql/core';
import {
  ErrorCode,
  LeavenError,
  maskedErrorFor,
  ValidationError,
  formatError,
  isLeavenError,
  maskError,
} from '@leaven-graphql/errors';
import type {
  LeavenModuleOptions,
  GqlContext,
  GraphQLFormattedError,
} from './types';
import {
  csrfBlockedError,
  DEFAULT_BODY_READ_TIMEOUT_MS,
  DEFAULT_MAX_BODY_SIZE,
  isCsrfBlocked,
  mediaType,
  resolveCsrfRequestHeaders,
  readBodyText,
  validateGraphQLBody,
  validateVariables,
} from './request-body';
import { httpExceptionCode, normalizeHttpException } from './http-exception';

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

  /**
   * Header names that satisfy CSRF prevention, or `undefined` when
   * `csrfPrevention` is `false`. Resolved (and validated) at construction.
   */
  private readonly csrfRequestHeaders: readonly string[] | undefined;

  /** Maximum number of memoized query analyses retained */
  private static readonly MAX_ANALYSIS_ENTRIES = 1000;

  /**
   * Estimated memory budget of the analysis memo: 8 MiB. An entry's cost is
   * its key, which holds the whole query text (estimated at 2 bytes per
   * UTF-16 code unit plus a fixed 64 for the map slot and result), and an
   * entry above a tenth of the budget is never memoized.
   */
  public static readonly MAX_ANALYSIS_BYTES = 8 * 1024 * 1024;

  /**
   * LRU of {@link QueryAnalysis} keyed by query string and operation name.
   * Cleared whenever the schema changes, since complexity is schema-dependent.
   */
  private readonly analysisCache = new Map<string, QueryAnalysis>();

  /** Estimated bytes held by {@link analysisCache} */
  private analysisBytes = 0;

  constructor(options: LeavenModuleOptions) {
    this.options = options;
    this.csrfRequestHeaders = resolveCsrfRequestHeaders(options.csrfPrevention);
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
    this.clearAnalysisCache();
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
      formatExecutionError: (error) => this.formatExecutionError(error),
    };

    // Complexity is schema-dependent, so a new schema invalidates every
    // memoized analysis.
    this.clearAnalysisCache();

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
      const formattedErrors = this.formatResultErrors(
        response.errors as unknown as readonly GraphQLFormattedError[] | undefined
      );

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
   * Whether unexpected errors are masked: in production only, and never when
   * `includeStacktraceInErrorResponses` is set, since a masked error carries
   * no stack to include.
   */
  private shouldMaskErrors(): boolean {
    return (
      process.env.NODE_ENV === 'production' &&
      !(this.options.includeStacktraceInErrorResponses ?? false)
    );
  }

  /**
   * Serialize one execution error, masking it in production.
   *
   * Installed as the executor's `formatExecutionError` hook, the last point at
   * which `originalError` is still reachable, so the `maskError` rules of
   * `@leaven-graphql/errors` apply exactly: an intentional Leaven error, or one
   * carrying a known non-`INTERNAL_ERROR` code, keeps its message; anything
   * else (a resolver's plain `Error`, an `INTERNAL_ERROR`) is replaced by the
   * generic masked error. This is the same rule {@link formatThrownError}
   * applies to errors thrown out of the executor. Unmasked errors are
   * serialized exactly as the executor's default would (`toJSON()`).
   *
   * A NestJS `HttpException` (a resolver's `UnauthorizedException`, say) has
   * no `extensions` for graphql-js to adopt, so it is first given its mapped
   * {@link ErrorCode} — the same translation `LeavenGraphQLDriver` applies —
   * and its own message. A known code then keeps it unmasked in production,
   * instead of reaching the client as a masked `INTERNAL_ERROR`; a 5xx maps to
   * `INTERNAL_ERROR` and is still masked.
   */
  private formatExecutionError(error: GraphQLError): GraphQLJsFormattedError {
    const target = LeavenDriver.withHttpExceptionCode(error);
    if (!this.shouldMaskErrors()) {
      return target.toJSON();
    }
    return maskError(target, {
      maskErrors: true,
      formatter: (original, shouldMask) =>
        shouldMask
          ? maskedErrorFor(original)
          : original.toJSON(),
    });
  }

  /**
   * `error` with a NestJS `HttpException` cause translated: its mapped
   * `extensions.code` and `statusCode`, and the exception's message. Any other
   * error is returned unchanged.
   */
  private static withHttpExceptionCode(error: GraphQLError): GraphQLError {
    const original = error.originalError;
    const mapped = httpExceptionCode(original);
    if (mapped === undefined || original === undefined) {
      return error;
    }
    return new GraphQLError(original.message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
      originalError: original,
      extensions: { ...error.extensions, code: mapped.code, statusCode: mapped.status },
    });
  }

  /**
   * Finalize the errors the executor reported.
   *
   * Most were already serialized, and masked in production, by
   * {@link formatExecutionError}. Errors the executor catches itself
   * (`formatCaughtError`: a compiler throw, a pipeline `Error`) skip that hook
   * and arrive with a raw message and either no code or `INTERNAL_ERROR`, so
   * in production (see {@link shouldMaskErrors}) those are masked here, as in
   * `LeavenGraphQLDriver`. Errors with a `path` are left to
   * {@link formatExecutionError}; already-masked errors are unchanged.
   * Then a configured `formatError` gets the last word. It has an arity-1
   * contract, so it must not be handed to `map` directly (which would also
   * pass the index and array).
   */
  private formatResultErrors(
    errors: readonly GraphQLFormattedError[] | undefined
  ): readonly GraphQLFormattedError[] | undefined {
    const formatErrorFn = this.options.formatError;
    const mask = this.shouldMaskErrors();
    if (!errors || (!formatErrorFn && !mask)) {
      return errors;
    }
    return errors.map((error) => {
      const rawCode = error.extensions?.code;
      // An error with a `path` came out of a resolver and was already
      // serialized (and masked when unexpected) by formatExecutionError, which
      // knows whether it was intentional. Only pipeline-caught errors, which
      // carry no path, are unclassified here.
      const masked =
        mask &&
        error.path === undefined &&
        (rawCode === undefined || rawCode === ErrorCode.INTERNAL_ERROR)
          ? (maskedErrorFor(error) as GraphQLFormattedError)
          : error;
      return formatErrorFn ? formatErrorFn(masked) : masked;
    });
  }

  /**
   * Turn a thrown error into a response error.
   *
   * Leaven errors keep their code, extensions, and message as-is; any other
   * `GraphQLError` keeps its `extensions.code`, and everything else is
   * reported as `INTERNAL_ERROR`. Unexpected errors are masked only in
   * production — masking them in development would hide the real message from
   * the developer — and `includeStacktraceInErrorResponses` suppresses masking
   * outright, since a masked error carries no stack to include. A configured
   * `formatError` gets the last word, exactly as it does for errors the
   * executor reports itself.
   *
   * Public so the subscription transport formats the errors it catches (a
   * failing `onSubscribe`, `context` or `onOperation` hook, a source stream
   * that throws) exactly as this driver formats its own.
   *
   * @param error - Anything thrown
   * @returns The formatted error to send to the client
   */
  public formatThrownError(thrown: unknown): GraphQLFormattedError {
    // A NestJS `HttpException` (a guard-style `UnauthorizedException` thrown
    // from a context factory or hook) keeps its mapped code and message.
    const error = normalizeHttpException(thrown);
    const includeStack = this.options.includeStacktraceInErrorResponses ?? false;
    const formattedError = formatError(error, {
      maskErrors: !isLeavenError(error) && this.shouldMaskErrors(),
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
        const errors = this.formatResultErrors(
          result.errors as unknown as readonly GraphQLFormattedError[] | undefined
        );
        return { errors } as HandlerResult<TData>;
      }

      return this.formatStream(result as unknown as AsyncIterableIterator<HandlerResult<TData>>);
    } catch (error) {
      // `LeavenExecutor.subscribe` is documented never to throw: parse,
      // validation and subscribe-resolver failures come back as `errors`.
      // This catch is defensive — a broken cache or a replaced executor could
      // still throw — and keeps this method's contract that only a missing
      // executor rejects.
      return { errors: [this.formatThrownError(error)] } as HandlerResult<TData>;
    }
  }

  /**
   * Wrap a subscription stream so the errors of every event get the same
   * `formatError` pass as {@link execute} applies, rather than reaching the
   * client exactly as the executor serialised them. An error thrown by the
   * stream itself is left for the caller to format with
   * {@link formatThrownError}.
   */
  private formatStream<TData>(
    iterator: AsyncIterableIterator<HandlerResult<TData>>
  ): AsyncIterableIterator<HandlerResult<TData>> {
    if (!this.options.formatError && !this.shouldMaskErrors()) {
      return iterator;
    }
    const format = (value: HandlerResult<TData>): HandlerResult<TData> =>
      value?.errors ? { ...value, errors: this.formatResultErrors(value.errors) } : value;

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<HandlerResult<TData>>> {
        const step = await iterator.next();
        return step.done ? step : { value: format(step.value), done: false };
      },
      async return(value?: unknown): Promise<IteratorResult<HandlerResult<TData>>> {
        return iterator.return
          ? iterator.return(value)
          : { value: undefined, done: true };
      },
      async throw(error?: unknown): Promise<IteratorResult<HandlerResult<TData>>> {
        if (iterator.throw) {
          return iterator.throw(error);
        }
        throw error;
      },
    };
  }

  /**
   * Handle an HTTP request
   *
   * A malformed request is rejected by throwing a coded `LeavenError` whose
   * `statusCode` the caller maps to the HTTP response:
   * - a malformed payload: `ValidationError` (400);
   * - a method other than GET or POST (HEAD, PUT, DELETE, PATCH, ...):
   *   `BAD_REQUEST` with `statusCode` 405 and `extensions.allow` of
   *   `'GET, POST'`, which should be sent as `Allow: GET, POST`. Checked
   *   before anything is read, so such a request never executes — HEAD in
   *   particular is CORS-safelisted, so letting it run a mutation would be a
   *   CSRF hole;
   * - a body over `maxBodySize`: `PAYLOAD_TOO_LARGE` (413);
   * - a body not read within `bodyReadTimeoutMs`, or whose read fails (a
   *   client abort, say): `BAD_REQUEST` (400);
   * - a mutation sent over GET: `BAD_REQUEST` with `statusCode` 405 and
   *   `extensions.allow` of `'POST'`, which should be sent as `Allow: POST`.
   *   Mutations are not safe over GET (GraphQL over HTTP spec), so this is
   *   checked before the context factory runs;
   * - a POST blocked by `csrfPrevention` (a missing or CORS-safelisted
   *   Content-Type and no preflight-forcing header): `BAD_REQUEST` (400),
   *   checked before the body is read. This path only accepts JSON and
   *   `application/graphql` bodies anyway; the check keeps every entry point
   *   answering a simple cross-site POST the same way;
   * - a POST whose `Content-Type` is not `application/json` or
   *   `application/graphql`: `BAD_REQUEST` with `statusCode` 415, checked
   *   after the CSRF check;
   * - a `context` factory that throws a NestJS `HttpException`: a `LeavenError`
   *   carrying the mapped code and the exception's status (an
   *   `UnauthorizedException` is `UNAUTHENTICATED`, 401). A 5xx exception and
   *   any other error are rethrown unchanged.
   */
  public async handleRequest(
    request: Request,
    response: Response
  ): Promise<HandlerResult> {
    if (request.method !== 'GET' && request.method !== 'POST') {
      throw new LeavenError(
        `Method ${escapeLog(request.method, 16)} is not allowed: use GET or POST`,
        ErrorCode.BAD_REQUEST,
        { statusCode: 405, extensions: { allow: 'GET, POST' } }
      );
    }
    if (
      request.method === 'POST' &&
      this.csrfRequestHeaders !== undefined &&
      isCsrfBlocked(
        request.headers.get('content-type'),
        (name) => request.headers.get(name),
        this.csrfRequestHeaders
      )
    ) {
      throw csrfBlockedError();
    }
    const body = await this.parseRequestBody(request);
    if (request.method === 'GET' && (await this.isMutation(body.query, body.operationName))) {
      throw new LeavenError('Mutations can only be sent with POST', ErrorCode.BAD_REQUEST, {
        statusCode: 405,
        extensions: { allow: 'POST' },
      });
    }
    let context: GqlContext;
    try {
      context = await this.createContext(request, response);
    } catch (thrown) {
      throw normalizeHttpException(thrown);
    }

    return this.execute(
      body.query,
      body.variables,
      context,
      body.operationName
    );
  }

  /**
   * Whether the operation a request selects is a mutation.
   *
   * Parses under the executor's limits. A parse failure or an ambiguous
   * operation is `false`, so that execution reports the real error.
   */
  private async isMutation(query: string, operationName?: string): Promise<boolean> {
    if (!this.executor) {
      return false;
    }
    try {
      const document = await this.executor.parse(query);
      return getOperationAST(document, operationName)?.operation === OperationTypeNode.MUTATION;
    } catch {
      return false;
    }
  }

  /**
   * Parse the request body
   *
   * POST requests are dispatched on their content type: `application/json`
   * bodies carry `{ query, variables, operationName }`, and
   * `application/graphql` bodies (per the GraphQL-over-HTTP spec) carry the
   * raw query string. GET reads the operation from URL parameters;
   * `handleRequest` rejects every other method with a 405 before this runs.
   * A POST body over `maxBodySize` is rejected with `PAYLOAD_TOO_LARGE`, and
   * one not read within `bodyReadTimeoutMs` with `BAD_REQUEST`. Any other
   * content type is a 415 `BAD_REQUEST`.
   */
  private async parseRequestBody(request: Request): Promise<{
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
  }> {
    const contentType = mediaType(request.headers.get('content-type'));

    if (request.method === 'POST') {
      const maxBodySize = this.options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
      const timeoutMs = this.options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS;

      if (contentType === 'application/json') {
        const text = await readBodyText(request, maxBodySize, timeoutMs);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ValidationError('Invalid JSON body');
        }
        return validateGraphQLBody(parsed);
      }

      if (contentType === 'application/graphql') {
        // The body is the raw query string; only the query check applies.
        return validateGraphQLBody({ query: await readBodyText(request, maxBodySize, timeoutMs) });
      }

      throw new LeavenError(
        'Unsupported Content-Type: expected application/json or application/graphql',
        ErrorCode.BAD_REQUEST,
        { statusCode: 415 }
      );
    }

    // GET requests carry the operation in URL query params
    const url = new URL(request.url);
    const query = url.searchParams.get('query');
    const variables = url.searchParams.get('variables');
    const operationName = url.searchParams.get('operationName');

    if (!query) {
      throw new ValidationError('Query is required');
    }

    let parsedVariables: Record<string, unknown> | undefined;
    if (variables) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(variables);
      } catch {
        throw new ValidationError(
          'The "variables" query parameter contains malformed JSON'
        );
      }
      // `null` means "no variables"; an array, number or string is rejected
      parsedVariables = validateVariables(decoded);
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
   * Store an analysis result, evicting least recently used entries until
   * both {@link MAX_ANALYSIS_ENTRIES} and {@link MAX_ANALYSIS_BYTES} hold.
   * A key above a tenth of the byte budget is not memoized at all.
   */
  private memoizeAnalysis(key: string, analysis: QueryAnalysis): void {
    const bytes = LeavenDriver.analysisEntryBytes(key);
    if (bytes > LeavenDriver.MAX_ANALYSIS_BYTES / 10) return;

    if (this.analysisCache.delete(key)) {
      this.analysisBytes -= bytes;
    }
    while (
      this.analysisCache.size > 0 &&
      (this.analysisCache.size >= LeavenDriver.MAX_ANALYSIS_ENTRIES ||
        this.analysisBytes + bytes > LeavenDriver.MAX_ANALYSIS_BYTES)
    ) {
      const oldest = this.analysisCache.keys().next().value as string;
      this.analysisCache.delete(oldest);
      this.analysisBytes -= LeavenDriver.analysisEntryBytes(oldest);
    }
    this.analysisCache.set(key, analysis);
    this.analysisBytes += bytes;
  }

  /** Estimated bytes one memo entry retains. See {@link MAX_ANALYSIS_BYTES}. */
  private static analysisEntryBytes(key: string): number {
    return key.length * 2 + 64;
  }

  /** Empty the analysis memo, keeping its byte count in step */
  private clearAnalysisCache(): void {
    this.analysisCache.clear();
    this.analysisBytes = 0;
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
    this.clearAnalysisCache();
    await this.executor?.clearCaches();
  }
}
