/**
 * @leaven-graphql/http - Response utilities tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { ErrorCode } from '@leaven-graphql/errors';
import {
  buildResponse,
  sendResponse,
  corsHeaders,
  buildErrorResponse,
  methodNotAllowed,
  preflightResponse,
} from './response';

describe('corsHeaders', () => {
  const req = (origin?: string): Request =>
    new Request('http://localhost/graphql', origin ? { headers: { Origin: origin } } : {});

  test('should not add Vary for the literal wildcard', () => {
    expect(corsHeaders(req('http://a.com')).Vary).toBeUndefined();
  });

  test('should add Vary: Origin when the origin is echoed', () => {
    const headers = corsHeaders(req('http://a.com'), { origin: ['http://a.com'] });
    expect(headers['Access-Control-Allow-Origin']).toBe('http://a.com');
    expect(headers.Vary).toBe('Origin');
  });

  test('should add Vary: Origin when the origin is not allowed', () => {
    const headers = corsHeaders(req('http://b.com'), { origin: ['http://a.com'] });
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers.Vary).toBe('Origin');
  });

  test('should send neither origin nor credentials for a wildcard with credentials', () => {
    for (const origin of [undefined, '*'] as const) {
      const headers = corsHeaders(req('http://evil.com'), { origin, credentials: true });
      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
      expect(headers.Vary).toBe('Origin');
    }
  });

  test('should send neither origin nor credentials for a disallowed origin with credentials', () => {
    const headers = corsHeaders(req('http://b.com'), {
      origin: ['http://a.com'],
      credentials: true,
    });
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  test('should echo an origin allowed by the array with credentials', () => {
    const headers = corsHeaders(req('http://a.com'), {
      origin: ['http://a.com'],
      credentials: true,
    });
    expect(headers['Access-Control-Allow-Origin']).toBe('http://a.com');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers.Vary).toBe('Origin');
  });

  test('should echo an origin allowed by the predicate with credentials', () => {
    const headers = corsHeaders(req('http://a.com'), {
      origin: (o) => o === 'http://a.com',
      credentials: true,
    });
    expect(headers['Access-Control-Allow-Origin']).toBe('http://a.com');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(headers.Vary).toBe('Origin');
  });

  test('should return default CORS headers', () => {
    const request = new Request('http://localhost/graphql', {
      headers: { Origin: 'http://example.com' },
    });

    const headers = corsHeaders(request);

    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    expect(headers['Access-Control-Allow-Headers']).toBe(
      'Content-Type, Authorization'
    );
  });

  test('should use specific origin when configured', () => {
    const request = new Request('http://localhost/graphql', {
      headers: { Origin: 'http://example.com' },
    });

    const headers = corsHeaders(request, {
      origin: 'http://allowed.com',
    });

    expect(headers['Access-Control-Allow-Origin']).toBe('http://allowed.com');
  });

  test('should match origin from array', () => {
    const request = new Request('http://localhost/graphql', {
      headers: { Origin: 'http://example.com' },
    });

    const headers = corsHeaders(request, {
      origin: ['http://example.com', 'http://other.com'],
    });

    expect(headers['Access-Control-Allow-Origin']).toBe('http://example.com');
  });

  test('should use origin function', () => {
    const request = new Request('http://localhost/graphql', {
      headers: { Origin: 'http://example.com' },
    });

    const headers = corsHeaders(request, {
      origin: (origin) => origin.endsWith('.com'),
    });

    expect(headers['Access-Control-Allow-Origin']).toBe('http://example.com');
  });

  test('should include credentials header', () => {
    const request = new Request('http://localhost/graphql');

    const headers = corsHeaders(request, {
      origin: 'http://allowed.com',
      credentials: true,
    });

    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  test('should include max age', () => {
    const request = new Request('http://localhost/graphql');

    const headers = corsHeaders(request, { maxAge: 3600 });

    expect(headers['Access-Control-Max-Age']).toBe('3600');
  });

  test('should include exposed headers', () => {
    const request = new Request('http://localhost/graphql');

    const headers = corsHeaders(request, {
      exposedHeaders: ['X-Custom-Header'],
    });

    expect(headers['Access-Control-Expose-Headers']).toBe('X-Custom-Header');
  });

  test('should use custom methods', () => {
    const request = new Request('http://localhost/graphql');

    const headers = corsHeaders(request, {
      methods: ['GET', 'POST', 'PUT'],
    });

    expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, PUT');
  });
});

/** A code that is deliberately absent from the ErrorCode enum */
const UNKNOWN_ERROR_CODE = 'SOME_UNKNOWN_CODE';

/**
 * Hand-written expected statuses. This table — not the ERROR_CODES registry —
 * is the oracle: it must be edited by hand whenever an ErrorCode is added,
 * which the exhaustiveness test below enforces.
 */
const STATUS_BY_CODE: ReadonlyArray<{ code: string; status: number }> = [
  { code: 'INTERNAL_ERROR', status: 500 },
  { code: 'BAD_REQUEST', status: 400 },
  { code: 'PAYLOAD_TOO_LARGE', status: 413 },
  { code: 'VALIDATION_ERROR', status: 400 },
  { code: 'PARSE_ERROR', status: 400 },
  { code: 'UNAUTHENTICATED', status: 401 },
  { code: 'FORBIDDEN', status: 403 },
  { code: 'NOT_FOUND', status: 404 },
  { code: 'ALREADY_EXISTS', status: 409 },
  { code: 'RATE_LIMITED', status: 429 },
  { code: 'COMPLEXITY_LIMIT', status: 400 },
  { code: 'DEPTH_LIMIT', status: 400 },
  { code: 'PERSISTED_QUERY_NOT_FOUND', status: 400 },
  { code: 'PERSISTED_QUERY_INVALID', status: 400 },
  { code: 'INVALID_INPUT', status: 400 },
  { code: 'MISSING_REQUIRED_FIELD', status: 400 },
  // Unknown codes fall back to the documented 500 default
  { code: UNKNOWN_ERROR_CODE, status: 500 },
];

