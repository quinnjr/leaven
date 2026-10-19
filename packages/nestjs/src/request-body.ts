/**
 * @leaven-graphql/nestjs - GraphQL request body validation
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 *
 * Internal: shared by every HTTP entry point (`GraphQLMiddleware`,
 * `LeavenDriver.handleRequest` and `LeavenGraphQLDriver`) so they reject the
 * same malformed payloads with the same `ValidationError`, refuse the same
 * CSRF-able POSTs, and so the two drivers that read a raw body bound it the
 * same way. Not exported from the package index.
 */

import {
  ErrorCode,
  isLeavenError,
  isPlainObject,
  LeavenError,
  ValidationError,
} from '@leaven-graphql/errors';

import type { CSRFPreventionOptions } from './types';

/**
 * The media type of a `Content-Type` header value: the first value (split on
 * `,`), the part before any `;` parameters, trimmed and lowercased. Compare it
 * with `===`; a substring test lets `text/plain; x=application/json` through.
 * A missing header (`null` or `undefined`) yields the empty string.
 *
 * Twin of `mediaType` in `packages/http/src/request.ts`: the two must stay in
 * step.
 */
export function mediaType(contentType: string | null | undefined): string {
  const first = (contentType ?? '').split(',')[0] ?? '';
  return (first.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Default `maxBodySize`, in bytes, for the drivers that read a raw body.
 * Twin of `DEFAULT_MAX_BODY_SIZE` in `packages/http/src/handler.ts`: the two must stay in step.
 */
export const DEFAULT_MAX_BODY_SIZE = 1_000_000;

/**
 * Default `bodyReadTimeoutMs`, in milliseconds, for the drivers that read a
 * raw body.
 * Twin of `DEFAULT_BODY_READ_TIMEOUT_MS` in `packages/http/src/handler.ts`: the two must stay in step.
 */
export const DEFAULT_BODY_READ_TIMEOUT_MS = 30_000;

/**
 * Default headers that satisfy CSRF prevention: a browser cannot send any of
 * them cross-site without a CORS preflight.
 * Twin of `DEFAULT_CSRF_REQUEST_HEADERS` in `packages/http/src/handler.ts`: the two must stay in step.
 */
export const DEFAULT_CSRF_REQUEST_HEADERS: readonly string[] = [
  'x-graphql-csrf',
  'apollo-require-preflight',
  'x-apollo-operation-name',
];

/**
 * Media types a browser may POST cross-site without a CORS preflight. The
 * empty string stands for a missing Content-Type.
 * Twin of `CORS_SAFELISTED_MEDIA_TYPES` in `packages/http/src/handler.ts`: the two must stay in step.
 */
const CORS_SAFELISTED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  '',
  'text/plain',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
]);

/**
 * An HTTP header name (an RFC 9110 `token`).
 * Twin of `HEADER_TOKEN` in `packages/http/src/handler.ts`: the two must stay in step.
 */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Message of the error thrown when CSRF prevention blocks a request.
 * Twin of `CSRF_BLOCKED_MESSAGE` in `packages/http/src/handler.ts`: the two must stay in step.
 */
const CSRF_BLOCKED_MESSAGE =
  'This request is blocked by CSRF prevention: send a non-simple Content-Type ' +
  '(application/json) or an x-graphql-csrf header';

/**
 * Resolve a `csrfPrevention` option to the header names that satisfy it, or
 * `undefined` when the check is disabled. Unset and `true` mean the defaults
 * ({@link DEFAULT_CSRF_REQUEST_HEADERS}); `{ requestHeaders }` replaces them.
 * Each configured name is trimmed and lowercased. Call it at construction so
 * a bad name fails fast rather than on the first request.
 *
 * Twin of the inline resolution in `createHandler` in
 * packages/http/src/handler.ts: the two must stay in step.
 *
 * @param option - The `csrfPrevention` option as configured
 * @returns The normalized header names, or `undefined` for `false`
 * @throws TypeError when a configured name is not a valid header token
 */
