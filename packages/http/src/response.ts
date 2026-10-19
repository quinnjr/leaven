/**
 * @leaven-graphql/http - Response utilities
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { GraphQLResponse } from '@leaven-graphql/core';
import { statusForResponse } from '@leaven-graphql/errors';

/**
 * CORS configuration
 */
export interface CorsConfig {
  /** Allowed origins (default: '*') */
  origin?: string | string[] | ((origin: string) => boolean);
  /** Allowed methods */
  methods?: string[];
  /** Allowed headers */
  allowedHeaders?: string[];
  /** Exposed headers */
  exposedHeaders?: string[];
  /** Allow credentials */
  credentials?: boolean;
  /** Max age for preflight cache */
  maxAge?: number;
}

/**
 * Response options
 */
export interface ResponseOptions {
  /** HTTP status code */
  status?: number;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Pretty print JSON */
  pretty?: boolean;
}

/**
 * Build CORS headers
 */
export function corsHeaders(
  request: Request,
  config: CorsConfig = {}
): Record<string, string> {
  const headers: Record<string, string> = {};
  const origin = request.headers.get('origin') ?? '*';

  // Access-Control-Allow-Origin
  if (config.origin === undefined || config.origin === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (typeof config.origin === 'string') {
    headers['Access-Control-Allow-Origin'] = config.origin;
  } else if (Array.isArray(config.origin)) {
    if (config.origin.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
  } else if (typeof config.origin === 'function') {
    if (config.origin(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
  }

  // NOTE: the CORS rules below (Vary: Origin unless '*', credentials only with
  // an explicit origin) are mirrored in packages/nestjs/src/middleware.ts:
  // `applyCorsHeaders` emits Vary and credentials, and `resolveAllowedOrigin`
  // picks the origin. They must stay in step (nestjs does not depend on http).
  // A credentialed response cannot use the '*' wildcard, and echoing the
  // request Origin in its place would let ANY site make credentialed reads.
  // Only an origin that passed an explicit string, array or predicate check
  // may be paired with credentials, so a wildcard drops both headers.
  if (config.credentials && headers['Access-Control-Allow-Origin'] === '*') {
    delete headers['Access-Control-Allow-Origin'];
  }
  const credentialsAllowed =
    config.credentials === true && headers['Access-Control-Allow-Origin'] !== undefined;

  // The emitted origin depends on the request unless it is the literal '*'.
  if (headers['Access-Control-Allow-Origin'] !== '*') {
    headers['Vary'] = 'Origin';
  }

  // Access-Control-Allow-Methods
  if (config.methods) {
    headers['Access-Control-Allow-Methods'] = config.methods.join(', ');
  } else {
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }

  // Access-Control-Allow-Headers
  if (config.allowedHeaders) {
    headers['Access-Control-Allow-Headers'] = config.allowedHeaders.join(', ');
  } else {
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
  }

  // Access-Control-Expose-Headers
  if (config.exposedHeaders) {
    headers['Access-Control-Expose-Headers'] = config.exposedHeaders.join(', ');
  }

  // Access-Control-Allow-Credentials
  if (credentialsAllowed) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  // Access-Control-Max-Age
  if (config.maxAge !== undefined) {
    headers['Access-Control-Max-Age'] = config.maxAge.toString();
  }

  return headers;
}

/**
 * Build a Response from a GraphQL response
 */
export function buildResponse(
  response: GraphQLResponse,
  options: ResponseOptions = {}
): Response {
  // An explicit non-200 status wins; 200 (or unset) defers to
  // statusForResponse. Otherwise only a total failure (`data` absent or
  // `null`) changes it: a response with non-null `data` is a spec-conformant
  // partial success and MUST stay 200, or clients treat it as a network error and discard the
  // data they were given. statusForResponse maps the first error's code via
  // the ERROR_CODES registry (the single source of truth), falling back to 500.
  const requested = options.status ?? 200;
  const status = requested === 200 ? statusForResponse(response) : requested;

  // Build response body
  const body = options.pretty
    ? JSON.stringify(response, null, 2)
    : JSON.stringify(response);

  // Build headers
  // `.set` replaces case-insensitively, so a user `content-type` overrides the
  // default instead of being combined with it.
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers.set(key, value);
  }

  return new Response(body, { status, headers });
}

/**
 * Send a GraphQL response (alias for buildResponse)
 */
export function sendResponse(
  response: GraphQLResponse,
  options?: ResponseOptions
): Response {
  return buildResponse(response, options);
}

/**
 * Build an error response
 */
export function buildErrorResponse(
  message: string,
  status: number = 400,
  code?: string,
  options?: ResponseOptions
): Response {
  const response: GraphQLResponse = {
    errors: [
      {
        message,
        extensions: code ? { code } : undefined,
      },
    ],
  };

  return buildResponse(response, { ...options, status });
}

/**
 * Build a method not allowed response
 */
export function methodNotAllowed(
  allowedMethods: string[] = ['GET', 'POST', 'OPTIONS']
): Response {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: {
      Allow: allowedMethods.join(', '),
    },
  });
}

/**
 * Build a preflight response for CORS
 */
export function preflightResponse(
  request: Request,
  config?: CorsConfig
): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, config),
  });
}
