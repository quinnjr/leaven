/**
 * @leaven-graphql/http - Request parsing tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  mediaType,
  parseBody,
  parseQuery,
  UnsupportedMediaTypeError,
  validateRequest,
  type ParsedBody,
} from './request';

/**
 * Build a graphql-multipart-request-spec POST carrying one file under key `0`
 */
function multipartRequest(
  operations: Record<string, unknown>,
  map: Record<string, string[]>
): Request {
  const formData = new FormData();
  formData.append('operations', JSON.stringify(operations));
  formData.append('map', JSON.stringify(map));
  formData.append('0', new File(['file content'], 'upload.txt', { type: 'text/plain' }));

  return new Request('http://localhost/graphql', {
    method: 'POST',
    body: formData,
  });
}

describe('parseBody', () => {
  test('should parse JSON body', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ hello }',
        operationName: 'TestQuery',
        variables: { id: '1' },
      }),
    });

    const result = await parseBody(request);

    expect(result.query).toBe('{ hello }');
    expect(result.operationName).toBe('TestQuery');
    expect(result.variables).toEqual({ id: '1' });
  });

  test('should parse application/graphql body', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/graphql' },
      body: '{ hello }',
    });

    const result = await parseBody(request);

    expect(result.query).toBe('{ hello }');
  });

  test('should parse form body', async () => {
    const formData = new FormData();
    formData.append('query', '{ hello }');
    formData.append('variables', '{"id": "1"}');

    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      body: formData,
    });

    const result = await parseBody(request);

    expect(result.query).toBe('{ hello }');
    expect(result.variables).toEqual({ id: '1' });
  });

  test('should throw for invalid JSON', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    await expect(parseBody(request)).rejects.toThrow(/Invalid JSON/);
  });

  test.each(['5', '"x"', '[1]', 'null'])(
    'should reject valid non-object JSON body %s',
    async (body) => {
      const request = new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      await expect(parseBody(request)).rejects.toThrow('Request body must be a JSON object');
    }
  );

  test('should handle empty body', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });

    const result = await parseBody(request);

    expect(result).toEqual({});
  });

  test.each([
    ['null', 'null', undefined, '"operations" must be a JSON object'],
    ['invalid JSON', '{bad', undefined, 'Invalid JSON in "operations"'],
    ['a null map', '{"query":"{ hello }"}', 'null', '"map" must be a JSON object'],
    ['an invalid map', '{"query":"{ hello }"}', '{bad', 'Invalid JSON in "map"'],
    ['a map entry that is not an array', '{"query":"{ hello }"}', '{"0":"x"}', '"map" entries must be arrays of strings'],
  ])('should reject a multipart body with %s using a fixed message', async (_label, operations, map, message) => {
    const formData = new FormData();
    formData.append('operations', operations);
    if (map !== undefined) formData.append('map', map);
    const request = new Request('http://localhost/graphql', { method: 'POST', body: formData });

    await expect(parseBody(request)).rejects.toThrow(message);
  });

  test.each([
    ['multipart/form-data; boundary=abc', 'Invalid multipart body'],
  ])('should reject an unparseable %s body using a fixed message', async (contentType, message) => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: 'garbage',
    });

    await expect(parseBody(request)).rejects.toThrow(message);
  });

  test.each(['"not-an-object"', '5', 'true', '[]'])(
    'should reject non-object variables (%s) in an upload whose map targets them',
    async (variables) => {
      const formData = new FormData();
      formData.append('operations', `{"query":"{ hello }","variables":${variables}}`);
      formData.append('map', '{"0":["variables.file"]}');
      formData.append('0', new File(['x'], 'a.txt'));
      const request = new Request('http://localhost/graphql', { method: 'POST', body: formData });

      await expect(parseBody(request)).rejects.toThrow('"variables" must be a JSON object');
    }
  );

  test('should reject a multipart map entry with a non-string path using a fixed message', async () => {
    const formData = new FormData();
    formData.append('operations', '{"query":"{ hello }"}');
    formData.append('map', '{"0":[1]}');
    // A file under the mapped key, so only the string check can stop it
    formData.append('0', new File(['x'], 'a.txt'));
    const request = new Request('http://localhost/graphql', { method: 'POST', body: formData });

    await expect(parseBody(request)).rejects.toThrow('"map" entries must be arrays of strings');
  });

  test('should parse multipart body with operations', async () => {
    const formData = new FormData();
    formData.append(
      'operations',
      JSON.stringify({
        query: '{ hello }',
        variables: { file: null },
      })
    );
    formData.append('map', JSON.stringify({ '0': ['variables.file'] }));
    formData.append('0', new Blob(['file content'], { type: 'text/plain' }));

    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      body: formData,
    });

    const result = await parseBody(request);

    expect(result.query).toBe('{ hello }');
  });

  test('should map an uploaded file onto the operation variables', async () => {
    const result = await parseBody(
      multipartRequest(
        { query: '{ hello }', variables: { file: null } },
        { '0': ['variables.file'] }
      )
    );

    const file = result.variables?.file;
    expect(file).toBeInstanceOf(Blob);
    expect(await (file as Blob).text()).toBe('file content');
  });

  test('should create missing intermediates along a mapped file path', async () => {
    const result = await parseBody(
      multipartRequest({ query: '{ hello }' }, { '0': ['variables.input.file'] })
    );

    const input = result.variables?.input as Record<string, unknown>;
    expect(await (input.file as Blob).text()).toBe('file content');
  });

  test('should parse application/x-www-form-urlencoded body', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'query=%7B%20hello%20%7D&operationName=Test&variables=%7B%22id%22%3A%221%22%7D',
    });

    const result = await parseBody(request);

    expect(result.query).toBe('{ hello }');
    expect(result.operationName).toBe('Test');
    expect(result.variables).toEqual({ id: '1' });
  });

  test('should parse multipart body without operations field', async () => {
    const formData = new FormData();
    formData.append('query', '{ users { name } }');
    formData.append('operationName', 'GetUsers');

    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      body: formData,
    });

    const result = await parseBody(request);

    expect(result.query).toBe('{ users { name } }');
    expect(result.operationName).toBe('GetUsers');
  });

  test('should reject text/plain with UnsupportedMediaTypeError', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ query: '{ hello }' }),
    });

    const error = await parseBody(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedMediaTypeError);
    expect((error as Error).message).toMatch(/Unsupported content type/);
  });

  test('should not fall back to JSON for an unknown content type with valid JSON', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/unknown' },
      body: JSON.stringify({ query: '{ hello }' }),
    });

    await expect(parseBody(request)).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
  });

  test('should not match a known media type inside a parameter', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; x=application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    });

    await expect(parseBody(request)).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
  });

  test('should not match a media type that merely contains a known one', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/jsonx' },
      body: JSON.stringify({ query: '{ hello }' }),
    });

    await expect(parseBody(request)).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
  });

  test('should match the media type case-insensitively and ignore parameters', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': ' Application/JSON ; charset=utf-8' },
      body: JSON.stringify({ query: '{ hello }' }),
    });

    const result = await parseBody(request);
    expect(result.query).toBe('{ hello }');
  });

  test('should reject a body with no Content-Type', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      body: new TextEncoder().encode(JSON.stringify({ query: '{ hello }' })),
    });
    expect(request.headers.get('content-type')).toBeNull();

    await expect(parseBody(request)).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
  });

  test('should return no parameters for an empty body with no Content-Type', async () => {
    const request = new Request('http://localhost/graphql', { method: 'POST' });

    expect(await parseBody(request)).toEqual({});
  });

  test('should return no parameters for an empty body with an unknown Content-Type', async () => {
    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '',
    });

    expect(await parseBody(request)).toEqual({});
  });
});

