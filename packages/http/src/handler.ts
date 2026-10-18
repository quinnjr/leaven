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
  fromFormattedError,
  isLeavenError,
  type ErrorMaskingOptions,
} from '@leaven-graphql/errors';
import { renderGraphiQL } from '@leaven-graphql/playground';
import {
  acceptsEventStream,
  createEventStreamResponse,
  isSubscriptionIterator,
  type EventStreamSource,
} from '@leaven-graphql/sse';

import { parseBody, parseQuery, validateRequest } from './request';
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
  /** Error formatting options */
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
   * (default: 30_000). Bounds slow-loris style trickled uploads.
   */
  bodyReadTimeoutMs?: number;
  /**
   * Serve GraphQL over SSE (graphql-sse distinct connections mode) to
   * requests that Accept text/event-stream. Default: off.
   */
  sse?: boolean | SSEOptions;
}

/** Default maximum request body size in bytes */
const DEFAULT_MAX_BODY_SIZE = 1_000_000;

/** Default deadline for reading a request body, in milliseconds */
const DEFAULT_BODY_READ_TIMEOUT_MS = 30_000;

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
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new Error(`Timed out reading request body after ${timeoutMs}ms`));
    }, timeoutMs);
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
 * The executor hands back already-formatted errors, so each one is rebuilt
 * into a GraphQLError first — formatting a formatted error would stringify it
 * to "[object Object]". Without options the response is returned unchanged.
 */
function formatResponseErrors<TData>(
  response: GraphQLResponse<TData>,
  options?: ErrorMaskingOptions
): GraphQLResponse<TData> {
  if (!response.errors || !options) {
    return response;
  }
  return {
    ...response,
    errors: response.errors.map((e) => formatError(fromFormattedError(e), options)),
  };
}

/**
 * True when a single response failed outright (errors and no data), which is
 * answered as a JSON error response rather than as an event stream.
 */
function isTotalFailure(response: GraphQLResponse<unknown>): boolean {
  return (
    (response.errors?.length ?? 0) > 0 &&
    (response.data === undefined || response.data === null)
  );
}

/**
 * Execute a request for the SSE transport and pick the source to stream.
 *
 * Subscriptions go through `subscribe`, everything else through `execute`.
 * Returns the source to stream, or the single response to answer as JSON
 * when the operation failed before producing any data.
 */
async function executeForStream<TContext>(
  executor: LeavenExecutor,
  request: GraphQLRequest,
  context: TContext
): Promise<{ stream: EventStreamSource } | { json: GraphQLResponse }> {
  if ((await operationTypeOf(executor, request)) === OperationTypeNode.SUBSCRIPTION) {
    const result = await executor.subscribe(request, context);
    return isSubscriptionIterator(result) ? { stream: result } : { json: result };
  }
  const { response } = await executor.execute(request, context);
  return isTotalFailure(response) ? { json: response } : { stream: response };
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
  const corsConfig = config.cors === true ? {} : config.cors || undefined;
  const maxBodySize = config.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  const bodyReadTimeoutMs =
    config.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS;
  const sseOptions: SSEOptions | undefined =
    config.sse === true ? {} : config.sse || undefined;
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

    // Add CORS headers to response options
    const responseOptions: ResponseOptions = {
      ...config.response,
      headers: {
        ...config.response?.headers,
        ...(corsConfig !== undefined ? corsHeaders(request, corsConfig) : {}),
      },
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

      const queryParams = parseQuery(url);

      let body: Awaited<ReturnType<typeof parseBody>> = {};
      if (method === 'POST') {
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
            readError instanceof Error
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
          return buildErrorResponse(message, 400, 'BAD_REQUEST', responseOptions);
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

      // Mutations are not safe over GET (GraphQL over HTTP spec); reject
      // before any per-request work such as the context factory runs.
      if (
        method === 'GET' &&
        (await operationTypeOf(executor, graphqlRequest)) === OperationTypeNode.MUTATION
      ) {
        return buildErrorResponse(
          'Mutations can only be sent with POST',
          405,
          'BAD_REQUEST',
          {
            ...responseOptions,
            headers: { ...responseOptions.headers, Allow: 'POST' },
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
        const outcome = await executeForStream(executor, graphqlRequest, context);
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
          keepAliveInterval: sseOptions?.keepAliveInterval,
          formatResult: (r) => formatResponseErrors(r, config.errorFormatting),
          formatError: (e) => formatError(e, config.errorFormatting ?? { maskErrors: true }),
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
      const formatted = formatError(error, config.errorFormatting);
      // LeavenError carries its documented HTTP status; everything else is a 500.
      const status = isLeavenError(error) ? error.statusCode : 500;
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
