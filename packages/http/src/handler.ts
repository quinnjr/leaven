/**
 * @leaven-graphql/http - HTTP request handler
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { getOperationAST, OperationTypeNode, type GraphQLSchema } from 'graphql';
import {
  LeavenExecutor,
  type ExecutorConfig,
  type GraphQLRequest,
  type GraphQLResponse,
} from '@leaven-graphql/core';
import { createRequestContext, type RequestContextConfig } from '@leaven-graphql/context';
import {
  formatError,
  isLeavenError,
  statusForResponse,
  withMaskingDefault,
  type ErrorMaskingOptions,
} from '@leaven-graphql/errors';
import { renderGraphiQL } from '@leaven-graphql/playground';
import {
  acceptsEventStream,
  createEventStreamResponse,
  formatResultErrors,
  isRequestError,
  isSubscriptionIterator,
  type EventStreamSource,
} from '@leaven-graphql/sse';

import {
  mediaType,
  parseBody,
  parseQuery,
  UnsupportedMediaTypeError,
  validateRequest,
} from './request';
import {
  buildResponse,
  buildErrorResponse,
  preflightResponse,
  methodNotAllowed,
  corsHeaders,
  type CorsConfig,
  type ResponseOptions,
} from './response';

/**
 * GraphQL HTTP handler function
 */
export type GraphQLHandler = (request: Request) => Promise<Response>;

/**
 * Context factory function
 */
export type ContextFactory<TContext> = (
  request: Request,
  graphqlRequest: GraphQLRequest
) => TContext | Promise<TContext>;

/**
 * GraphQL over SSE options
 */
export interface SSEOptions {
  /** ms between keep-alive comments (default 8000; 0 disables) */
  keepAliveInterval?: number;
}

/**
 * CSRF prevention options
 *
 * Twin of `CSRFPreventionOptions` in `packages/nestjs/src/types.ts`: the two
 * must stay in step.
 */
export interface CSRFPreventionOptions {
  /**
   * Headers whose presence (with a non-empty value) proves the request was
   * preflighted. Replaces the default list
   * (`x-graphql-csrf`, `apollo-require-preflight`, `x-apollo-operation-name`).
   */
  requestHeaders?: string[];
}

/**
 * Handler configuration
 */
export interface HandlerConfig<TContext = unknown> {
  /** GraphQL schema */
  schema: GraphQLSchema;
  /** Context factory */
  context?: ContextFactory<TContext>;
  /** Root value */
  rootValue?: unknown;
  /** Executor configuration */
  executor?: Omit<ExecutorConfig, 'schema' | 'rootValue'>;
  /** CORS configuration */
  cors?: CorsConfig | boolean;
  /** Enable GraphQL playground at GET requests */
  playground?: boolean;
  /** Path for the GraphQL endpoint (used as the playground's endpoint; default: '/graphql') */
  path?: string;
  /**
   * Error formatting options.
   *
   * On the thrown-error path (e.g. a failing context factory) and the SSE
   * error path, masking is on by default and stays on when other options
   * are set; only an explicit `maskErrors: false` disables it.
   */
  errorFormatting?: ErrorMaskingOptions;
  /** Request context configuration */
  requestContext?: RequestContextConfig;
  /** Response options */
  response?: ResponseOptions;
  /** Allowed methods (default: GET, POST, OPTIONS) */
  allowedMethods?: string[];
  /** Enable introspection */
  introspection?: boolean;
  /** Maximum request body size in bytes (default: 1_000_000) */
  maxBodySize?: number;
  /**
   * Maximum time to spend reading a request body, in milliseconds
   * (default: 30_000). Bounds slow-loris style trickled uploads. `Infinity`
   * (or `0`) disables the deadline; values above 2^31-1 are clamped.
   */
  bodyReadTimeoutMs?: number;
  /**
   * Serve GraphQL over SSE (graphql-sse distinct connections mode) to
   * requests that Accept text/event-stream. Default: off.
   */
  sse?: boolean | SSEOptions;
  /**
   * CSRF prevention (default: on). A POST whose Content-Type is missing or
   * CORS-safelisted (`text/plain`, `application/x-www-form-urlencoded`,
   * `multipart/form-data`) is refused with 400 unless it carries a
   * non-empty preflight-forcing header (default: `x-graphql-csrf`,
   * `apollo-require-preflight`, `x-apollo-operation-name`). Such requests
   * are "simple" and a browser sends them cross-site without a CORS
   * preflight. `false` disables the check.
   */
  csrfPrevention?: boolean | CSRFPreventionOptions;
}

