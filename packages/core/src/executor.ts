/**
 * @leaven-graphql/core - GraphQL executor
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  execute,
  subscribe,
  GraphQLError,
  specifiedRules,
  NoSchemaIntrospectionCustomRule,
  getOperationAST,
  printSchema,
  type GraphQLSchema,
  type DocumentNode,
  type GraphQLFormattedError,
  type ExecutionResult as GraphQLExecutionResult,
} from 'graphql';
import { ComplexityError, ErrorCode, isLeavenError } from '@leaven-graphql/errors';

import { DocumentCache, type DocumentCacheConfig, type CachedValidation, type IDocumentCache, resolveValue } from './cache';
import {
  operationSelectionError,
  parseDocument,
  withErrorCode,
  validateDocument,
  type ParseOptions,
  type ValidationResult,
} from './parser';
import { type CompiledQuery, compileQuery, type CompilerOptions } from './compiler';
import { CompiledQueryCache } from './compiled-cache';
import type {
  Variables,
  GraphQLRequest,
  GraphQLResponse,
  SubscriptionIterator,
  ExecutionHooks,
  ExecutionMetrics,
} from './types';

/**
 * Configuration for the GraphQL executor
 */
export interface ExecutorConfig {
  /** The GraphQL schema */
  schema: GraphQLSchema;
  /** Root value for resolvers */
  rootValue?: unknown;
  /**
   * Document cache configuration
   * - `true`: Use default in-memory cache
   * - `false`: Disable caching
   * - `DocumentCacheConfig`: Configure in-memory cache
   * - `IDocumentCache`: Use a custom cache implementation (e.g., Redis)
   */
  cache?: DocumentCacheConfig | boolean | IDocumentCache;
  /** Parser options */
  parseOptions?: ParseOptions;
  /** Compiler options (enables query compilation) */
  compilerOptions?: CompilerOptions;
  /** Enable introspection queries */
  introspection?: boolean;
  /** Maximum query depth */
  maxDepth?: number;
  /**
   * Maximum depth of introspection selections (`__schema`/`__type` at an
   * operation root), counted instead of `maxDepth` for those paths. Lets
   * GraphiQL and codegen send `getIntrospectionQuery()` (depth 15) while
   * ordinary queries stay under a tighter `maxDepth`. When unset,
   * introspection counts against `maxDepth`. See
   * {@link ParseOptions.maxIntrospectionDepth}.
   */
  maxIntrospectionDepth?: number;
  /**
   * Maximum query complexity.
   *
   * Enforced for subscriptions as well as queries and mutations — both go
   * through the same parse/validate/compile pipeline.
   */
  maxComplexity?: number;
  /**
   * Execution hooks.
   *
   * `subscribe()` runs the same hooks as `execute()` up to and including
   * `onExecute`. It does NOT call `onExecuted`, because a subscription yields
   * a stream rather than one response.
   */
  hooks?: ExecutionHooks;
  /**
   * Enable execution metrics.
   *
   * Only `execute()` reports them: its result carries a `metrics` field,
   * whereas `subscribe()` resolves to an iterator or a bare response with
   * nowhere to put them.
   */
  metrics?: boolean;
  /**
   * Serialize an error raised by *execution* while the graphql-js
   * {@link GraphQLError} is still intact.
   *
   * The executor otherwise reports execution errors as `error.toJSON()`, which
   * emits only `{ message, locations, path, extensions }` and **drops
   * `originalError`**. That loss matters for a transport sitting on top of a
   * framework with its own error currency: graphql-js sets
   * `extensions = extensions ?? originalError?.extensions ?? {}`, so a
   * `LeavenError` (which carries `extensions`) survives serialization with its
   * `code`, but a framework exception without an `extensions` property — a
   * NestJS `HttpException`, say — arrives with `extensions: {}` and is
   * indistinguishable from a crash. This hook runs *before* `toJSON()`, so it
   * is the only place such an error can still be recognised and mapped to an
   * `ErrorCode`.
   *
   * Not to be confused with the transports' `formatError` option (e.g.
   * `LeavenModuleOptions.formatError`), which is a final, response-level pass
   * over an already-serialized `GraphQLFormattedError`. This hook is
   * executor-level and receives the live `GraphQLError`.
   *
   * Applies to the errors of an execution result and of a subscription — the
   * paths where a resolver's `originalError` exists. It is deliberately *not*
   * applied to parse, validation or complexity rejections (which never carry a
   * framework `originalError` and are already given an `ErrorCode` by Leaven),
   * nor to an error thrown out of the executor itself, which is formatted by
   * the errors package.
   *
   * Defaults to `error.toJSON()`.
   */
  formatExecutionError?: (error: GraphQLError) => GraphQLFormattedError;
}