describe('buildResponse', () => {
  test('should let a lowercase user content-type replace the default', () => {
    const response = buildResponse(
      { data: { a: 1 } },
      { headers: { 'content-type': 'application/graphql-response+json' } }
    );
    expect(response.headers.get('content-type')).toBe('application/graphql-response+json');
  });

  test('should build response with data', async () => {
    const response = buildResponse({
      data: { hello: 'world' },
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).toEqual({ hello: 'world' });
  });

  test('should include errors', async () => {
    const response = buildResponse({
      data: null,
      errors: [{ message: 'Error occurred' }],
    });

    const body = await response.json();
    expect(body.errors[0].message).toBe('Error occurred');
  });

  test('should set status based on error code', async () => {
    const response = buildResponse({
      errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }],
    });

    expect(response.status).toBe(401);
  });

  test('should use custom status', async () => {
    const response = buildResponse(
      { data: { hello: 'world' } },
      { status: 201 }
    );

    expect(response.status).toBe(201);
  });

  test('should include custom headers', () => {
    const response = buildResponse(
      { data: {} },
      { headers: { 'X-Custom': 'value' } }
    );

    expect(response.headers.get('X-Custom')).toBe('value');
  });

  test('should pretty print when enabled', async () => {
    const response = buildResponse(
      { data: { hello: 'world' } },
      { pretty: true }
    );

    const text = await response.text();
    expect(text).toContain('\n');
  });

  test('should set correct status for various error codes', () => {
    for (const { code, status } of STATUS_BY_CODE) {
      const response = buildResponse({
        errors: [{ message: 'Error', extensions: { code } }],
      });
      expect(response.status).toBe(status);
    }
  });

  test('should have a hand-written expected status for every ErrorCode', () => {
    const covered = new Set(STATUS_BY_CODE.map(({ code }) => code));
    const expected = new Set<string>([
      ...Object.values(ErrorCode),
      UNKNOWN_ERROR_CODE,
    ]);

    expect(covered).toEqual(expected);
  });

  test('should default to 500 for an uncoded error with no data', () => {
    const response = buildResponse({
      errors: [{ message: 'Error' }],
    });

    expect(response.status).toBe(500);
  });

  test('should stay 200 for an uncoded error that carries data', () => {
    const response = buildResponse({
      data: { hello: 'world' },
      errors: [{ message: 'Error' }],
    });

    expect(response.status).toBe(200);
  });

  test('should stay 200 for a partial success', async () => {
    const response = buildResponse({
      data: { hello: 'world', broken: null },
      errors: [{ message: 'Resolver failed', path: ['broken'] }],
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).toEqual({ hello: 'world', broken: null });
    expect(body.errors[0].message).toBe('Resolver failed');
  });

  test('should stay 200 for a partial success carrying a NOT_FOUND error', () => {
    const response = buildResponse({
      data: { ok: 'fine', missing: null },
      errors: [
        {
          message: 'User not found',
          path: ['missing'],
          extensions: { code: 'NOT_FOUND' },
        },
      ],
    });

    expect(response.status).toBe(200);
  });

  test('should stay 200 for a partial success carrying an UNAUTHENTICATED error', () => {
    const response = buildResponse({
      data: { ok: 'fine', secret: null },
      errors: [
        {
          message: 'Not authenticated',
          path: ['secret'],
          extensions: { code: 'UNAUTHENTICATED' },
        },
      ],
    });

    expect(response.status).toBe(200);
  });

  test('should escalate a coded error only when data is absent', () => {
    for (const { code, status } of STATUS_BY_CODE) {
      const withData = buildResponse({
        data: { hello: 'world' },
        errors: [{ message: 'Error', extensions: { code } }],
      });
      expect(withData.status).toBe(200);

      const withNullData = buildResponse({
        data: null,
        errors: [{ message: 'Error', extensions: { code } }],
      });
      expect(withNullData.status).toBe(status);
    }
  });

  test('should not remap an explicit status even with errors', () => {
    const response = buildResponse(
      { errors: [{ message: 'Error', extensions: { code: 'NOT_FOUND' } }] },
      { status: 418 }
    );

    expect(response.status).toBe(418);
  });
});

describe('sendResponse', () => {
  test('should be alias for buildResponse', async () => {
    const response = sendResponse({ data: { test: true } });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.test).toBe(true);
  });
});

describe('buildErrorResponse', () => {
  test('should build error response', async () => {
    const response = buildErrorResponse('Something went wrong', 500);

    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.errors[0].message).toBe('Something went wrong');
  });

  test('should include error code', async () => {
    const response = buildErrorResponse('Bad request', 400, 'BAD_REQUEST');

    const body = await response.json();
    expect(body.errors[0].extensions?.code).toBe('BAD_REQUEST');
  });
});

describe('methodNotAllowed', () => {
  test('should return 405 response', () => {
    const response = methodNotAllowed();

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, POST, OPTIONS');
  });

  test('should include custom allowed methods', () => {
    const response = methodNotAllowed(['POST']);

    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('preflightResponse', () => {
  test('should return 204 response', () => {
    const request = new Request('http://localhost/graphql');
    const response = preflightResponse(request);

    expect(response.status).toBe(204);
  });

  test('should include CORS headers', () => {
    const request = new Request('http://localhost/graphql');
    const response = preflightResponse(request);

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeDefined();
    expect(response.headers.get('Access-Control-Allow-Methods')).toBeDefined();
  });
});
