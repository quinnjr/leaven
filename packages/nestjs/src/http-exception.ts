/**
 * @leaven-graphql/nestjs - NestJS HttpException to ErrorCode mapping
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { HttpException } from '@nestjs/common';
import { ErrorCode, LeavenError } from '@leaven-graphql/errors';

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

/** The {@link ErrorCode} and HTTP status a NestJS `HttpException` stands for. */
export interface HttpExceptionCode {
  /** The mapped code: a dedicated one, else `BAD_REQUEST` for any 4xx, else `INTERNAL_ERROR`. */
  readonly code: ErrorCode;
  /** The exception's own HTTP status. */
  readonly status: number;
}

/**
 * Map a NestJS `HttpException` to its {@link ErrorCode}, `undefined` for
 * anything else.
 *
 * Internal: shared by `LeavenDriver` and `LeavenGraphQLDriver` so both
 * translate an exception escaping a resolver identically.
 *
 * @param error - Typically a `GraphQLError`'s `originalError`
 * @returns The mapped code and status, or `undefined` when `error` is not an `HttpException`
 */
export function httpExceptionCode(error: unknown): HttpExceptionCode | undefined {
  if (!(error instanceof HttpException)) {
    return undefined;
  }
  const status = error.getStatus();
  const code =
    HTTP_STATUS_TO_ERROR_CODE[status] ??
    (status >= 400 && status < 500 ? ErrorCode.BAD_REQUEST : ErrorCode.INTERNAL_ERROR);
  return { code, status };
}

/**
 * Turn a thrown NestJS `HttpException` into the equivalent coded
 * {@link LeavenError}; return anything else unchanged.
 *
 * Internal: applied wherever a *thrown* error (a context factory, an
 * `onSubscribe`/`onOperation` hook, the middleware) is formatted or given a
 * status, so an `UnauthorizedException` reaches the client as a 401
 * `UNAUTHENTICATED` with its message instead of a masked 500. A 5xx exception
 * maps to `INTERNAL_ERROR` and is returned unchanged, since a `LeavenError` is
 * never masked and a server failure's text must stay masked in production.
 *
 * @param error - Anything thrown
 * @returns A `LeavenError` carrying the mapped code and the exception's status, or `error` itself
 */
export function normalizeHttpException(error: unknown): unknown {
  const mapped = httpExceptionCode(error);
  if (mapped === undefined || mapped.code === ErrorCode.INTERNAL_ERROR) {
    return error;
  }
  const exception = error as Error;
  return new LeavenError(exception.message, mapped.code, {
    statusCode: mapped.status,
    originalError: exception,
  });
}