/**
 * Counters the shared pipeline fills in for {@link ExecutionMetrics}.
 */
interface PipelineTelemetry {
  parseTime: number;
  validationTime: number;
  documentCached: boolean;
  validationCached: boolean;
  queryCached: boolean;
  complexity?: number;
}

/**
 * Responses the executor produced for a request it rejected before running
 * any resolver. See {@link isRequestRejection}.
 */
const requestRejections = new WeakSet<object>();

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function markRejection<T extends object>(response: T): T {
  requestRejections.add(response);
  return response;
}

/**
 * Whether a response is one the executor produced because it rejected the
 * request before running any resolver.
 *
 * That covers a syntax error, the parser limits (`maxTokens`, `maxDepth`,
 * the analysis budget), a validation failure, the complexity budget, an
 * unknown or missing operation name, and a variable that fails to coerce. It
 * also covers anything else that fails before execution starts, that is
 * before `onExecute` is invoked: a throw (or rejection) from the `onParse`,
 * `onParsed`, `onValidate` or `onValidated` hooks, from a
 * `complexityCalculator`, or from the document cache. No resolver ran, so the
 * request can safely be answered with a non-200 status and retried. Errors
 * from `onExecute`, `onExecuted`, resolvers, subscribe resolvers, and
 * anything else raised once execution started are never marked, whatever
 * code they carry.
 *
 * The check is identity-based: pass the very `response` object that
 * `execute()` (inside its `ExecutionResult`) or `subscribe()` returned, not a
 * copy or a formatted clone. The mark is also module-scoped, so the caller
 * must use the same installed copy of `@leaven-graphql/core` as the executor
 * that produced the response. With duplicate copies this returns false, which
 * is safe: the response streams instead of being answered non-200. The mark changes nothing on the wire: the
 * response serialises exactly as before.
 *
 * @param response - A response returned by the executor
 * @returns True when the executor rejected the request before execution
 */
export function isRequestRejection(response: unknown): boolean {
  return isObject(response) && requestRejections.has(response);
}

/**
 * Result of the shared pipeline: either a document cleared to run, or the
 * formatted errors that reject the request.
 */
type PipelineOutcome =
  | { document: DocumentNode; errors?: undefined }
  | { document?: undefined; errors: readonly GraphQLFormattedError[] };

/**
 * Memoised `printSchema()` output, keyed by schema instance.
 *
 * Printing a 200-type schema costs roughly a millisecond and ~17KB of string,
 * and it dominates the cost of building an executor's validation fingerprint.
 * A `GraphQLSchema` is effectively immutable once constructed, so the printed
 * form is stable for the lifetime of the instance; the `WeakMap` keeps the
 * entry alive only as long as the schema itself.
 */
const printedSchemas = new WeakMap<GraphQLSchema, string>();

function printSchemaOnce(schema: GraphQLSchema): string {
  const cached = printedSchemas.get(schema);
  if (cached !== undefined) return cached;

  const printed = printSchema(schema);
  printedSchemas.set(schema, printed);
  return printed;
}

/**
 * Deterministic JSON serialization: object keys are emitted in sorted order
 * and `undefined` values are dropped, so two structurally identical configs
 * always produce the same string no matter what order their properties were
 * assigned in. `JSON.stringify` alone is insertion-ordered and would give two
 * equivalent executors different cache namespaces.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

/**
 * Execution context passed to resolvers
 */
export interface ExecutionContext<TContext = unknown> {
  /** User-provided context */
  context: TContext;
  /** The parsed document */
  document: DocumentNode;
  /** Operation name */
  operationName?: string;
  /** Variables */
  variables?: Variables;
  /** Request metadata */
  request?: {
    headers?: Record<string, string>;
    method?: string;
  };
}

/**
 * Full execution result including metrics
 */
export interface ExecutionResult<TData = Record<string, unknown>> {
  /** The GraphQL response */
  response: GraphQLResponse<TData>;
  /** Execution metrics (if enabled) */
  metrics?: ExecutionMetrics;
}

