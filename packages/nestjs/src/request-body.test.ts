/**
 * @leaven-graphql/nestjs - request-body helper tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { ErrorCode, isLeavenError, ValidationError } from '@leaven-graphql/errors';

import {
  DEFAULT_CSRF_REQUEST_HEADERS,
  isCsrfBlocked,
  mediaType,
  readHeader,
  readBodyText,
  resolveCsrfRequestHeaders,
  validateGraphQLBody,
  validateVariables,
} from './request-body';

const post = (body: BodyInit): Request =>
  new Request('http://localhost/graphql', { method: 'POST', body });

describe('readBodyText', () => {
  test.each([
    ['Infinity', Infinity],
    ['0', 0],
    ['NaN', Number.NaN],
    ['a negative number', -1],
  ])('should read a normal body with no deadline when the timeout is %s', async (_label, timeoutMs) => {
    const timer = spyOn(globalThis, 'setTimeout');
    try {
      const text = await readBodyText(post('{"query":"{ hello }"}'), 1_000, timeoutMs);

      expect(text).toBe('{"query":"{ hello }"}');
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });

  test('should clamp a timeout over 2^31-1 so it does not fire early', async () => {
    const timer = spyOn(globalThis, 'setTimeout');
    try {
      // Give an unclamped (~1ms) timer the chance to fire before the body ends
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
          await Bun.sleep(20);
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        },
      });

      const text = await readBodyText(post(stream), 1_000, 2 ** 40);

      expect(text).toBe('{}');
      expect(timer.mock.calls[0]?.[1]).toBe(2 ** 31 - 1);
    } finally {
      timer.mockRestore();
    }
  });

  test('should report an already-consumed body as a BAD_REQUEST LeavenError', async () => {
    const request = post('{"query":"{ hello }"}');
    await request.text();

    let caught: unknown;
    try {
      await readBodyText(request, 1_000, 1_000);
    } catch (error) {
      caught = error;
    }

    expect(isLeavenError(caught)).toBe(true);
    if (isLeavenError(caught)) {
      expect(caught.message).toBe('Failed to read request body');
      expect(caught.code).toBe(ErrorCode.BAD_REQUEST);
      expect(caught.statusCode).toBe(400);
      expect(caught.originalError).toBeInstanceOf(TypeError);
    }
  });

  test('should reject an honest Content-Length over the limit with 413 without reading', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      body: 'x'.repeat(20),
      headers: { 'Content-Length': '20' },
    });

    await expect(readBodyText(request, 10, 1_000)).rejects.toMatchObject({
      message: 'Request body too large',
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      statusCode: 413,
    });
    expect(request.bodyUsed).toBe(false);
  });

  test('should reject a streamed body over the limit with 413 when Content-Length is absent', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('x'.repeat(8)));
        controller.enqueue(new TextEncoder().encode('x'.repeat(8)));
        controller.close();
      },
    });

    await expect(readBodyText(post(stream), 10, 1_000)).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      statusCode: 413,
    });
  });

  test('should report a client abort mid-read as a BAD_REQUEST LeavenError', async () => {
    const abort = new Error('socket hang up');
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('{"query"'));
      },
      pull(controller): void {
        controller.error(abort);
      },
    });

    let caught: unknown;
    try {
      await readBodyText(post(stream), 1_000, 1_000);
    } catch (error) {
      caught = error;
    }

    expect(isLeavenError(caught)).toBe(true);
    if (isLeavenError(caught)) {
      expect(caught.message).toBe('Failed to read request body');
      expect(caught.code).toBe(ErrorCode.BAD_REQUEST);
      expect(caught.statusCode).toBe(400);
      expect(caught.originalError).toBe(abort);
    }
  });

  test('should report a body that misses the deadline as a BAD_REQUEST LeavenError', async () => {
    // A stream that never produces a chunk or closes
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });

    await expect(readBodyText(post(stream), 1_000, 10)).rejects.toMatchObject({
      message: 'Timed out reading request body after 10ms',
      code: ErrorCode.BAD_REQUEST,
      statusCode: 400,
    });
  });

  test('should report a locked body as a BAD_REQUEST LeavenError', async () => {
    const request = post('{"query":"{ hello }"}');
    const lock = request.body?.getReader();

    await expect(readBodyText(request, 1_000, 1_000)).rejects.toMatchObject({
      message: 'Failed to read request body',
      code: ErrorCode.BAD_REQUEST,
    });
    lock?.releaseLock();
  });
});

describe('mediaType', () => {
  test.each([
    ['application/json', 'application/json'],
    ['application/json; charset=utf-8', 'application/json'],
    ['Application/JSON', 'application/json'],
    ['  TEXT/Plain ;x=application/json', 'text/plain'],
    ['text/plain;application/json', 'text/plain'],
    ['application/graphql, application/json', 'application/graphql'],
    ['', ''],
    [';charset=utf-8', ''],
  ])('should map %p to %p', (input, expected) => {
    expect(mediaType(input)).toBe(expected);
  });

  test('should map a missing header (null or undefined) to the empty string', () => {
    expect(mediaType(null)).toBe('');
    expect(mediaType(undefined)).toBe('');
  });
});

describe('resolveCsrfRequestHeaders', () => {
  test('should use the defaults when unset, true, or given no requestHeaders', () => {
    for (const option of [undefined, true, {}]) {
      expect(resolveCsrfRequestHeaders(option)).toEqual(DEFAULT_CSRF_REQUEST_HEADERS);
    }
    expect(DEFAULT_CSRF_REQUEST_HEADERS).toEqual([
      'x-graphql-csrf',
      'apollo-require-preflight',
      'x-apollo-operation-name',
    ]);
  });

  test('should disable the check for false', () => {
    expect(resolveCsrfRequestHeaders(false)).toBeUndefined();
  });

  test('should trim and lowercase configured names', () => {
    expect(resolveCsrfRequestHeaders({ requestHeaders: [' X-My-CSRF ', 'Other'] })).toEqual([
      'x-my-csrf',
      'other',
    ]);
  });

  test.each([[''], ['   '], ['bad header'], ['a:b'], ['x\u00e9'], [42 as unknown as string]])(
    'should throw a TypeError for the header name %p',
    (name) => {
      expect(() => resolveCsrfRequestHeaders({ requestHeaders: [name] })).toThrow(TypeError);
    }
  );
});

describe('isCsrfBlocked', () => {
  const none = (): undefined => undefined;

  test.each([
    [undefined],
    [null],
    [''],
    ['text/plain'],
    ['application/x-www-form-urlencoded; charset=utf-8'],
    ['Multipart/Form-Data; boundary=x'],
  ])('should block a %p POST without a preflight header', (contentType) => {
    expect(isCsrfBlocked(contentType, none, DEFAULT_CSRF_REQUEST_HEADERS)).toBe(true);
  });

  test.each([['application/json'], ['application/graphql'], ['text/plain-ish']])(
    'should not block a non-simple %p POST',
    (contentType) => {
      expect(isCsrfBlocked(contentType, none, DEFAULT_CSRF_REQUEST_HEADERS)).toBe(false);
    }
  );

  test('should not block when a preflight header is non-empty, and block when it is blank', () => {
    const headers = (value: string) => (name: string) =>
      name === 'apollo-require-preflight' ? value : null;

    expect(isCsrfBlocked('text/plain', headers('true'), DEFAULT_CSRF_REQUEST_HEADERS)).toBe(false);
    expect(isCsrfBlocked('text/plain', headers('  '), DEFAULT_CSRF_REQUEST_HEADERS)).toBe(true);
  });
});

describe('validateVariables', () => {
  test.each([
    ['undefined', undefined, undefined],
    ['null', null, undefined],
    ['an empty object', {}, {}],
    ['an object', { id: 1 }, { id: 1 }],
  ])('should accept %s', (_label, input, expected) => {
    expect(validateVariables(input)).toEqual(expected);
  });

  test.each([
    ['an array', [1]],
    ['a string', '{"id":1}'],
    ['a number', 1],
    ['a boolean', true],
  ])('should throw a ValidationError for %s', (_label, input) => {
    expect(() => validateVariables(input)).toThrow(ValidationError);
    expect(() => validateVariables(input)).toThrow('"variables" must be a JSON object');
  });
});

describe('validateGraphQLBody', () => {
  test.each([
    ['a bare query', { query: '{ a }' }, { query: '{ a }', variables: undefined, operationName: undefined }],
    [
      'null variables and operationName',
      { query: '{ a }', variables: null, operationName: null },
      { query: '{ a }', variables: undefined, operationName: undefined },
    ],
    [
      'variables and an operationName',
      { query: 'query A { a }', variables: { x: 1 }, operationName: 'A' },
      { query: 'query A { a }', variables: { x: 1 }, operationName: 'A' },
    ],
  ])('should accept %s', (_label, body, expected) => {
    expect(validateGraphQLBody(body)).toEqual(expected);
  });

  test.each([
    ['a null body', null, 'Request body must be a JSON object'],
    ['an array body', [{ query: '{ a }' }], 'Request body must be a JSON object'],
    ['a string body', '{ a }', 'Request body must be a JSON object'],
    ['a missing query', {}, 'Query is required'],
    ['an empty query', { query: '' }, 'Query is required'],
    ['a non-string query', { query: 1 }, 'Query is required'],
    ['array variables', { query: '{ a }', variables: [] }, '"variables" must be a JSON object'],
    ['string variables', { query: '{ a }', variables: '{}' }, '"variables" must be a JSON object'],
    ['a non-string operationName', { query: '{ a }', operationName: 1 }, '"operationName" must be a string'],
  ])('should throw a coded ValidationError for %s', (_label, body, message) => {
    let caught: unknown;
    try {
      validateGraphQLBody(body);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toBe(message);
    expect((caught as ValidationError).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((caught as ValidationError).statusCode).toBe(400);
  });
});

describe('readHeader', () => {
  test('should read the exact lowercase key from a Node map', () => {
    expect(readHeader({ origin: 'https://a.test' }, 'origin')).toBe('https://a.test');
  });

  test('should read a capitalised key case-insensitively', () => {
    expect(readHeader({ 'X-GraphQL-CSRF': '1' }, 'x-graphql-csrf')).toBe('1');
  });

  test('should join an array value with a comma', () => {
    expect(readHeader({ Accept: ['a', 'b'] }, 'accept')).toBe('a,b');
  });

  test('should read from a Fetch Headers instance', () => {
    expect(readHeader(new Headers({ 'Content-Type': 'text/plain' }), 'content-type')).toBe(
      'text/plain'
    );
  });

  test('should not read inherited Object.prototype members as headers', () => {
    expect(readHeader({ 'content-type': 'text/plain' }, 'constructor')).toBeUndefined();
    expect(readHeader({ 'content-type': 'text/plain' }, '__proto__')).toBeUndefined();
    expect(readHeader({ 'content-type': 'text/plain' }, 'tostring')).toBeUndefined();
  });

  test('should ignore a non-string value in a hand-built map', () => {
    const headers = { 'x-count': 5 } as unknown as Record<string, string>;
    expect(readHeader(headers, 'x-count')).toBeUndefined();
  });

  test('should block rather than throw when a configured CSRF header name is inherited', () => {
    const headers = { 'content-type': 'text/plain' };
    const requestHeaders = resolveCsrfRequestHeaders({ requestHeaders: ['constructor'] })!;
    expect(
      isCsrfBlocked('text/plain', (name) => readHeader(headers, name), requestHeaders)
    ).toBe(true);
  });

  test('should return undefined for a missing header or missing map', () => {
    expect(readHeader({ host: 'x' }, 'origin')).toBeUndefined();
    expect(readHeader(new Headers(), 'origin')).toBeUndefined();
    expect(readHeader(undefined, 'origin')).toBeUndefined();
  });
});
