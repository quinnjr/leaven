/**
 * @leaven-graphql/sse - Error formatting for executor results
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { GraphQLResponse } from '@leaven-graphql/core';
import {
  formatError,
  fromFormattedError,
  type ErrorMaskingOptions,
} from '@leaven-graphql/errors';

/**
 * Apply error formatting (masking, for example) to an executor result
 *
 * The executor hands back errors that are already `GraphQLFormattedError`s.
 * Passing those straight to `formatErrors` loses what made them safe to show:
 * an intentional `UNAUTHENTICATED` error comes out as a masked
 * `INTERNAL_ERROR`, and its `path` is dropped. This rebuilds each error with
 * `fromFormattedError` first, so its code, `path` and `locations` survive, and
 * then runs `formatError` with the given options.
 *
 * @param result - The executor result
 * @param options - Error masking options (no masking when omitted)
 * @returns The result with formatted errors; a result without errors is returned unchanged
 */
export function formatResultErrors<TData>(
  result: GraphQLResponse<TData>,
  options?: ErrorMaskingOptions
): GraphQLResponse<TData> {
  if (!result.errors) {
    return result;
  }
  return {
    ...result,
    errors: result.errors.map((error) => formatError(fromFormattedError(error), options)),
  };
}