/**
 * High-performance GraphQL executor for Bun
 */
export class LeavenExecutor {
  private readonly schema: GraphQLSchema;
  private readonly rootValue: unknown;
  private readonly cache: IDocumentCache | null;
  /**
   * Effective parser options, with a configured `maxDepth` and
   * `maxIntrospectionDepth` already folded in so the values used at parse
   * time are the values that were fingerprinted.
   */
  private readonly parseOptions: ParseOptions;
  private readonly compilerOptions?: CompilerOptions;
  private readonly validationRules?: readonly unknown[];
  /**
   * Fingerprint of everything a cache entry depends on: the schema, the
   * validation rule set, and the parser options (including `maxDepth`).
   * See {@link LeavenExecutor.cacheKeyFor}.
   */
  private readonly validationFingerprint: string;
  private readonly maxComplexity?: number;
  private readonly hooks?: ExecutionHooks;
  private readonly metricsEnabled: boolean;
  /**
   * Serializer applied to execution and subscription errors. Bound once so it
   * can be handed to the subscription iterator, whose `this` is the iterator.
   * See {@link ExecutorConfig.formatExecutionError}.
   */
  private readonly serializeExecutionError: (error: GraphQLError) => GraphQLFormattedError;

  /** Maximum number of compiled queries retained in the LRU cache */
  public static readonly MAX_COMPILED_QUERIES = 1000;

  /**
   * Estimated memory budget of the compiled-query cache: 32 MiB. Plans are
   * sized like document-cache entries (`estimateDocumentBytes`), and a plan
   * above a tenth of this is never cached.
   */
  public static readonly MAX_COMPILED_BYTES = 32 * 1024 * 1024;

  private readonly compiledQueries: CompiledQueryCache;

  constructor(config: ExecutorConfig) {
    this.schema = config.schema;
    this.rootValue = config.rootValue;
    // `maxDepth` and `maxIntrospectionDepth` are only overridden when the
    // executor was configured with them, so the `parseOptions` values are not
    // clobbered. Resolved here (not per parse) so the fingerprint below covers
    // exactly what parsing will use.
    let parseOptions = config.parseOptions ?? {};
    if (config.maxDepth !== undefined) {
      parseOptions = { ...parseOptions, maxDepth: config.maxDepth };
    }
    if (config.maxIntrospectionDepth !== undefined) {
      parseOptions = { ...parseOptions, maxIntrospectionDepth: config.maxIntrospectionDepth };
    }
    this.parseOptions = parseOptions;
    // Ensure complexity is calculated whenever a complexity limit is set,
    // otherwise `maxComplexity` would be silently ignored.
    this.compilerOptions =
      config.maxComplexity !== undefined && !config.compilerOptions?.calculateComplexity
        ? { ...config.compilerOptions, calculateComplexity: true }
        : config.compilerOptions;
    // When introspection is disabled, validate with the spec rules plus
    // graphql-js's rule rejecting __schema/__type selections.
    this.validationRules =
      (config.introspection ?? true)
        ? undefined
        : [...specifiedRules, NoSchemaIntrospectionCustomRule];
    // Computed once: a cache entry is only reusable by an executor with the
    // same schema, the same validation rules AND the same parser options.
    // `printSchema` is memoised per schema instance because it dominates this.
    this.validationFingerprint = new Bun.CryptoHasher('sha256')
      .update(
        [
          printSchemaOnce(config.schema),
          this.validationRules ? 'no-introspection' : 'default',
          stableStringify(this.parseOptions),
        ].join('|')
      )
      .digest('hex');
    this.maxComplexity = config.maxComplexity;
    this.hooks = config.hooks;
    this.metricsEnabled = config.metrics ?? false;
    this.serializeExecutionError =
      config.formatExecutionError ?? ((error: GraphQLError) => error.toJSON());
    this.compiledQueries = new CompiledQueryCache(
      LeavenExecutor.MAX_COMPILED_QUERIES,
      LeavenExecutor.MAX_COMPILED_BYTES
    );

    // Initialize cache
    if (config.cache === false) {
      this.cache = null;
    } else if (config.cache === true || config.cache === undefined) {
      this.cache = new DocumentCache();
    } else if (this.isCustomCache(config.cache)) {
      // Custom cache implementation (e.g., Redis)
      this.cache = config.cache;
    } else {
      // DocumentCacheConfig
      this.cache = new DocumentCache(config.cache);
    }
  }

