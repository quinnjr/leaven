/**
 * @leaven-graphql/errors - Error formatting utilities
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { GraphQLError, type GraphQLFormattedError, type SourceLocation } from 'graphql';
import { LeavenError } from './errors';
import { ErrorCode, getErrorCode } from './codes';

/** Default message substituted for masked, unexpected errors. */
export const MASKED_ERROR_MESSAGE = 'An unexpected error occurred';

/**
 * Custom error formatter function
 */
export type ErrorFormatter = (
  error: GraphQLError,
  masked: boolean
) => GraphQLFormattedError;

/**
 * Options for error masking
 */
export interface ErrorMaskingOptions {
  /** Enable error masking in production */
  maskErrors?: boolean;
  /** Message to show for masked errors */
  maskedMessage?: string;
  /** Predicate to determine if an error should be masked */
  shouldMask?: (error: GraphQLError) => boolean;
  /** Include stack traces in development */
  includeStackTrace?: boolean;
  /** Custom error formatter */
  formatter?: ErrorFormatter;
}

/**
 * Check if an error is a Leaven error
 */
export function isLeavenError(error: unknown): error is LeavenError {
  return error instanceof LeavenError;
}

/**
 * Convert any error to a GraphQL error
 */
export function errorToGraphQL(error: unknown): GraphQLError {
  if (error instanceof GraphQLError) {
    if (error.extensions?.code !== undefined) {
      return error;
    }

    // Every error leaving Leaven must carry an ErrorCode. A bare
    // `new GraphQLError('boom')` from a resolver, or a graphql-js validation
    // error, has no `extensions` at all, so rebuild it with the fallback code.
    // `nodes`/`source`/`positions` are carried over so `locations` survives.
    return new GraphQLError(error.message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
      originalError: error.originalError,
      extensions: {
        ...error.extensions,
        code: ErrorCode.INTERNAL_ERROR,
      },
    });
  }

  if (isLeavenError(error)) {
    return error.toGraphQLError();
  }

  if (error instanceof Error) {
    return new GraphQLError(error.message, {
      originalError: error,
      extensions: {
        code: ErrorCode.INTERNAL_ERROR,
      },
    });
  }

  return new GraphQLError(String(error), {
    extensions: {
      code: ErrorCode.INTERNAL_ERROR,
    },
  });
}

/**
 * Rebuild a `GraphQLError` from an error that was already formatted.
 *
 * `LeavenExecutor` returns plain `GraphQLFormattedError` objects (via
 * `GraphQLError.toJSON()` or `formatExecutionError`). Feeding one of those to
 * {@link formatError} directly is destructive: {@link errorToGraphQL} has no
 * branch for a formatted error, so it falls through to
 * `new GraphQLError(String(error))`. The message becomes `"[object Object]"`,
 * path and locations are dropped, and the real code is overwritten with
 * INTERNAL_ERROR, which masks Leaven errors that must never be masked.
 *
 * Reconstructing first makes the round trip lossless, so masking decisions are
 * made against the error the executor actually produced. Every transport that
 * applies `ErrorMaskingOptions` to executor output does this.
 */
export function fromFormattedError(formatted: GraphQLFormattedError): GraphQLError {
  const error = new GraphQLError(formatted.message, {
    path: formatted.path ? [...formatted.path] : undefined,
    extensions: formatted.extensions ? { ...formatted.extensions } : undefined,
  });

  // `locations` are normally derived from AST nodes or source positions, which
  // a formatted error no longer carries, so restore them directly. The field is
  // a plain writable property; `readonly` is a compile-time contract only.
  if (formatted.locations && formatted.locations.length > 0) {
    (error as { locations?: ReadonlyArray<SourceLocation> }).locations = [
      ...formatted.locations,
    ];
  }

  return error;
}

/**
 * Check if an error should be masked
 */
function shouldMaskError(
  error: GraphQLError,
  options: ErrorMaskingOptions
): boolean {
  // Use custom predicate if provided
  if (options.shouldMask) {
    return options.shouldMask(error);
  }

  // Don't mask Leaven errors (they're intentional). errorToGraphQL() attaches
  // the LeavenError itself as `originalError`, so this covers the real
  // formatError() path.
  if (isLeavenError(error.originalError)) {
    return false;
  }

  // Don't mask errors carrying a known Leaven error code (validation,
  // authentication, not-found, rate limiting, ...). INTERNAL_ERROR is
  // excluded: it is the fallback code assigned to unexpected errors, which
  // are exactly the ones masking is meant to hide.
  const code = error.extensions?.code;
  if (
    typeof code === 'string' &&
    code !== ErrorCode.INTERNAL_ERROR &&
    getErrorCode(code) !== null
  ) {
    return false;
  }

  // Mask all other errors in production
  return options.maskErrors ?? false;
}

