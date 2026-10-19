/**
 * @leaven-graphql/nestjs - `@nestjs/graphql` driver backed by Leaven
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { AbstractGraphQLDriver } from '@nestjs/graphql';
import type { GqlModuleOptions } from '@nestjs/graphql';
import type { GraphQLError, GraphQLFormattedError } from 'graphql';
import { LeavenExecutor, type ExecutorConfig } from '@leaven-graphql/core';
import {
  ErrorCode,
  maskedErrorFor,
  formatError,
  getErrorCode,
  isLeavenError,
  LeavenError,
  statusForResponse,
} from '@leaven-graphql/errors';
import { renderGraphiQL } from '@leaven-graphql/playground';

import { filterAsyncIterator } from './decorators';
import { DEFAULT_MAX_TOKENS } from './driver';
import { httpExceptionCode, normalizeHttpException } from './http-exception';
import {
  csrfBlockedError,
  DEFAULT_BODY_READ_TIMEOUT_MS,
  DEFAULT_MAX_BODY_SIZE,
  isCsrfBlocked,
  mediaType,
  readHeader,
  readBodyText,
  resolveCsrfRequestHeaders,
  validateGraphQLBody,
  type BodySource,
} from './request-body';
import type { CSRFPreventionOptions } from './types';

/**
 * Minimal Express-shaped request, as produced by the NestJS HTTP adapter.
 *
 * Deliberately structural rather than imported: the driver must work behind
 * any `AbstractHttpAdapter` (Express, Fastify's compat layer, or
 * `@lexmata/nestjs-platform-bun`'s `BunAdapter`), none of which share a type.
 */
interface AdapterRequest {
  method?: string;
  url?: string;
  originalUrl?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  /**
   * The underlying Fetch `Request`, when the adapter exposes one. Read through
   * the bounded body reader, never with an unbounded `json()`. Some adapters
   * put a Node `IncomingMessage` here instead; see {@link fetchRawOf}.
   */
  raw?: BodySource | { headers?: unknown };
}

/**
 * `req.raw` when it is Fetch-shaped (a `headers.get` function), otherwise
 * `undefined`, so a Node `IncomingMessage` (plain-object headers) falls back
 * to the adapter's header map and parsed body instead of throwing.
 */
function fetchRawOf(req: AdapterRequest): BodySource | undefined {
  const raw = req.raw as { headers?: { get?: unknown } } | undefined;
  return typeof raw?.headers?.get === 'function' ? (raw as BodySource) : undefined;
}

/**
 * Minimal Express-shaped response, as produced by the NestJS HTTP adapter.
 */
interface AdapterResponse {
  status(code: number): AdapterResponse;
  json(body: unknown): unknown;
  send(body?: unknown): unknown;
  setHeader(name: string, value: string): unknown;
}

/**
 * Configuration for {@link LeavenGraphQLDriver}.
 *
 * Everything `@nestjs/graphql` understands is accepted unchanged — including
 * `autoSchemaFile`, `typeDefs`, `path`, `context` and `useGlobalPrefix` — and
 * the Leaven-specific options below are forwarded to the executor that serves
 * the finished schema.
 */