  /**
   * Check if a value is a custom cache implementation
   */
  private isCustomCache(cache: unknown): cache is IDocumentCache {
    return (
      typeof cache === 'object' &&
      cache !== null &&
      'get' in cache &&
      'set' in cache &&
      'getWithValidation' in cache
    );
  }

  /**
   * Generate the compiled-query cache key for a query and operation name.
   *
   * Keyed by the full strings, never by a hash: a 64-bit hash collision would
   * let an expensive query reuse a cheap query's compiled plan and complexity
   * verdict, bypassing `maxComplexity`. The operation name is length-prefixed
   * so that no two (query, operationName) pairs can produce the same key.
   */
  private getCacheKey(query: string, operationName?: string): string {
    const name = operationName ?? '';
    return `${operationName === undefined ? '-' : name.length}:${name}\x00${query}`;
  }

  /**
   * Namespace a query string with this executor's parse-and-validate identity
   * before it reaches the document cache.
   *
   * A cache hit skips BOTH parsing and validation, so the entry is only
   * meaningful for the exact configuration that produced it. Without this
   * namespace, two executors sharing one cache (the default Redis prefix is
   * shared, so this is the normal deployment) would serve each other's
   * entries, defeating three separate controls:
   *
   * - a query validated by an executor with introspection ENABLED would be
   *   served unvalidated by one with `introspection: false`, disclosing the
   *   whole schema;
   * - a document validated against schema A would execute unvalidated against
   *   schema B;
   * - a document parsed under `maxDepth: 100` would be served from cache to an
   *   executor configured with `maxDepth: 1`, whose depth check never re-runs
   *   because the document is never re-parsed — silently disabling the depth
   *   DoS control. The same goes for `maxIntrospectionDepth`.
   *
   * The fingerprint therefore covers the schema, the validation rules and the
   * parser options (`maxDepth`, `maxIntrospectionDepth`, `maxTokens`,
   * `graphqlOptions`).
   */
  private cacheKeyFor(query: string): string {
    return `${this.validationFingerprint}\x00${query}`;
  }

  /**
   * Report a background cache failure via the optional onCacheError hook.
   * Cache failures never fail the request, and neither may the hook itself.
   */
  private handleCacheError(error: unknown): void {
    const hook = this.hooks?.onCacheError;
    if (!hook) return;
    try {
      const result = hook(error instanceof Error ? error : new Error(String(error)));
      if (result instanceof Promise) {
        result.catch(() => {
          // The cache error hook itself must never fail the request
        });
      }
    } catch {
      // The cache error hook itself must never fail the request
    }
  }

  /**
   * Parse a GraphQL query, reusing the cached document when one exists.
   *
   * Nothing is written back here: a cold parse defers its cache write until
   * validation and the complexity budget have both passed, so only admitted
   * documents are stored, and the document and its verdict land in a single
   * {@link IDocumentCache.setWithValidation} call. See
   * {@link LeavenExecutor.cacheDocument}.
   *
   * Supports both sync and async cache implementations.
   */
  private async parseQuery(
    query: string,
    cacheKey: string
  ): Promise<{
    document: DocumentNode;
    cached: boolean;
    cachedValidation?: CachedValidation;
  }> {
    // Check cache first
    if (this.cache) {
      const cached = await resolveValue(this.cache.getWithValidation(cacheKey));
      if (cached) {
        return {
          document: cached.document,
          cached: true,
          cachedValidation: cached.validation,
        };
      }
    }

    // `this.parseOptions` already has any configured `maxDepth` folded in, and
    // is part of the cache-key fingerprint, so a cached document can never
    // have been parsed under different limits than the ones in force here.
    return { document: parseDocument(query, this.parseOptions), cached: false };
  }

