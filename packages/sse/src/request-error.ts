/**
 * @leaven-graphql/sse - Request error classification
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { GraphQLResponse } from '@leaven-graphql/core';
import { ErrorCode } from '@leaven-graphql/errors';

/**
 * Error codes Leaven assigns to an operation it rejects *before execution*
 *
 * - `PARSE_ERROR`: a syntax error (the parser).
 * - `VALIDATION_ERROR`: schema validation (the executor's pipeline).
 * - `COMPLEXITY_LIMIT`: the complexity budget or the analysis visit budget.
 * - `DEPTH_LIMIT`: `maxDepth` / `maxIntrospectionDepth`.
 * - `BAD_REQUEST`: operation selection (an unknown or missing operation
 *   name), and a variable that fails to coerce, which graphql-js reports
 *   before any resolver runs.
 * - `PERSISTED_QUERY_NOT_FOUND` / `PERSISTED_QUERY_INVALID`: a persisted
 *   query lookup, which by definition happens before execution.
 *
 * It is an allowlist rather than a denylist because the safe default for an
 * event-stream transport is to stream. The graphql-sse client retries every
 * non-200 response, so a result wrongly answered as non-200 can re-run a
 * mutation, while a result wrongly streamed only reaches the client as an
 * in-stream error. Any code not listed here, and any error with no code at
 * all (a throwing `onExecuted` hook, which fires after resolvers ran),
 * is therefore streamed.
 */
export const REQUEST_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ErrorCode.PARSE_ERROR,
  ErrorCode.VALIDATION_ERROR,
  ErrorCode.COMPLEXITY_LIMIT,
  ErrorCode.DEPTH_LIMIT,
  ErrorCode.BAD_REQUEST,
  ErrorCode.PERSISTED_QUERY_NOT_FOUND,
  ErrorCode.PERSISTED_QUERY_INVALID,
]);

/**
 * Decide whether an executor result is a *request error*: one rejected
 * before anything ran, which an SSE transport answers as non-200 JSON instead
 * of streaming
 *
 * True only when the result has no `data` (`undefined`; `data: null` means
 * execution started) and it has errors, every one of which carries a code in
 * {@link REQUEST_ERROR_CODES}. Everything else should be streamed.
 *
 * @param result - A single executor response (not a subscription iterator)
 * @returns True when the result should be answered as JSON
 */
export function isRequestError(result: GraphQLResponse<unknown>): boolean {
  const errors = result.errors ?? [];
  return (
    result.data === undefined &&
    errors.length > 0 &&
    errors.every((error) => {
      const code = error.extensions?.code;
      return typeof code === 'string' && REQUEST_ERROR_CODES.has(code);
    })
  );
}
