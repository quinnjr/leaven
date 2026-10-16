/**
 * @leaven-graphql/nestjs - `@nestjs/graphql` driver backed by Leaven
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { HttpException } from '@nestjs/common';
import { AbstractGraphQLDriver } from '@nestjs/graphql';
import type { GqlModuleOptions } from '@nestjs/graphql';
import type { GraphQLError, GraphQLFormattedError } from 'graphql';
import { LeavenExecutor, type ExecutorConfig } from '@leaven-graphql/core';
import {
  ERROR_CODES,
  ErrorCode,
  formatError,
  getErrorCode,
  isLeavenError,
} from '@leaven-graphql/errors';
import { renderGraphiQL } from '@leaven-graphql/playground';

import { DEFAULT_MAX_TOKENS } from './driver';

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
  /** The underlying Fetch `Request`, when the adapter exposes one. */
  raw?: { json?: () => Promise<unknown> };
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
 * The GraphQL request payload accepted by the POST handler.
 */
interface GraphQLRequestBody {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
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
}

/**
 * HTTP status to {@link ErrorCode} mapping used when a NestJS `HttpException`
 * — the currency of guards, pipes and filters — escapes a resolver.
 *
 * Without this translation such an exception reaches the client as a bare
 * `INTERNAL_ERROR` with a 500, and is masked outright in production, so an
 * authentication failure would be indistinguishable from a crash.
 */
const HTTP_STATUS_TO_ERROR_CODE: Readonly<Record<number, ErrorCode>> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.ALREADY_EXISTS,
  413: ErrorCode.PAYLOAD_TOO_LARGE,
  429: ErrorCode.RATE_LIMITED,
};

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

    let body: GraphQLRequestBody;
    try {
      body = await LeavenGraphQLDriver.readBody(req);
    } catch {
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

    if (!body.query) {
      this.respond(res, {
        errors: [
          {
            message: 'Query is required',
            extensions: { code: ErrorCode.BAD_REQUEST },
          },
        ],
      });
      return;
    }

    const context = await this.buildContext(req, res);

    try {
      const result = await this.executor.execute(
        {
          query: body.query,
          variables: body.variables,
          operationName: body.operationName,
        },
        context
      );

      const extensions =
        this.options?.metrics && result.metrics
          ? { ...result.response.extensions, metrics: result.metrics }
          : result.response.extensions;

      this.respond(res, {
        data: result.response.data as Record<string, unknown> | null | undefined,
        errors: result.response.errors,
        extensions,
      });
    } catch (error) {
      this.respond(res, { errors: [this.formatThrownError(error)] });
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
   * A response carrying `data` is a spec-conformant partial success and stays
   * 200 whatever the error codes say — anything else makes clients treat it as
   * a network failure and discard data they were given. Only a total failure
   * derives its status from the first error's `ErrorCode`, via the
   * `ERROR_CODES` registry that `@leaven-graphql/http` uses.
   */
  private respond(
    res: AdapterResponse,
    response: {
      data?: Record<string, unknown> | null;
      errors?: readonly GraphQLFormattedError[];
      extensions?: Record<string, unknown>;
    }
  ): void {
    const errors = response.errors?.map((error) => this.finalizeError(error));
    const hasErrors = errors !== undefined && errors.length > 0;
    const totalFailure = response.data === undefined || response.data === null;

    let status = 200;
    if (hasErrors && totalFailure) {
      const code = errors[0]?.extensions?.code;
      const known = typeof code === 'string' ? getErrorCode(code) : null;
      status = known ? ERROR_CODES[known].status : 500;
    }

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
      ? {
          message: 'An unexpected error occurred',
          extensions: { code: ErrorCode.INTERNAL_ERROR },
        }
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
   */
  private formatThrownError(error: unknown): GraphQLFormattedError {
    const includeStack = this.options?.includeStacktraceInErrorResponses ?? false;
    const formatted = formatError(error, {
      maskErrors:
        !isLeavenError(error) &&
        process.env.NODE_ENV === 'production' &&
        !includeStack,
      includeStackTrace: includeStack,
    });

    return this.options?.formatError
      ? this.options.formatError(formatted)
      : formatted;
  }

  /**
   * Read the operation from the request.
   *
   * The adapter may hand over an already-parsed body, a raw string, or nothing
   * at all when no body-parser is installed; the raw Fetch `Request` is the
   * last resort.
   */
  private static async readBody(req: AdapterRequest): Promise<GraphQLRequestBody> {
    const raw = req.body;

    if (typeof raw === 'string') {
      return JSON.parse(raw) as GraphQLRequestBody;
    }

    if (raw !== null && typeof raw === 'object' && !(raw instanceof ArrayBuffer)) {
      return raw as GraphQLRequestBody;
    }

    const json = req.raw?.json;
    if (json) {
      return (await json.call(req.raw)) as GraphQLRequestBody;
    }

    return {};
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
    const original = error.originalError;

    if (!(original instanceof HttpException)) {
      return formatted;
    }

    const status = original.getStatus();
    const code =
      HTTP_STATUS_TO_ERROR_CODE[status] ??
      (status >= 400 && status < 500
        ? ErrorCode.BAD_REQUEST
        : ErrorCode.INTERNAL_ERROR);

    return {
      ...formatted,
      extensions: { ...formatted.extensions, code, statusCode: status },
    };
  }
}