/**
 * RFC 9110 header field-name token. Twin of `HEADER_TOKEN` in
 * `packages/nestjs/src/request-body.ts`.
 */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Default headers that satisfy CSRF prevention. Twin of
 * `DEFAULT_CSRF_REQUEST_HEADERS` in `packages/nestjs/src/request-body.ts`.
 */
const DEFAULT_CSRF_REQUEST_HEADERS: readonly string[] = [
  'x-graphql-csrf',
  'apollo-require-preflight',
  'x-apollo-operation-name',
];

/**
 * Media types a browser may POST cross-site without a CORS preflight. The
 * empty string stands for a missing Content-Type. Twin of
 * `CORS_SAFELISTED_MEDIA_TYPES` in `packages/nestjs/src/request-body.ts`.
 */
const CORS_SAFELISTED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  '',
  'text/plain',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
]);

/**
 * Message returned when CSRF prevention blocks a request. Twin of
 * `CSRF_BLOCKED_MESSAGE` in `packages/nestjs/src/request-body.ts`.
 */
const CSRF_BLOCKED_MESSAGE =
  'This request is blocked by CSRF prevention: send a non-simple Content-Type ' +
  '(application/json) or an x-graphql-csrf header';

/**
 * Whether a POST could have been sent cross-site without a preflight and
 * carries none of the preflight-forcing headers.
 *
 * Twin of `isCsrfBlocked` in `packages/nestjs/src/request-body.ts`: the
 * defaults, the safelist and the semantics must stay in step with it.
 */
function isCsrfBlocked(request: Request, requestHeaders: readonly string[]): boolean {
  if (!CORS_SAFELISTED_MEDIA_TYPES.has(mediaType(request.headers.get('content-type')))) {
    return false;
  }
  return !requestHeaders.some(
    (name) => (request.headers.get(name) ?? '').trim() !== ''
  );
}

/**
 * Default maximum request body size in bytes.
 *
 * Twin of `DEFAULT_MAX_BODY_SIZE` and `readBodyText` in
 * `packages/nestjs/src/request-body.ts`. The defaults and the size-limit
 * semantics (Content-Length fast path, limit enforced on the bytes read, 413
 * `PAYLOAD_TOO_LARGE`) must stay in step. Here the Content-Length fast path
 * lives in `createHandler`'s POST branch rather than in `readBodyWithLimit`,
 * and a consumed or locked body is mapped to a 400 by that caller; nestjs
 * `readBodyText` does both itself.
 */
const DEFAULT_MAX_BODY_SIZE = 1_000_000;

/**
 * Default deadline for reading a request body, in milliseconds.
 *
 * Part of the same twin pair as `DEFAULT_MAX_BODY_SIZE`: keep it in step with
 * the nestjs read deadline (`DEFAULT_BODY_READ_TIMEOUT_MS` in
 * `packages/nestjs/src/request-body.ts`).
 */
const DEFAULT_BODY_READ_TIMEOUT_MS = 30_000;

/** Raised when reading a request body exceeds its deadline */
class BodyReadTimeoutError extends Error {}

