/**
 * @leaven-graphql/sse - Request error classification
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { isRequestRejection, type GraphQLResponse } from '@leaven-graphql/core';

/**
 * Decide whether an executor result is a *request error*: one the executor
 * rejected before running any resolver, which an SSE transport answers as
 * non-200 JSON instead of streaming
 *
 * True only when the result has no `data` and the executor marked it as a
 * pre-execution rejection (`isRequestRejection` from `@leaven-graphql/core`:
 * a syntax error, a parser limit, validation, complexity, operation selection
 * or variable coercion). The classification is structural, not by error
 * code: a coded error such as a `ValidationError` thrown by a resolver, a
 * subscribe resolver or an `onExecuted` hook ran after execution started and
 * is streamed. That is the safe default, because the graphql-sse client
 * retries every non-200 response and a retry would run the resolver again.
 *
 * The mark is identity-based: pass the object `execute()` or `subscribe()`
 * returned, before formatting or copying it.
 *
 * @param result - A single executor response (not a subscription iterator)
 * @returns True when the result should be answered as JSON
 */
export function isRequestError(result: GraphQLResponse<unknown>): boolean {
  return result.data === undefined && isRequestRejection(result);
}