  /**
   * Persist a freshly validated document.
   *
   * A cold query writes the document and its verdict in ONE operation: going
   * through `set()` then `setValidation()` makes Redis re-read the entry and
   * re-serialize the `DocumentNode` already in hand, turning every cold query
   * on the request path into SET + GET + TTL + SET.
   *
   * Writes are fire-and-forget: a cache failure never fails the request, it is
   * reported through the `onCacheError` hook.
   */
  private cacheDocument(
    cacheKey: string,
    document: DocumentNode,
    validation: ValidationResult,
    documentAlreadyCached: boolean
  ): void {
    if (!this.cache) return;

    try {
      const result = documentAlreadyCached
        ? this.cache.setValidation(cacheKey, validation)
        : this.cache.setWithValidation(cacheKey, document, validation);
      // Don't await - allow execution to continue while caching
      if (result instanceof Promise) {
        result.catch((error) => this.handleCacheError(error));
      }
    } catch (error) {
      this.handleCacheError(error);
    }
  }

  /**
   * Get or compile a query.
   *
   * Only called when {@link LeavenExecutor.compilerOptions} is set.
   */
  private getCompiledQuery(
    query: string,
    document: DocumentNode,
    operationName?: string
  ): { compiled: CompiledQuery; cached: boolean; admit?: () => void } {
    // Resolve the operation BEFORE building a key. The operation name is
    // client-chosen: keyed on it unchecked, every request with a fresh bogus
    // name would mint a new entry. A name the document lacks (or an
    // ambiguous selection) has no key and is left to compileQuery to reject.
    const operation = getOperationAST(document, operationName);
    if (!operation) {
      return {
        compiled: compileQuery(this.schema, document, operationName, this.compilerOptions),
        cached: false,
      };
    }

    // Key by the raw query string (already in hand) rather than
    // re-serializing the AST, and by the name of the operation actually
    // selected, so naming it explicitly or implicitly shares one entry.
    const key = this.getCacheKey(query, operation.name?.value);

    const cached = this.compiledQueries.get(key);
    if (cached) {
      return { compiled: cached, cached: true };
    }

    const compiled = compileQuery(
      this.schema,
      document,
      operationName,
      this.compilerOptions
    );

    // Not stored yet: the caller admits the plan only once it has passed the
    // complexity budget, so a rejected query never occupies (or evicts) a slot.
    const admit = (): void => {
      this.compiledQueries.set(key, query, compiled);
    };
    return { compiled, cached: false, admit };
  }