/**
 * Apply the transports' masking default to user-supplied options.
 *
 * Errors thrown outside execution are masked unless the caller explicitly
 * sets `maskErrors: false`. An omitted or `undefined` `maskErrors` still
 * masks, and every other option is kept as given.
 *
 * @param options - The user's error formatting options, if any
 * @returns The options with `maskErrors` defaulted to `true`
 */
export function withMaskingDefault(options?: ErrorMaskingOptions): ErrorMaskingOptions {
  return { ...options, maskErrors: options?.maskErrors ?? true };
}

/**
 * Build the generic masked response error for an unexpected failure.
 *
 * Carries the error's `locations` and `path` (when present) so clients can
 * still correlate the failure, with the {@link MASKED_ERROR_MESSAGE} message
 * and an `INTERNAL_ERROR` code.
 *
 * @param error - Anything exposing optional `path` and `locations`
 * @param message - Message to show instead of {@link MASKED_ERROR_MESSAGE}
 * @returns The masked, formatted error
 */
export function maskedErrorFor(
  error: {
    path?: readonly (string | number)[];
    locations?: readonly SourceLocation[];
  },
  message: string = MASKED_ERROR_MESSAGE
): GraphQLFormattedError {
  const { path, locations } = error as { path?: unknown; locations?: unknown };
  const safePath =
    Array.isArray(path) &&
    path.length > 0 &&
    path.every(
      (p: unknown) => typeof p === 'string' || (typeof p === 'number' && Number.isFinite(p))
    )
      ? (path as readonly (string | number)[])
      : undefined;
  const safeLocations: SourceLocation[] | undefined =
    Array.isArray(locations) &&
    locations.length > 0 &&
    locations.every(
      (l: unknown) =>
        typeof l === 'object' &&
        l !== null &&
        typeof (l as SourceLocation).line === 'number' &&
        typeof (l as SourceLocation).column === 'number'
    )
      ? (locations as SourceLocation[]).map(({ line, column }) => ({ line, column }))
      : undefined;
  return {
    message,
    ...(safeLocations ? { locations: safeLocations } : {}),
    ...(safePath ? { path: safePath } : {}),
    extensions: { code: ErrorCode.INTERNAL_ERROR },
  };
}

/**
 * Mask sensitive error information
 */
export function maskError(
  error: GraphQLError,
  options: ErrorMaskingOptions = {}
): GraphQLFormattedError {
  const shouldMask = shouldMaskError(error, options);

  // Use custom formatter if provided
  if (options.formatter) {
    return options.formatter(error, shouldMask);
  }

  if (shouldMask) {
    return maskedErrorFor(error, options.maskedMessage);
  }

  // Build the formatted error using a mutable intermediate object
  const formatted: {
    message: string;
    locations?: typeof error.locations;
    path?: typeof error.path;
    extensions?: Record<string, unknown>;
  } = {
    message: error.message,
  };

  // Include locations if available
  if (error.locations && error.locations.length > 0) {
    formatted.locations = error.locations;
  }

  // Include path if available
  if (error.path && error.path.length > 0) {
    formatted.path = error.path;
  }

  // Include extensions
  if (error.extensions && Object.keys(error.extensions).length > 0) {
    formatted.extensions = { ...error.extensions };
  }

  // Add stack trace in development if enabled, even when the error carries
  // no extensions of its own
  if (options.includeStackTrace) {
    const stack = error.originalError?.stack ?? error.stack;
    if (stack) {
      formatted.extensions = formatted.extensions ?? {};
      formatted.extensions.stackTrace = stack
        .split('\n')
        .map((line) => line.trim());
    }
  }

  return formatted as GraphQLFormattedError;
}

/**
 * Format a single error
 */
export function formatError(
  error: unknown,
  options: ErrorMaskingOptions = {}
): GraphQLFormattedError {
  const graphqlError = errorToGraphQL(error);
  return maskError(graphqlError, options);
}

/**
 * Format an array of errors
 */
export function formatErrors(
  errors: readonly unknown[],
  options: ErrorMaskingOptions = {}
): GraphQLFormattedError[] {
  return errors.map((error) => formatError(error, options));
}