describe('mediaType', () => {
  test('should return the lowercased essence without parameters', () => {
    expect(mediaType('Multipart/Form-Data; boundary=abc')).toBe('multipart/form-data');
  });

  test('should take the first value of a comma-joined header', () => {
    expect(mediaType('text/plain, application/json')).toBe('text/plain');
  });

  test('should return the empty string for a missing header', () => {
    expect(mediaType(null)).toBe('');
    expect(mediaType(undefined)).toBe('');
  });
});

describe('multipart file path safety', () => {
  afterEach(() => {
    // A failing guard would poison every object in the process, so make sure
    // one broken assertion cannot cascade into unrelated tests.
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  /** Read the key an attack would have planted on the shared prototype */
  function prototypeLeak(): unknown {
    return ({} as Record<string, unknown>).polluted;
  }

  test('should not reach Object.prototype through a __proto__ root', async () => {
    await parseBody(
      multipartRequest({ query: '{ hello }' }, { '0': ['__proto__.polluted'] })
    );

    expect(prototypeLeak()).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')
    ).toBe(false);
  });

  test('should not reach Object.prototype through a nested __proto__ segment', async () => {
    const result = await parseBody(
      multipartRequest(
        { query: '{ hello }', variables: {} },
        { '0': ['variables.__proto__.polluted'] }
      )
    );

    expect(prototypeLeak()).toBeUndefined();
    expect(result.variables).toEqual({});
  });

  test('should not reach Object.prototype through constructor.prototype', async () => {
    await parseBody(
      multipartRequest(
        { query: '{ hello }', variables: {} },
        { '0': ['variables.constructor.prototype.polluted'] }
      )
    );

    expect(prototypeLeak()).toBeUndefined();
  });

  test('should ignore a path whose root is not a spec-legal target', async () => {
    const result = await parseBody(
      multipartRequest({ query: '{ hello }' }, { '0': ['query'] })
    );

    // The query must survive: a rogue path is dropped, not applied.
    expect(result.query).toBe('{ hello }');
  });
});

describe('parseQuery', () => {
  test('should parse query parameters', () => {
    const url = new URL(
      'http://localhost/graphql?query={ hello }&operationName=Test&variables={"id":"1"}'
    );

    const result = parseQuery(url);

    expect(result.query).toBe('{ hello }');
    expect(result.operationName).toBe('Test');
    expect(result.variables).toEqual({ id: '1' });
  });

  test('should handle missing parameters', () => {
    const url = new URL('http://localhost/graphql');

    const result = parseQuery(url);

    expect(result.query).toBeUndefined();
    expect(result.operationName).toBeUndefined();
    expect(result.variables).toBeUndefined();
  });

  test('should throw on invalid JSON in variables', () => {
    const url = new URL('http://localhost/graphql?query={ hello }&variables=notjson');

    expect(() => parseQuery(url)).toThrow('Invalid JSON in "variables"');
  });

  test('should throw on invalid JSON in extensions', () => {
    const url = new URL('http://localhost/graphql?query={ hello }&extensions=notjson');

    expect(() => parseQuery(url)).toThrow('Invalid JSON in "extensions"');
  });

  test('should leave the shape check of non-object variables to validateRequest', () => {
    for (const raw of ['[1]', '5', '"x"']) {
      const url = new URL(
        `http://localhost/graphql?query={ hello }&variables=${encodeURIComponent(raw)}`
      );
      const parsed = parseQuery(url);
      expect(parsed.variables as unknown).toEqual(JSON.parse(raw));
      const validation = validateRequest({}, parsed);
      expect(validation.valid).toBe(false);
      expect(validation.error).toBe('"variables" must be a JSON object');
    }
  });

  test('should treat null variables as none', () => {
    const url = new URL('http://localhost/graphql?query={ hello }&variables=null');

    expect(parseQuery(url).variables).toBeUndefined();
  });
});

describe('parseBody strict variables/extensions', () => {
  const jsonRequest = (payload: unknown): Request =>
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  test('should reject array variables in a JSON body at validation', async () => {
    const parsed = await parseBody(jsonRequest({ query: '{ hello }', variables: [1] }));
    const validation = validateRequest(parsed);
    expect(validation.valid).toBe(false);
    expect(validation.error).toBe('"variables" must be a JSON object');
  });

  test('should reject unparseable string variables in a JSON body', async () => {
    await expect(
      parseBody(jsonRequest({ query: '{ hello }', variables: 'nope' }))
    ).rejects.toThrow('Invalid JSON in "variables"');
  });

  test('should reject non-object extensions in a JSON body at validation', async () => {
    const parsed = await parseBody(jsonRequest({ query: '{ hello }', extensions: 5 }));
    const validation = validateRequest(parsed);
    expect(validation.valid).toBe(false);
    expect(validation.error).toBe('"extensions" must be a JSON object');
  });

  test('should reject non-object multipart operations variables', async () => {
    const formData = new FormData();
    formData.append('operations', JSON.stringify({ query: '{ hello }', variables: [1] }));
    formData.append('map', '{}');

    // Rejected while parsing, before the map is applied, with the message
    // validateRequest would give
    await expect(
      parseBody(new Request('http://localhost/graphql', { method: 'POST', body: formData }))
    ).rejects.toThrow('"variables" must be a JSON object');
  });

  test('should reject non-object multipart operations variables at validation without a map', async () => {
    const formData = new FormData();
    formData.append('operations', JSON.stringify({ query: '{ hello }', variables: [1] }));

    const parsed = await parseBody(
      new Request('http://localhost/graphql', { method: 'POST', body: formData })
    );
    const validation = validateRequest(parsed);
    expect(validation.valid).toBe(false);
    expect(validation.error).toBe('"variables" must be a JSON object');
  });

  test('should parse extensions in multipart without operations', async () => {
    const formData = new FormData();
    formData.append('query', '{ hello }');
    formData.append('extensions', '{"a":1}');

    const result = await parseBody(
      new Request('http://localhost/graphql', { method: 'POST', body: formData })
    );

    expect(result.extensions).toEqual({ a: 1 });
  });
});

describe('validateRequest', () => {
  test('should reject a non-string query', () => {
    const result = validateRequest({ query: 5 as unknown as string });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('"query" must be a string');
  });

  test('should reject a non-string operationName', () => {
    const result = validateRequest({
      query: '{ a }',
      operationName: 5 as unknown as string,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('"operationName" must be a string');
  });

  test('should reject non-object variables and extensions', () => {
    const v = validateRequest({
      query: '{ a }',
      variables: [1] as unknown as Record<string, unknown>,
    });
    expect(v.error).toBe('"variables" must be a JSON object');
    const e = validateRequest({
      query: '{ a }',
      extensions: 'x' as unknown as Record<string, unknown>,
    });
    expect(e.error).toBe('"extensions" must be a JSON object');
  });

  test('should validate valid request', () => {
    const result = validateRequest(
      { query: '{ hello }' },
      {}
    );

    expect(result.valid).toBe(true);
    expect(result.request?.query).toBe('{ hello }');
  });

  test('should accept a body on its own', () => {
    const body: ParsedBody = { query: '{ hello }', operationName: 'Test' };

    const result = validateRequest(body);

    expect(result.valid).toBe(true);
    expect(result.request?.query).toBe('{ hello }');
    expect(result.request?.operationName).toBe('Test');
  });

  test('should merge body and query params', () => {
    const result = validateRequest(
      { query: '{ hello }', operationName: 'FromBody' },
      { operationName: 'FromQuery', variables: { id: '1' } }
    );

    expect(result.valid).toBe(true);
    expect(result.request?.operationName).toBe('FromBody'); // Body takes precedence
    expect(result.request?.variables).toEqual({ id: '1' });
  });

  test('should use query params when body is empty', () => {
    const result = validateRequest(
      {},
      { query: '{ hello }' }
    );

    expect(result.valid).toBe(true);
    expect(result.request?.query).toBe('{ hello }');
  });

  test('should invalidate when query is missing', () => {
    const result = validateRequest({}, {});

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Query is required');
  });
});