export interface LeavenDriverConfig extends GqlModuleOptions {
  /** Document/validation cache configuration passed to the executor. */
  cache?: ExecutorConfig['cache'];
  /** Collect per-operation metrics and expose them under `extensions.metrics`. */
  metrics?: boolean;
  /**
   * Maximum allowed query complexity. Enforced by the executor itself, which
   * rejects an over-budget document before any resolver runs.
   */
  maxComplexity?: number;
  /** Maximum allowed query depth. Enforced by the executor at parse time. */
  maxDepth?: number;
  /**
   * Parser limits passed to the executor, in the core executor's
   * `parseOptions` shape. `maxTokens` defaults to 10000; set it to
   * `Infinity` to opt out.
   */
  parseOptions?: ExecutorConfig['parseOptions'];
  /** Serve GraphiQL on `GET <path>`. Defaults to `false`. */
  playground?: boolean;
  /** WebSocket endpoint advertised to GraphiQL, when subscriptions are served. */
  subscriptionEndpoint?: string;
  /** Final transformation applied to every error in the response. */
  formatError?: (error: GraphQLFormattedError) => GraphQLFormattedError;
  /**
   * Include stack traces in error responses. Setting this also disables
   * production masking, since a masked error carries no stack to include.
   */
  includeStacktraceInErrorResponses?: boolean;
  /**
   * Maximum size, in bytes, of a body read from the raw Fetch `Request` when
   * the adapter hands over no parsed body. An honest `Content-Length` over it
   * is rejected unread, and it is also enforced on the bytes read. Over the
   * limit the request is answered `413 PAYLOAD_TOO_LARGE`. A body your
   * framework's body parser already parsed is not re-measured: set the limit
   * on that parser too.
   *
   * @default 1_000_000
   */
  maxBodySize?: number;
  /**
   * Deadline, in milliseconds, for reading a body from the raw Fetch
   * `Request`. A read that misses it is cancelled and answered
   * `400 BAD_REQUEST`. `Infinity` or `0` means no deadline (as does any
   * non-finite or non-positive value), and a value over 2^31-1 is clamped
   * to it, the longest delay a timer honours.
   *
   * @default 30_000
   */
  bodyReadTimeoutMs?: number;
  /**
   * CSRF prevention (default: on). A POST whose Content-Type is missing or
   * CORS-safelisted (`text/plain`, `application/x-www-form-urlencoded`,
   * `multipart/form-data`) is refused with a 400 `BAD_REQUEST` before the
   * context is built or any resolver runs, unless it carries a non-empty
   * preflight-forcing header (default: `x-graphql-csrf`,
   * `apollo-require-preflight`, `x-apollo-operation-name`). This holds
   * whatever the adapter's body parser made of the body: NestJS's Express
   * adapter parses form bodies by default, so a cross-site HTML form POST
   * would otherwise arrive as an object and run. `false` disables the check.
   *
   * Configured header names are trimmed and lowercased; one that is not a
   * valid header token makes `start()` throw a `TypeError`.
   *
   * @default true
   */
  csrfPrevention?: boolean | CSRFPreventionOptions;
}