export function resolveCsrfRequestHeaders(
  option: boolean | CSRFPreventionOptions | undefined
): readonly string[] | undefined {
  if (option === false) {
    return undefined;
  }
  if (typeof option !== 'object' || option.requestHeaders === undefined) {
    return DEFAULT_CSRF_REQUEST_HEADERS;
  }
  return option.requestHeaders.map((name) => {
    const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
    if (!HEADER_TOKEN.test(normalized)) {
      throw new TypeError(
        `csrfPrevention.requestHeaders: ${JSON.stringify(name)} is not a valid header name`
      );
    }
    return normalized;
  });
}

/**
 * Whether a POST could have been sent cross-site without a preflight and
 * carries none of the preflight-forcing headers: its Content-Type essence is
 * missing or CORS-safelisted and no `requestHeaders` entry has a non-empty
 * value.
 *
 * Twin of `isCsrfBlocked` in `packages/http/src/handler.ts`: the defaults,
 * the safelist and the semantics must stay in step with it.
 *
 * @param contentType - The raw Content-Type header value, if any
 * @param header - Reads one request header by lowercase name
 * @param requestHeaders - Names from {@link resolveCsrfRequestHeaders}
 */
export function isCsrfBlocked(
  contentType: string | null | undefined,
  header: (name: string) => string | null | undefined,
  requestHeaders: readonly string[]
): boolean {
  if (!CORS_SAFELISTED_MEDIA_TYPES.has(mediaType(contentType))) {
    return false;
  }
  return !requestHeaders.some((name) => (header(name) ?? '').trim() !== '');
}

/**
 * The error thrown for a request CSRF prevention blocks: 400 `BAD_REQUEST`.
 */
export function csrfBlockedError(): LeavenError {
  return new LeavenError(CSRF_BLOCKED_MESSAGE, ErrorCode.BAD_REQUEST);
}

/**
 * Read one header from a Fetch `Headers` or a Node/Express-style map,
 * `undefined` when absent. A repeated header is joined with `,`, as the Fetch
 * `Headers` API does.
 *
 * `name` must be lowercase. A plain map is looked up case-insensitively — the
 * exact lowercase key first, then a scan — so a hand-built map with
 * `Origin`/`X-GraphQL-CSRF` keys is read the same way everywhere.
 */