  /**
   * Shared front half of every operation: parse, validate, compile and check
   * the complexity budget, running the lifecycle hooks and filling in the
   * metric counters along the way.
   *
   * Both {@link LeavenExecutor.execute} and {@link LeavenExecutor.subscribe}
   * run it, so a subscription is subject to exactly the same limits and
   * observability as a query. Subscriptions are the longest-lived operations,
   * which makes an unenforced complexity budget there the worst place for a
   * gap.
   *
   * A rejected document comes back as `{ errors }`. Parse-level failures
   * (syntax, `maxTokens`, depth limit, analysis budget), hook throws and
   * document cache failures throw, and both callers wrap this in the same
   * try/catch. Nothing here runs a resolver, so every throw out of it is a
   * pre-execution rejection (see {@link isRequestRejection}).
   */
  private async runPipeline(
    request: GraphQLRequest,
    telemetry: PipelineTelemetry
  ): Promise<PipelineOutcome> {
    const cacheKey = this.cacheKeyFor(request.query);

    // Parse (with cached validation if available)
    const parseStart = this.metricsEnabled ? performance.now() : 0;

    // Only call hooks if they exist
    if (this.hooks?.onParse) {
      await this.hooks.onParse(request.query);
    }

    const parsed = await this.parseQuery(request.query, cacheKey);
    const { document, cachedValidation } = parsed;
    telemetry.documentCached = parsed.cached;

    if (this.metricsEnabled) {
      telemetry.parseTime = performance.now() - parseStart;
    }

    if (this.hooks?.onParsed) {
      await this.hooks.onParsed(document);
    }

    // Validate (skip if we have cached validation)
    const validateStart = this.metricsEnabled ? performance.now() : 0;
    let validation: ValidationResult;

    if (cachedValidation) {
      // Use cached validation result
      validation = cachedValidation;
      telemetry.validationCached = true;
    } else {
      if (this.hooks?.onValidate) {
        await this.hooks.onValidate(document);
      }
      validation = validateDocument(
        this.schema,
        document,
        this.validationRules ? { rules: this.validationRules } : undefined
      );
    }

    if (this.metricsEnabled) {
      telemetry.validationTime = performance.now() - validateStart;
    }

    if (this.hooks?.onValidated) {
      await this.hooks.onValidated(validation);
    }

    if (!validation.valid) {
      return {
        errors: validation.errors.map((e) =>
          withErrorCode(e, ErrorCode.VALIDATION_ERROR).toJSON()
        ),
      };
    }

    // Validation does not look at `operationName`, so an unknown name, or a
    // missing one for a multi-operation document, gets this far. Both are
    // client mistakes: reject them here as BAD_REQUEST, on every path (the
    // compiler and graphql-js would otherwise report them as an uncoded or
    // INTERNAL_ERROR failure, which a masking transport hides as a 500).
    if (!getOperationAST(document, request.operationName)) {
      return {
        errors: [
          operationSelectionError(document, request.operationName).toGraphQLError().toJSON(),
        ],
      };
    }

    // Check complexity if compiler is enabled. The compiled plan is only
    // stored once it is known to be within budget (see below).
    let admitCompiled: (() => void) | undefined;
    if (this.compilerOptions) {
      const { compiled, cached, admit } = this.getCompiledQuery(
        request.query,
        document,
        request.operationName
      );
      admitCompiled = admit;
      telemetry.queryCached = cached;
      if (this.compilerOptions.calculateComplexity) {
        telemetry.complexity = compiled.complexity;
      }

      // `!== undefined`, not truthiness: `maxComplexity: 0` is a configured
      // limit meaning "reject everything", and it must agree with the
      // constructor, which already treats 0 as configured.
      if (
        this.maxComplexity !== undefined &&
        compiled.complexity > this.maxComplexity
      ) {
        // Routed through ComplexityError so the rejection carries
        // `extensions.code = COMPLEXITY_LIMIT` (and the limits themselves),
        // matching the depth path. A bare `{ message }` has no code for the
        // HTTP layer to map, so it falls through to a 500.
        return {
          errors: [
            new ComplexityError(compiled.complexity, this.maxComplexity)
              .toGraphQLError()
              .toJSON(),
          ],
        };
      }
    }

    // Only now, with validation, the depth limit (enforced at parse time) and
    // the complexity budget all passed, may anything be cached. Caching
    // earlier would let a client fill either cache with rejected queries
    // (evicting real entries, or growing a shared Redis without bound) at no
    // cost beyond a failed request.
    admitCompiled?.();
    if (!cachedValidation) {
      this.cacheDocument(cacheKey, document, validation, parsed.cached);
    }

    return { document };
  }