/**
 * Read a request body while enforcing a maximum size.
 *
 * Consumes the body as a stream and aborts as soon as the threshold is
 * crossed, so a chunked request (no Content-Length) or a lying header
 * cannot cause the whole body to be buffered.
 *
 * The read is bounded by `timeoutMs` so a client that trickles bytes cannot
 * pin a request slot indefinitely.
 *
 * Twin of `readBodyText` in `packages/nestjs/src/request-body.ts`: the defaults and
 * the size-limit and deadline semantics (a non-finite or non-positive timeout
 * disables the deadline) must stay in step between the two.
 *
 * Returns a new Request carrying the buffered body (headers preserved so
 * content-type/boundary survive), or `null` when the limit was exceeded.
 * Throws when the body could not be read (client abort, stream error, or
 * the deadline elapsing).
 */
async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
  timeoutMs: number
): Promise<Request | null> {
  const body = request.body;
  if (!body) {
    return request;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  // An owned timer rather than AbortSignal.timeout: the deadline must be
  // cancelled once the read finishes, otherwise every completed POST leaves a
  // live timer, listener and reject closure pinned for the full timeout.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  // Armed only for a finite positive value: Infinity, 0, NaN or a negative
  // number mean "no deadline" (setTimeout would otherwise fire them after ~1ms).
  // Larger values are clamped to the 32-bit maximum setTimeout accepts.
  const deadline = new Promise<never>((_resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return;
    }
    deadlineTimer = setTimeout(() => {
      reject(
        new BodyReadTimeoutError(`Timed out reading request body after ${timeoutMs}ms`)
      );
    }, Math.min(timeoutMs, 2 ** 31 - 1));
  });

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        // A rejecting cancel() must not turn the intended 413 into a 500.
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: buffer,
  });
}

/**
 * Determine the operation type a request would execute.
 *
 * Returns `undefined` on a parse failure or an ambiguous operation, so that
 * execution reports the real error.
 */
async function operationTypeOf(
  executor: LeavenExecutor,
  request: GraphQLRequest
): Promise<OperationTypeNode | undefined> {
  try {
    const document = await executor.parse(request.query);
    return getOperationAST(document, request.operationName ?? undefined)?.operation;
  } catch {
    // Swallowed on purpose: execution parses the document again and reports
    // the syntax error to the client with its proper code.
    return undefined;
  }
}

/**
 * Apply the configured error formatting to a response.
 *
 * Delegates to `formatResultErrors`, which rebuilds the executor's
 * already-formatted errors before formatting them. Without options the
 * response is returned unchanged, so nothing is masked by default.
 */
function formatResponseErrors<TData>(
  response: GraphQLResponse<TData>,
  options?: ErrorMaskingOptions
): GraphQLResponse<TData> {
  return options ? formatResultErrors(response, options) : response;
}

/**
 * Execute a request for the SSE transport and pick the source to stream.
 *
 * Subscriptions go through `subscribe`, everything else through `execute`.
 * Returns the source to stream, or the single response to answer as JSON
 * when it is a request error (`isRequestError` from `@leaven-graphql/sse`:
 * no data, and marked by the executor as rejected before execution). The
 * check runs on the executor's own object, before `formatResponseErrors`
 * clones it, because the mark is identity-based. The rule applies
 * to an `execute()` response and to a `subscribe()` result that is not an
 * iterator alike.
 */
async function executeForStream<TContext>(
  executor: LeavenExecutor,
  request: GraphQLRequest,
  context: TContext,
  operationType: OperationTypeNode | undefined
): Promise<{ stream: EventStreamSource } | { json: GraphQLResponse }> {
  const result =
    operationType === OperationTypeNode.SUBSCRIPTION
      ? await executor.subscribe(request, context)
      : (await executor.execute(request, context)).response;
  if (isSubscriptionIterator(result) || !isRequestError(result)) {
    return { stream: result };
  }
  return { json: result };
}

/**
 * Merge user-configured response headers with CORS headers. CORS wins on
 * conflicts, except `Vary`, whose values are combined (deduplicated
 * case-insensitively) so a user `Vary: Accept-Encoding` is not lost. The user
 * key may use any casing.
 */