export function readHeader(
  headers:
    | { get(name: string): string | null }
    | Readonly<Record<string, string | readonly string[] | undefined>>
    | undefined,
  name: string
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  let value: string | readonly string[] | null | undefined;
  if (typeof headers.get === 'function') {
    value = (headers as { get(name: string): string | null }).get(name);
  } else {
    const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
    // Own keys only: a header name such as `constructor` must not read an
    // inherited Object.prototype member
    value = Object.hasOwn(record, name) ? record[name] : undefined;
    if (value === undefined) {
      const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
      value = key === undefined ? undefined : record[key];
    }
  }
  if (Array.isArray(value)) {
    return value.every((part) => typeof part === 'string') ? value.join(',') : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * The parts of a Fetch `Request` that {@link readBodyText} reads. Structural,
 * so an adapter's raw request object qualifies without being a `Request`.
 */
export interface BodySource {
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

/**
 * The longest delay `setTimeout` honours, in milliseconds (2^31-1). Anything
 * larger is coerced to ~1ms.
 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Map a failed body read to the error reported for it. A Leaven error (a 413
 * or the deadline) passes through; anything else — a client abort, a socket
 * reset, an already-consumed body — is a bad request, not an internal failure,
 * and its raw text is not ours to leak.
 */
function readFailed(error: unknown): LeavenError {
  if (isLeavenError(error)) {
    return error;
  }
  return new LeavenError('Failed to read request body', ErrorCode.BAD_REQUEST, {
    originalError: error instanceof Error ? error : new Error(String(error)),
  });
}

/** The error thrown for a request body over `maxBodySize`. */
function payloadTooLarge(): LeavenError {
  return new LeavenError('Request body too large', ErrorCode.PAYLOAD_TOO_LARGE);
}

/**
 * Read a request body as text, bounded in size and in time.
 *
 * Twin of `readBodyWithLimit` in `packages/http/src/handler.ts`. The defaults
 * ({@link DEFAULT_MAX_BODY_SIZE} = 1_000_000 bytes,
 * {@link DEFAULT_BODY_READ_TIMEOUT_MS} = 30_000 ms) and the semantics
 * (Content-Length fast path, limit enforced on the bytes read, 413
 * `PAYLOAD_TOO_LARGE`, an owned deadline timer, a failed read or deadline
 * reported as 400 `BAD_REQUEST`) must stay in step with it.
 *
 * An honest `Content-Length` over the limit is rejected without reading the
 * body. The header may be absent, malformed or lying, so the limit is also
 * enforced on the bytes actually read.
 *
 * @param request - The request whose body to read
 * @param maxBytes - The largest body accepted, in bytes
 * @param timeoutMs - The deadline for reading the whole body, in
 *   milliseconds. `Infinity` or `0` (indeed any non-finite or non-positive
 *   value) means no deadline; a value over 2^31-1 is clamped to it
 * @returns The body decoded as UTF-8, or `''` when there is none
 * @throws LeavenError with `PAYLOAD_TOO_LARGE` (413) when the body is too
 *   large, or with `BAD_REQUEST` (400) when the read times out or fails (a
 *   client abort or socket reset, or a body already consumed or locked)
 */
export async function readBodyText(
  request: BodySource,
  maxBytes: number,
  timeoutMs: number
): Promise<string> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number.parseInt(contentLength, 10);
    if (!Number.isNaN(declared) && declared > maxBytes) {
      throw payloadTooLarge();
    }
  }

  const body = request.body;
  if (!body) {
    return '';
  }

  // A body that is already consumed or locked makes getReader() throw a raw
  // TypeError; report it like any other failed read. No reader was acquired,
  // so there is nothing to cancel or release.
  const reader = (() => {
    try {
      return body.getReader();
    } catch (error) {
      throw readFailed(error);
    }
  })();

  const chunks: Uint8Array[] = [];
  let total = 0;

  // An owned timer rather than AbortSignal.timeout: the deadline must be
  // cancelled once the read finishes, otherwise every completed request leaves
  // a live timer, listener and reject closure pinned for the full timeout.
  // Only a finite positive timeout arms it: setTimeout coerces Infinity, NaN,
  // a negative number or anything over 2^31-1 ms to ~1ms, which would fail
  // every read. Infinity (or 0) therefore means no deadline, and a larger
  // finite value is clamped to the longest delay setTimeout honours.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? new Promise<never>((_resolve, reject) => {
          deadlineTimer = setTimeout(() => {
            reject(
              new LeavenError(
                `Timed out reading request body after ${timeoutMs}ms`,
                ErrorCode.BAD_REQUEST
              )
            );
          }, Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
        })
      : undefined;

  try {
    for (;;) {
      const read = reader.read();
      const { done, value } = await (deadline ? Promise.race([read, deadline]) : read);
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw payloadTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    // A rejecting cancel() must not replace the error being reported.
    await reader.cancel().catch(() => {});
    throw readFailed(error);
  } finally {
    clearTimeout(deadlineTimer);
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  let text = '';
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * A validated GraphQL-over-HTTP request payload.
 */
export interface ValidatedGraphQLBody {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/**
 * Validate a `variables` value. `null` and `undefined` mean "no variables".
 *
 * @param variables - The raw `variables` value
 * @returns The variables object, or `undefined` when none were given
 * @throws ValidationError when the value is not a plain JSON object
 */
export function validateVariables(
  variables: unknown
): Record<string, unknown> | undefined {
  if (variables == null) {
    return undefined;
  }
  if (!isPlainObject(variables)) {
    throw new ValidationError('"variables" must be a JSON object');
  }
  return variables;
}

/**
 * Validate a GraphQL request body.
 *
 * @param body - The parsed request body
 * @returns The validated `{ query, variables, operationName }`
 * @throws ValidationError for a non-object body, a missing, empty or
 *   non-string `query`, a non-object `variables`, or a non-string
 *   `operationName`. `null` `variables`/`operationName` mean "none".
 */
export function validateGraphQLBody(body: unknown): ValidatedGraphQLBody {
  if (!isPlainObject(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }

  const { query, variables, operationName } = body;

  if (typeof query !== 'string' || query === '') {
    throw new ValidationError('Query is required');
  }

  const validatedVariables = validateVariables(variables);

  if (operationName != null && typeof operationName !== 'string') {
    throw new ValidationError('"operationName" must be a string');
  }

  return {
    query,
    variables: validatedVariables,
    operationName: operationName ?? undefined,
  };
}