  /**
   * Execute a GraphQL request
   */
  public async execute<TData = Record<string, unknown>, TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext
  ): Promise<ExecutionResult<TData>> {
    const startTime = this.metricsEnabled ? performance.now() : 0;
    const telemetry: PipelineTelemetry = {
      parseTime: 0,
      validationTime: 0,
      documentCached: false,
      validationCached: false,
      queryCached: false,
    };

    // Build metrics from the tracked counters so every return path reports
    // the same, consistent shape.
    const buildMetrics = (executionTime?: number): ExecutionMetrics => {
      const metrics: ExecutionMetrics = {
        timing: {
          parseTime: telemetry.parseTime,
          validationTime: telemetry.validationTime,
          totalTime: performance.now() - startTime,
        },
        documentCached: telemetry.documentCached,
        validationCached: telemetry.validationCached,
        queryCached: telemetry.queryCached,
      };
      if (executionTime !== undefined) {
        metrics.timing.executionTime = executionTime;
      }
      if (telemetry.complexity !== undefined) {
        metrics.complexity = telemetry.complexity;
      }
      return metrics;
    };

    // Set just before onExecute: a throw caught while it is false happened
    // before any resolver could run, so the response is a request rejection.
    let executionStarted = false;

    try {
      const prepared = await this.runPipeline(request, telemetry);

      if (prepared.errors) {
        return {
          response: markRejection({ errors: prepared.errors }),
          metrics: this.metricsEnabled ? buildMetrics() : undefined,
        };
      }

      const { document } = prepared;

      // Execute
      const executeStart = this.metricsEnabled ? performance.now() : 0;

      executionStarted = true;
      if (this.hooks?.onExecute) {
        await this.hooks.onExecute(context as TContext, document);
      }

      const result = await execute({
        schema: this.schema,
        document,
        rootValue: this.rootValue,
        contextValue: context,
        variableValues: request.variables,
        operationName: request.operationName,
      });

      const executionTime = this.metricsEnabled ? performance.now() - executeStart : 0;

      const response: GraphQLResponse<TData> = {
        data: result.data as TData | undefined,
        errors: result.errors?.map((e) =>
          this.serializeExecutionError(LeavenExecutor.codeRequestError(e, result.data))
        ),
      };

      // graphql-js leaves `data` out only when it could not start execution
      // (a variable that fails to coerce): no resolver ran.
      if (result.data === undefined) {
        markRejection(response);
      }

      if (this.hooks?.onExecuted) {
        await this.hooks.onExecuted(response as GraphQLResponse);
      }

      return {
        response,
        metrics: this.metricsEnabled ? buildMetrics(executionTime) : undefined,
      };
    } catch (error) {
      await this.reportError(error);

      const response: GraphQLResponse<TData> = {
        errors: [this.formatCaughtError(error)],
      };
      if (!executionStarted) {
        markRejection(response);
      }
      return {
        response,
        metrics: this.metricsEnabled ? buildMetrics() : undefined,
      };
    }
  }

  /**
   * Run the onError hook without letting it fail the request.
   *
   * It is called from the executor's catch blocks, which must still return
   * the original error as a response: a throwing or rejecting hook is
   * ignored, as a throwing onCacheError hook is.
   */
  private async reportError(error: unknown): Promise<void> {
    if (!this.hooks?.onError) {
      return;
    }
    try {
      await this.hooks.onError(error as Error);
    } catch {
      // The error hook itself must never fail the request
    }
  }

  /**
   * Give a graphql-js *request* error the client code `BAD_REQUEST`.
   *
   * graphql-js reports a request it cannot start (in practice a variable that
   * fails to coerce, since operation selection is checked earlier) as errors
   * with no `data` and no `path`, and with no code. Those are client mistakes;
   * an error with a `path` (a subscribe resolver that threw) is not, and is
   * left as it is. Applied before `formatExecutionError`, which still gets the
   * last word.
   */
  private static codeRequestError(error: GraphQLError, data: unknown): GraphQLError {
    return data === undefined && error.path === undefined
      ? withErrorCode(error, ErrorCode.BAD_REQUEST)
      : error;
  }

  /**
   * Convert a caught error into a GraphQL formatted error, preserving the
   * error's own `extensions` so downstream formatters keep everything the
   * error carried — a `RateLimitError`'s `retryAfter`, a `ValidationError`'s
   * field details, a `ComplexityError`'s limits — not just a code.
   *
   * `LeavenError` extends `Error`, NOT `GraphQLError`, so it must be
   * converted through the errors package; an `instanceof GraphQLError` check
   * alone never matches Leaven's own error classes. Anything else falls back
   * to `INTERNAL_ERROR`, so every formatted error carries an `ErrorCode`.
   */
  private formatCaughtError(error: unknown): GraphQLFormattedError {
    if (isLeavenError(error)) {
      return error.toGraphQLError().toJSON();
    }

    if (error instanceof GraphQLError) {
      return error.toJSON();
    }

    return {
      message: error instanceof Error ? error.message : 'Internal server error',
      extensions: { code: ErrorCode.INTERNAL_ERROR },
    };
  }

  /**
   * Execute a subscription.
   *
   * Runs the same parse/validate/compile/complexity pipeline and the same
   * lifecycle hooks as {@link LeavenExecutor.execute}, so `maxDepth`,
   * `maxComplexity` and `hooks` apply here too. `onExecuted` is the one
   * exception: a subscription yields a stream, not a single response.
   *
   * NEVER throws. Every failure — a syntax error, a `maxTokens` or depth-limit
   * rejection, an exceeded analysis budget, a throwing hook — comes back as a
   * `GraphQLResponse` carrying `errors`, so a caller branching on
   * `Symbol.asyncIterator in result` is never handed an unhandled rejection.
   */
  public async subscribe<TData = Record<string, unknown>, TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext
  ): Promise<SubscriptionIterator<TData> | GraphQLResponse<TData>> {
    // Collected for the hooks' sake; a subscription's return type has nowhere
    // to report an ExecutionMetrics object.
    const telemetry: PipelineTelemetry = {
      parseTime: 0,
      validationTime: 0,
      documentCached: false,
      validationCached: false,
      queryCached: false,
    };

    // Set just before onExecute: a throw caught while it is false happened
    // before any resolver could run, so the response is a request rejection.
    let executionStarted = false;

    try {
      const prepared = await this.runPipeline(request, telemetry);

      if (prepared.errors) {
        return markRejection({ errors: prepared.errors });
      }

      const { document } = prepared;

      executionStarted = true;
      if (this.hooks?.onExecute) {
        await this.hooks.onExecute(context as TContext, document);
      }

      const result = await subscribe({
        schema: this.schema,
        document,
        rootValue: this.rootValue,
        contextValue: context,
        variableValues: request.variables,
        operationName: request.operationName,
      });

      const serializeError = this.serializeExecutionError;

      // If it's an error result (not an async iterable), return it as a response
      if (!(Symbol.asyncIterator in result)) {
        const errors = (result as GraphQLExecutionResult).errors ?? [];
        const response: GraphQLResponse<TData> = {
          errors: errors.map((e) => serializeError(LeavenExecutor.codeRequestError(e, undefined))),
        };
        // graphql-js locates every subscribe-resolver error at the field's
        // path; only errors raised before that resolver ran have none.
        if (errors.every((e) => e.path === undefined)) {
          markRejection(response);
        }
        return response;
      }

      // Transform the async iterator to match our response type
      const iterator = result as AsyncIterableIterator<GraphQLExecutionResult>;

      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<GraphQLResponse<TData>>> {
          const { value, done } = await iterator.next();
          if (done) {
            return { value: undefined, done: true };
          }
          return {
            value: {
              data: value.data as TData | undefined,
              errors: value.errors?.map((e) => serializeError(e)),
            },
            done: false,
          };
        },
        async return(): Promise<IteratorResult<GraphQLResponse<TData>>> {
          if (iterator.return) {
            await iterator.return();
          }
          return { value: undefined, done: true };
        },
        async throw(error: unknown): Promise<IteratorResult<GraphQLResponse<TData>>> {
          if (iterator.throw) {
            await iterator.throw(error);
          }
          return { value: undefined, done: true };
        },
      } as SubscriptionIterator<TData>;
    } catch (error) {
      await this.reportError(error);

      const response: GraphQLResponse<TData> = { errors: [this.formatCaughtError(error)] };
      if (!executionStarted) {
        markRejection(response);
      }
      return response;
    }
  }

  /**
   * Get cache statistics
   * Returns a promise for async cache implementations (e.g., Redis)
   */
  public async getCacheStats(): Promise<{
    document: Awaited<ReturnType<IDocumentCache['getStats']>> | null;
    compiled: { size: number; maxSize: number; bytes: number; maxBytes: number };
  }> {
    const documentStats = this.cache ? await resolveValue(this.cache.getStats()) : null;
    return {
      document: documentStats,
      compiled: {
        size: this.compiledQueries.size,
        maxSize: this.compiledQueries.maxSize,
        bytes: this.compiledQueries.bytes,
        maxBytes: this.compiledQueries.maxBytes,
      },
    };
  }

  /**
   * Clear all caches
   * Returns a promise for async cache implementations (e.g., Redis)
   */
  public async clearCaches(): Promise<void> {
    if (this.cache) {
      await resolveValue(this.cache.clear());
    }
    this.compiledQueries.clear();
  }

  /**
   * Get the schema
   */
  public getSchema(): GraphQLSchema {
    return this.schema;
  }

  /**
   * Parse a query under this executor's parser limits (`maxTokens`,
   * `maxDepth`, `graphqlOptions`), reusing a cached document when one exists.
   *
   * For transports that must inspect a document before handing the request
   * to {@link LeavenExecutor.execute} or {@link LeavenExecutor.subscribe}
   * (for example to pick between them). A plain graphql-js `parse()` there
   * would run without the limits and undo the parser's DoS protection.
   * Nothing is written to the cache: only validated documents are cached.
   *
   * Throws on a syntax error or an exceeded limit.
   */
  public async parse(query: string): Promise<DocumentNode> {
    if (this.cache) {
      const cached = await resolveValue(this.cache.get(this.cacheKeyFor(query)));
      if (cached) {
        return cached;
      }
    }
    return parseDocument(query, this.parseOptions);
  }
}

/**
 * Create a new Leaven executor
 */
export function createExecutor(config: ExecutorConfig): LeavenExecutor {
  return new LeavenExecutor(config);
}