function mergeResponseHeaders(
  userHeaders: Record<string, string> | undefined,
  cors: Record<string, string>
): Record<string, string> {
  const byLower = new Map<string, [string, string]>();
  const varyValues: string[] = [];
  const addVary = (value: string): void => {
    for (const part of value.split(',')) {
      const token = part.trim();
      if (token !== '' && !varyValues.some((v) => v.toLowerCase() === token.toLowerCase())) {
        varyValues.push(token);
      }
    }
  };
  // Header names are case-insensitive: key by lowercase name so a later
  // (CORS) entry overwrites an earlier (user) one whatever its casing.
  for (const source of [userHeaders ?? {}, cors]) {
    for (const [key, value] of Object.entries(source)) {
      const lower = key.toLowerCase();
      if (lower === 'vary') addVary(value);
      else byLower.set(lower, [key, value]);
    }
  }
  const merged: Record<string, string> = {};
  for (const [key, value] of byLower.values()) merged[key] = value;
  if (varyValues.length > 0) merged['Vary'] = varyValues.join(', ');
  return merged;
}

/**
 * Create a GraphQL HTTP handler for Bun
 */
export function createHandler<TContext = unknown>(
  config: HandlerConfig<TContext>
): GraphQLHandler {
  const executor = new LeavenExecutor({
    schema: config.schema,
    rootValue: config.rootValue,
    introspection: config.introspection ?? true,
    ...config.executor,
  });

  const allowedMethods = config.allowedMethods ?? ['GET', 'POST', 'OPTIONS'];
  const baseCorsConfig = config.cors === true ? {} : config.cors || undefined;
  const maxBodySize = config.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  const bodyReadTimeoutMs =
    config.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS;
  const rawCsrfHeaders: readonly string[] | undefined =
    config.csrfPrevention === false
      ? undefined
      : typeof config.csrfPrevention === 'object'
        ? (config.csrfPrevention.requestHeaders ?? DEFAULT_CSRF_REQUEST_HEADERS)
        : DEFAULT_CSRF_REQUEST_HEADERS;
  const csrfRequestHeaders: readonly string[] | undefined = rawCsrfHeaders?.map(
    (name) => {
      // Twin of `resolveCsrfRequestHeaders` in packages/nestjs/src/request-body.ts:
      // the two must stay in step. Guards non-strings (e.g. from untyped JS config).
      const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
      if (!HEADER_TOKEN.test(normalized)) {
        throw new TypeError(
          `csrfPrevention.requestHeaders: ${JSON.stringify(name)} is not a valid header name`
        );
      }
      return normalized;
    }
  );
  // Cross-origin clients must be allowed to send the CSRF header, so unless
  // the user chose allowedHeaders explicitly, add the CSRF names to the default.
  // Twin of nestjs defaultAllowedHeaders() in packages/nestjs/src/middleware.ts.
  const corsConfig =
    baseCorsConfig !== undefined &&
    baseCorsConfig.allowedHeaders === undefined &&
    csrfRequestHeaders !== undefined
      ? {
          ...baseCorsConfig,
          allowedHeaders: ['Content-Type', 'Authorization', ...csrfRequestHeaders],
        }
      : baseCorsConfig;
  const sseOptions: SSEOptions | undefined =
    config.sse === true ? {} : config.sse || undefined;
  // An explicit `maskErrors: undefined` must not override the secure default.
  const maskingOptions: ErrorMaskingOptions = withMaskingDefault(config.errorFormatting);
  const playgroundHtml = config.playground
    ? renderGraphiQL({ endpoint: config.path ?? '/graphql' })
    : null;

  return async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();

    // Handle CORS preflight
    if (method === 'OPTIONS' && corsConfig !== undefined) {
      return preflightResponse(request, corsConfig);
    }

    // Check allowed methods
    if (!allowedMethods.includes(method)) {
      return methodNotAllowed(allowedMethods);
    }

    // Without CORS there is no preflight to answer; still treat OPTIONS as a
    // method-discovery request rather than a malformed GraphQL operation.
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { Allow: allowedMethods.join(', ') },
      });
    }

    // Add CORS headers to response options
    const responseOptions: ResponseOptions = {
      ...config.response,
      headers: mergeResponseHeaders(
        config.response?.headers,
        corsConfig !== undefined ? corsHeaders(request, corsConfig) : {}
      ),
    };

    const wantsStream =
      sseOptions !== undefined &&
      (method === 'GET' || method === 'POST') &&
      acceptsEventStream(request);

    try {
      // Parse the request
      const url = new URL(request.url);

      // Serve the GraphQL playground to browsers: GET request, playground
      // enabled, Accepts HTML, and no query parameter to execute.
      if (
        method === 'GET' &&
        playgroundHtml !== null &&
        (request.headers.get('accept') ?? '').includes('text/html') &&
        !url.searchParams.has('query')
      ) {
        return new Response(playgroundHtml, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            ...(corsConfig !== undefined ? corsHeaders(request, corsConfig) : {}),
          },
        });
      }

      let queryParams: ReturnType<typeof parseQuery> = {};
      // Decode URL parameters strictly. Over POST the body supplies the
      // parameters, so a URL field is decoded only when the body lacks it.
      const readQueryParams = (
        omit: readonly string[] = []
      ): Response | undefined => {
        const target = new URL(url);
        for (const name of omit) {
          target.searchParams.delete(name);
        }
        try {
          queryParams = parseQuery(target);
        } catch (queryError) {
          return buildErrorResponse(
            queryError instanceof Error ? queryError.message : 'Invalid query string',
            400,
            'BAD_REQUEST',
            responseOptions
          );
        }
        return undefined;
      };
      if (method !== 'POST') {
        const rejected = readQueryParams();
        if (rejected !== undefined) {
          return rejected;
        }
      }

      let body: Awaited<ReturnType<typeof parseBody>> = {};
      if (method === 'POST') {
        // CSRF prevention runs before the body is read or the context
        // factory runs. Only POST needs it: other methods cannot mutate.
        if (
          csrfRequestHeaders !== undefined &&
          isCsrfBlocked(request, csrfRequestHeaders)
        ) {
          return buildErrorResponse(
            CSRF_BLOCKED_MESSAGE,
            400,
            'BAD_REQUEST',
            responseOptions
          );
        }

        // Enforce maximum body size.
        //
        // Fast path: an honest Content-Length that exceeds the limit is
        // rejected without reading the body at all.
        const contentLength = request.headers.get('content-length');
        if (contentLength !== null) {
          const declaredLength = Number.parseInt(contentLength, 10);
          if (!Number.isNaN(declaredLength) && declaredLength > maxBodySize) {
            return buildErrorResponse(
              'Request body too large',
              413,
              'PAYLOAD_TOO_LARGE',
              responseOptions
            );
          }
        }

        // The header may be absent (chunked encoding), malformed, or
        // lying, so the limit is always enforced while reading.
        let limited: Request | null;
        try {
          limited = await readBodyWithLimit(
            request,
            maxBodySize,
            bodyReadTimeoutMs
          );
        } catch (readError) {
          // A client abort, stream error, or read deadline is a bad request,
          // not an internal failure — and its raw text is not ours to leak.
          const message =
            readError instanceof BodyReadTimeoutError
              ? readError.message
              : 'Failed to read request body';
          return buildErrorResponse(message, 400, 'BAD_REQUEST', responseOptions);
        }

        if (limited === null) {
          return buildErrorResponse(
            'Request body too large',
            413,
            'PAYLOAD_TOO_LARGE',
            responseOptions
          );
        }

        const bodyRequest = limited;

        try {
          body = await parseBody(bodyRequest);
        } catch (parseError) {
          const message =
            parseError instanceof Error
              ? parseError.message
              : 'Failed to parse request body';
          // Unsupported media type is 415; ErrorCode has no dedicated code,
          // so it carries BAD_REQUEST, like the 405 mutation rejection.
          const status = parseError instanceof UnsupportedMediaTypeError ? 415 : 400;
          return buildErrorResponse(message, status, 'BAD_REQUEST', responseOptions);
        }
      }

      if (method === 'POST') {
        const rejected = readQueryParams(
          ['variables', 'extensions'].filter(
            (name) => (body as Record<string, unknown>)[name] != null
          )
        );
        if (rejected !== undefined) {
          return rejected;
        }
      }

      // Validate the request
      const validation = validateRequest(body, queryParams);
      if (!validation.valid) {
        return buildErrorResponse(
          validation.error ?? 'Invalid request',
          400,
          'BAD_REQUEST',
          responseOptions
        );
      }

      const graphqlRequest = validation.request!;

      // The operation type is computed at most once per request and shared by
      // the GET-mutation guard and SSE routing.
      let operationType: Promise<OperationTypeNode | undefined> | undefined;
      const getOperationType = (): Promise<OperationTypeNode | undefined> =>
        (operationType ??= operationTypeOf(executor, graphqlRequest));

      // Mutations are only allowed over POST, not GET or HEAD (GraphQL over HTTP spec); reject
      // before any per-request work such as the context factory runs.
      if (
        method !== 'POST' &&
        (await getOperationType()) === OperationTypeNode.MUTATION
      ) {
        // The computed Allow wins: drop any user key of any casing first.
        const userHeaders = Object.fromEntries(
          Object.entries(responseOptions.headers ?? {}).filter(
            ([key]) => !/^allow$/i.test(key)
          )
        );
        return buildErrorResponse(
          'Mutations can only be sent with POST',
          405,
          'BAD_REQUEST',
          {
            ...responseOptions,
            headers: { ...userHeaders, Allow: 'POST' },
          }
        );
      }

      // Build context
      let context: TContext | undefined;
      if (config.context) {
        context = await config.context(request, graphqlRequest);
      } else {
        // Use default request context
        context = createRequestContext(request, config.requestContext) as TContext;
      }

      if (wantsStream) {
        const outcome = await executeForStream(
          executor,
          graphqlRequest,
          context,
          await getOperationType()
        );
        if ('json' in outcome) {
          return buildResponse(
            formatResponseErrors(outcome.json, config.errorFormatting),
            responseOptions
          );
        }
        // The original request's signal: it aborts when the client goes away,
        // which the rebuilt body request's signal never does.
        return createEventStreamResponse(outcome.stream, {
          signal: request.signal,
          keepAliveInterval: sseOptions.keepAliveInterval,
          formatResult: (r) => formatResponseErrors(r, config.errorFormatting),
          formatError: (e) => formatError(e, maskingOptions),
          headers: responseOptions.headers,
        });
      }

      // Execute the query
      const result = await executor.execute(graphqlRequest, context);

      return buildResponse(
        formatResponseErrors(result.response, config.errorFormatting),
        responseOptions
      );
    } catch (error) {
      // Anything thrown outside execution (notably the context factory) lands
      // here, so it must go through the same masking as execution errors —
      // otherwise raw internal text (DSN strings, connection failures) is
      // returned verbatim to unauthenticated callers. formatError preserves
      // LeavenError messages and masks the rest.
      const formatted = formatError(error, maskingOptions);
      // LeavenError carries its documented HTTP status; anything else is mapped
      // from its (possibly masked) code, so a GraphQLError coded UNAUTHENTICATED
      // gets 401 and an unknown error stays a 500.
      const status = isLeavenError(error)
        ? error.statusCode
        : statusForResponse({ errors: [formatted] });
      const code =
        (formatted.extensions?.code as string | undefined) ??
        (isLeavenError(error) ? error.code : 'INTERNAL_ERROR');
      return buildErrorResponse(formatted.message, status, code, responseOptions);
    }
  };
}

/**
 * Create a GraphQL handler for Bun.serve
 */
export function createBunHandler<TContext = unknown>(
  config: HandlerConfig<TContext>
): GraphQLHandler {
  return createHandler(config);
}