/**
 * A `@nestjs/graphql` driver that executes with Leaven.
 *
 * ## Why this class is the bridge
 *
 * `GraphQLModule.onModuleInit` calls `generateSchema()` before `start()`.
 * `generateSchema()` is inherited from {@link AbstractGraphQLDriver} and
 * delegates to `GraphQLFactory`, which builds the schema from your
 * `@Resolver()` classes with NestJS's `ExternalContextCreator` wrapped around
 * every field resolver. That wrapper is what runs guards, interceptors, pipes,
 * filters and parameter decorators. By the time `start()` receives
 * `options.schema`, the NestJS execution pipeline is already baked into it —
 * this driver only has to execute that schema and serve it over HTTP.
 *
 * This is the opposite of `LeavenModule.forRoot({ typeDefs, resolvers })`,
 * where resolvers are plain functions invoked directly by graphql-js and the
 * NestJS pipeline never runs.
 *
 * @example
 * ```typescript
 * @Module({
 *   imports: [
 *     GraphQLModule.forRoot<LeavenDriverConfig>({
 *       driver: LeavenGraphQLDriver,
 *       autoSchemaFile: true,
 *       playground: true,
 *       cache: { maxSize: 1000 },
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
export class LeavenGraphQLDriver extends AbstractGraphQLDriver<LeavenDriverConfig> {
  private executor: LeavenExecutor | null = null;
  private options: LeavenDriverConfig | null = null;
  /**
   * Header names that satisfy CSRF prevention, or `undefined` when
   * `csrfPrevention` is `false`. Resolved (and validated) in `start()`.
   */
  private csrfRequestHeaders: readonly string[] | undefined;

  /**
   * Serve the schema `@nestjs/graphql` has already built.
   *
   * Registers a POST handler for GraphQL operations and, when `playground` is
   * enabled, a GET handler rendering GraphiQL — both at the module's
   * normalized path.
   */
  public async start(options: LeavenDriverConfig): Promise<void> {
    if (!options.schema) {
      throw new Error(
        'LeavenGraphQLDriver: no schema was provided to start(). This is normally supplied by GraphQLModule.'
      );
    }

    this.csrfRequestHeaders = resolveCsrfRequestHeaders(options.csrfPrevention);
    this.options = options;
    this.executor = new LeavenExecutor({
      schema: options.schema,
      cache: options.cache,
      metrics: options.metrics,
      maxComplexity: options.maxComplexity,
      maxDepth: options.maxDepth,
      parseOptions: {
        ...options.parseOptions,
        maxTokens: options.parseOptions?.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
      introspection: options.introspection ?? process.env.NODE_ENV !== 'production',
      formatExecutionError: LeavenGraphQLDriver.formatExecutionError,
    });

    const path = this.getNormalizedPath(options);
    const httpAdapter = this.httpAdapterHost.httpAdapter;

    httpAdapter.post(path, (req: AdapterRequest, res: AdapterResponse) =>
      this.handleOperation(req, res)
    );

    if (options.playground) {
      httpAdapter.get(path, (_req: AdapterRequest, res: AdapterResponse) => {
        this.servePlayground(res, path);
      });
    }
  }

  /**
   * Release the executor.
   *
   * `clearCaches()` is genuinely asynchronous for a remote cache (a Redis
   * `FLUSH`), so it is awaited: dropping the promise would leave the clear
   * unfinished and turn a rejecting cache into an unhandled rejection during
   * shutdown.
   */
  public async stop(): Promise<void> {
    if (this.executor) {
      await this.executor.clearCaches();
      this.executor = null;
    }
  }

  /**
   * The executor currently serving requests, or `null` before `start()` and
   * after `stop()`.
   */
  public getExecutor(): LeavenExecutor | null {
    return this.executor;
  }

  /**
   * Apply the `filter` option of `@nestjs/graphql`'s `@Subscription`.
   *
   * `@nestjs/graphql` delegates that option to the driver, and the base
   * `AbstractGraphQLDriver` implementation discards it, so without this
   * override every subscriber would receive every event. The filter is called
   * with the resolver instance as `this` and `(payload, variables, context, info)`,
   * as on the Apollo and Mercurius drivers. Filtering goes through
   * `filterAsyncIterator`, which forwards cancellation straight to the source
   * stream.
   */
  public override subscriptionWithFilter(
    instanceRef: unknown,
    filterFn: (payload: unknown, variables: unknown, context: unknown) => boolean | Promise<boolean>,
    createSubscribeContext: () => (...args: unknown[]) => unknown
  ): (...args: unknown[]) => Promise<AsyncIterableIterator<unknown>> {
    return async (...args: unknown[]) => {
      const source = (await createSubscribeContext()(...args)) as AsyncIterable<unknown>;
      // Hand a non-iterable back untouched so graphql-js reports its usual
      // "must return Async Iterable" error at subscribe time, not mid-stream.
      if (!(Symbol.asyncIterator in Object(source))) {
        return source as never;
      }
      return filterAsyncIterator(source, (payload) =>
        (filterFn as (...a: unknown[]) => boolean | Promise<boolean>).call(
          instanceRef,
          payload,
          ...args.slice(1)
        )
      );
    };
  }

  /**
   * Execute one GraphQL operation and write the HTTP response.
   */
  private async handleOperation(
    req: AdapterRequest,
    res: AdapterResponse
  ): Promise<void> {
    if (!this.executor) {
      res.status(503).json({
        errors: [
          {
            message: 'GraphQL server is not running',
            extensions: { code: ErrorCode.INTERNAL_ERROR },
          },
        ],
      });
      return;
    }

    // CSRF prevention runs before the body is read or the context is built,
    // whatever shape the adapter's body parser left `req.body` in.
    if (
      this.csrfRequestHeaders !== undefined &&
      isCsrfBlocked(
        LeavenGraphQLDriver.contentTypeOf(req),
        (name) => readHeader(req.headers, name) ?? fetchRawOf(req)?.headers.get(name),
        this.csrfRequestHeaders
      )
    ) {
      const error = csrfBlockedError();
      this.respond(res, { errors: [this.formatThrownError(error)] }, error.statusCode);
      return;
    }

    let body: unknown;
    try {
      body = await LeavenGraphQLDriver.readBody(
        req,
        this.options?.maxBodySize ?? DEFAULT_MAX_BODY_SIZE,
        this.options?.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS
      );
    } catch (error) {
      // A 413 or a failed or timed-out read is already a coded LeavenError
      // with its own status; only a JSON syntax error is "malformed".
      // Its own statusCode wins: a 415 is coded BAD_REQUEST, which
      // ERROR_CODES alone would answer with 400.
      if (isLeavenError(error)) {
        this.respond(res, { errors: [this.formatThrownError(error)] }, error.statusCode);
        return;
      }
      this.respond(res, {
        errors: [
          {
            message: 'Malformed request body: expected JSON',
            extensions: { code: ErrorCode.BAD_REQUEST },
          },
        ],
      });
      return;
    }

    try {
      // Validated inside the try so the `ValidationError` for a non-object
      // body (JSON `null`, say), a missing or non-string query, non-object
      // variables or a non-string operationName reaches the client as a coded
      // 400 through `formatThrownError`.
      const operation = validateGraphQLBody(body);

      // A context factory that throws (an `AuthenticationError` for a bad
      // token, say) must likewise reach the client as a coded error with its
      // own status, not as an unhandled rejection.
      const context = await this.buildContext(req, res);
      const result = await this.executor.execute(operation, context);

      const extensions =
        this.options?.metrics && result.metrics
          ? { ...result.response.extensions, metrics: result.metrics }
          : result.response.extensions;

      this.respond(res, {
        data: result.response.data as Record<string, unknown> | null | undefined,
        errors: result.response.errors,
        extensions,
      });
    } catch (thrown) {
      // A LeavenError carries its own status (a 409 BAD_REQUEST, say), which
      // `ERROR_CODES` cannot recover from the code alone. A NestJS
      // `HttpException` (from a context factory, say) is normalised first so
      // it gets its own status too.
      const error = normalizeHttpException(thrown);
      this.respond(
        res,
        { errors: [this.formatThrownError(error)] },
        isLeavenError(error) ? error.statusCode : undefined
      );
    }
  }

  /**
   * Render GraphiQL.
   */
  private servePlayground(res: AdapterResponse, path: string): void {
    const html = renderGraphiQL({
      endpoint: path,
      subscriptionEndpoint: this.options?.subscriptionEndpoint,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  /**
   * Build the GraphQL context for one request.
   *
   * `req`/`res` are always present so guards and resolvers can reach the
   * transport objects (this is what makes `ctx.req.user` work under Passport);
   * a configured `context` factory or object is merged over them.
   */
  private async buildContext(
    req: AdapterRequest,
    res: AdapterResponse
  ): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> = { req, res };
    const factory: unknown = this.options?.context;

    if (typeof factory === 'function') {
      const produced = (await (
        factory as (ctx: Record<string, unknown>) => unknown
      )(base)) as Record<string, unknown> | undefined;
      return { ...base, ...produced };
    }

    if (factory && typeof factory === 'object') {
      return { ...base, ...(factory as Record<string, unknown>) };
    }

    return base;
  }

  /**
   * Write a GraphQL response with the status the error-handling conventions
   * require.
   *
   * A response with non-null `data` is a spec-conformant partial success and
   * stays 200 whatever the error codes say — anything else makes clients treat
   * it as a network failure and discard data they were given. Only a total
   * failure (`data` absent or `null`) derives its status from the first error's `ErrorCode`, via
   * `statusForResponse` from `@leaven-graphql/errors` — the same rule
   * `@leaven-graphql/http` and the `LeavenModule` middleware use.
   *
   * `statusOverride` is for a rejection whose status `ERROR_CODES` cannot
   * express, such as a 415 coded `BAD_REQUEST`.
   */
  private respond(
    res: AdapterResponse,
    response: {
      data?: Record<string, unknown> | null;
      errors?: readonly GraphQLFormattedError[];
      extensions?: Record<string, unknown>;
    },
    statusOverride?: number
  ): void {
    const errors = response.errors?.map((error) => this.finalizeError(error));
    const hasErrors = errors !== undefined && errors.length > 0;
    const status = statusOverride ?? statusForResponse({ data: response.data, errors });

    const body: Record<string, unknown> = {};
    if (response.data !== undefined) {
      body.data = response.data;
    }
    if (hasErrors) {
      body.errors = errors;
    }
    if (response.extensions !== undefined) {
      body.extensions = response.extensions;
    }

    res.status(status).json(body);
  }

  /**
   * Guarantee an `ErrorCode`, apply production masking, then hand the result
   * to a configured `formatError`.
   *
   * By this point {@link formatExecutionError} has already given every NestJS
   * `HttpException` its `ErrorCode`; what is left here is the residue — a
   * resolver that threw a plain `Error` — which must still be coded and, in
   * production, masked.
   *
   * The executor reports errors as already-serialised `GraphQLFormattedError`s
   * (`GraphQLError.toJSON()`), so `formatError` from `@leaven-graphql/errors`
   * — whose input is an `Error`/`GraphQLError` — cannot be reused verbatim
   * here; this reproduces its masking rule for the formatted shape. Errors
   * *thrown* out of the executor do go through it, in
   * {@link formatThrownError}.
   */
  private finalizeError(error: GraphQLFormattedError): GraphQLFormattedError {
    const rawCode = error.extensions?.code;
    const code =
      typeof rawCode === 'string' ? getErrorCode(rawCode) : null;
    const resolved = code ?? ErrorCode.INTERNAL_ERROR;

    const includeStack = this.options?.includeStacktraceInErrorResponses ?? false;
    const mask =
      resolved === ErrorCode.INTERNAL_ERROR &&
      process.env.NODE_ENV === 'production' &&
      !includeStack;

    const finalized: GraphQLFormattedError = mask
      ? maskedErrorFor(error)
      : {
          ...error,
          extensions: { ...error.extensions, code: resolved },
        };

    return this.options?.formatError
      ? this.options.formatError(finalized)
      : finalized;
  }

  /**
   * Turn an error thrown out of the executor into a response error.
   *
   * Leaven errors keep their code, extensions and message. Unexpected errors
   * are masked only in production — masking them in development would hide the
   * real message from the developer — and `includeStacktraceInErrorResponses`
   * suppresses masking outright, since a masked error carries no stack to
   * include. This matches `LeavenDriver.execute`.
   *
   * The user's `formatError` is deliberately not applied here: every caller
   * hands the result to {@link respond}, whose {@link finalizeError} applies
   * it, so the hook runs exactly once per error on every path.
   */
  private formatThrownError(thrown: unknown): GraphQLFormattedError {
    // A NestJS `HttpException` keeps its mapped code and message.
    const error = normalizeHttpException(thrown);
    const includeStack = this.options?.includeStacktraceInErrorResponses ?? false;
    return formatError(error, {
      maskErrors:
        !isLeavenError(error) &&
        process.env.NODE_ENV === 'production' &&
        !includeStack,
      includeStackTrace: includeStack,
    });
  }

  /**
   * Read the operation from the request.
   *
   * The adapter may hand over an already-parsed body, a raw string, or nothing
   * at all when no body-parser is installed; the raw Fetch `Request` is the
   * last resort, read bounded by `maxBytes` and `timeoutMs`.
   *
   * When the driver parses the body itself (a raw string, or the raw Fetch
   * `Request`), the `Content-Type` must name `application/json`. An object
   * the framework's body parser already produced is accepted as-is: by then
   * `csrfPrevention` has already refused a CORS-simple POST (a form or
   * `text/plain` body without a preflight-forcing header), whatever the
   * parser made of it.
   *
   * @throws LeavenError from the bounded read (413 or 400), a `BAD_REQUEST`
   *   with `statusCode` 415 for a missing or non-JSON `Content-Type`, or a
   *   `SyntaxError` for a body that is not JSON
   */
  private static async readBody(
    req: AdapterRequest,
    maxBytes: number,
    timeoutMs: number
  ): Promise<unknown> {
    const raw = req.body;

    if (typeof raw === 'string') {
      LeavenGraphQLDriver.assertJsonContentType(req);
      return JSON.parse(raw) as unknown;
    }

    if (raw !== null && typeof raw === 'object' && !(raw instanceof ArrayBuffer)) {
      return raw;
    }

    const fetchRaw = fetchRawOf(req);
    if (fetchRaw) {
      LeavenGraphQLDriver.assertJsonContentType(req);
      return JSON.parse(await readBodyText(fetchRaw, maxBytes, timeoutMs)) as unknown;
    }

    return {};
  }

  /**
   * Reject a body the driver would parse itself unless its `Content-Type`
   * names exactly `application/json` (parameters such as `charset` are
   * ignored), the same 415 `BAD_REQUEST` refusal `LeavenDriver.handleRequest`
   * gives an unsupported `Content-Type`.
   *
   * The type is read from the raw Fetch `Request` first, then from the
   * adapter's header map.
   *
   * @throws LeavenError coded `BAD_REQUEST` with `statusCode` 415
   */
  private static assertJsonContentType(req: AdapterRequest): void {
    if (mediaType(LeavenGraphQLDriver.contentTypeOf(req)) !== 'application/json') {
      throw new LeavenError(
        'Unsupported Content-Type: use application/json',
        ErrorCode.BAD_REQUEST,
        { statusCode: 415 }
      );
    }
  }

  /**
   * The request's raw `Content-Type`: from the raw Fetch `Request` first,
   * then from the adapter's header map.
   */
  private static contentTypeOf(req: AdapterRequest): string | null | undefined {
    return (
      fetchRawOf(req)?.headers.get('content-type') ?? readHeader(req.headers, 'content-type')
    );
  }

  /**
   * Serialize one execution error, translating a NestJS `HttpException` into
   * the equivalent {@link ErrorCode}.
   *
   * Installed as the executor's `formatExecutionError` hook, which runs while
   * the graphql-js `GraphQLError` is still intact — the only point at which
   * `originalError` is still reachable. After `toJSON()` it is gone, and an
   * `HttpException` (unlike a `LeavenError`) has no `extensions` of its own
   * for graphql-js to adopt, so the error would otherwise reach the client as
   * a bare `INTERNAL_ERROR` with a 500: a guard's `ForbiddenException` would be
   * indistinguishable from a crash.
   *
   * `message`, `path` and `locations` are preserved exactly as serialized;
   * only `extensions.code` is supplied.
   */
  private static formatExecutionError(error: GraphQLError): GraphQLFormattedError {
    const formatted = error.toJSON();
    const mapped = httpExceptionCode(error.originalError);

    if (mapped === undefined) {
      return formatted;
    }

    const { code, status } = mapped;
    return {
      ...formatted,
      extensions: { ...formatted.extensions, code, statusCode: status },
    };
  }
}
