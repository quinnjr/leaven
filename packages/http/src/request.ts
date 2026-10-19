/**
 * @leaven-graphql/http - Request parsing utilities
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { GraphQLRequest } from '@leaven-graphql/core';
import { isPlainObject } from '@leaven-graphql/errors';

/**
 * Parsed request body
 */
export interface ParsedBody {
  /** The GraphQL query */
  query?: string;
  /** Operation name */
  operationName?: string;
  /** Variables */
  variables?: Record<string, unknown>;
  /** Extensions */
  extensions?: Record<string, unknown>;
}

/**
 * Request validation result
 */
export interface RequestValidation {
  /** Whether the request is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Parsed GraphQL request */
  request?: GraphQLRequest;
}

/**
 * Raised by `parseBody` when the request's Content-Type is not one Leaven
 * accepts. Transports answer it with 415 Unsupported Media Type.
 */
export class UnsupportedMediaTypeError extends Error {
  constructor(message = 'Unsupported content type') {
    super(message);
    this.name = 'UnsupportedMediaTypeError';
  }
}

/**
 * Extract the media type essence from a Content-Type header value.
 *
 * Takes the first value of a (possibly comma-joined) header, drops any
 * parameters after `;`, and returns it trimmed and lowercased. A missing
 * header yields the empty string.
 *
 * Twin of `mediaType` in `packages/nestjs/src/request-body.ts`: the two must
 * stay in step (nestjs does not depend on http).
 *
 * @param contentType - The raw Content-Type header value
 * @returns The media type, e.g. `application/json`
 */
export function mediaType(contentType: string | null | undefined): string {
  const first = (contentType ?? '').split(',')[0] ?? '';
  return (first.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * Parse a request body into a GraphQL request.
 *
 * Dispatches on the exact media type: `application/json`,
 * `application/graphql`, `application/x-www-form-urlencoded` and
 * `multipart/form-data`. Any other Content-Type (a missing one included)
 * throws `UnsupportedMediaTypeError`, unless the body is empty, in which case
 * the request carries no body parameters and `{}` is returned.
 *
 * @throws UnsupportedMediaTypeError for an unsupported Content-Type (a 415)
 * @throws Error for a malformed body (a 400): JSON that does not decode or is
 * not an object; undecodable `variables`/`extensions`; a form or multipart
 * body that cannot be parsed; or, for a graphql-multipart-request-spec
 * upload, an `operations`/`map` field that is not a JSON object, a `map`
 * entry that is not an array of strings, or (with a `map`) a non-object
 * `variables` in `operations`
 */
export async function parseBody(request: Request): Promise<ParsedBody> {
  switch (mediaType(request.headers.get('content-type'))) {
    case 'application/json':
      return parseJsonBody(request);
    case 'application/graphql':
      return { query: await request.text() };
    case 'application/x-www-form-urlencoded':
      return parseFormBody(request);
    case 'multipart/form-data':
      // formData() reads the boundary from the untouched Content-Type header.
      return parseMultipartBody(request);
    default: {
      // An empty body has no parameters to parse; the URL supplies them.
      const text = await request.text();
      if (text === '') {
        return {};
      }
      throw new UnsupportedMediaTypeError();
    }
  }
}

/**
 * Parse JSON body
 */
async function parseJsonBody(request: Request): Promise<ParsedBody> {
  const text = await request.text();

  if (!text) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON in request body');
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Request body must be a JSON object');
  }
  const body = parsed;

  return {
    query: body.query as string | undefined,
    operationName: body.operationName as string | undefined,
    variables: parseJsonObject(body.variables, 'variables'),
    extensions: parseJsonObject(body.extensions, 'extensions'),
  };
}

/**
 * Parse form body
 */
async function parseFormBody(request: Request): Promise<ParsedBody> {
  const formData = await readFormData(request, 'Invalid form body');

  return {
    query: formData.get('query')?.toString(),
    operationName: formData.get('operationName')?.toString(),
    variables: parseJsonObject(formData.get('variables')?.toString(), 'variables'),
    extensions: parseJsonObject(formData.get('extensions')?.toString(), 'extensions'),
  };
}

/**
 * Parse multipart body
 */
async function parseMultipartBody(request: Request): Promise<ParsedBody> {
  const formData = await readFormData(request, 'Invalid multipart body');
  const operations = formData.get('operations');

  if (!operations) {
    return {
      query: formData.get('query')?.toString(),
      operationName: formData.get('operationName')?.toString(),
      variables: parseJsonObject(formData.get('variables')?.toString(), 'variables'),
      extensions: parseJsonObject(formData.get('extensions')?.toString(), 'extensions'),
    };
  }

  // Handle graphql-multipart-request-spec. Malformed fields get fixed
  // messages, as on the JSON path, rather than the runtime's own error text.
  const opsJson = decodeMultipartField(operations.toString(), 'operations');
  const map = formData.get('map');

  if (map) {
    // Check `variables` (the only map target validateRequest also checks)
    // before the map is applied: setPath replaces a non-object segment, so a
    // malformed `variables` would otherwise be silently swapped for an object
    // holding only the files.
    if (opsJson.variables != null && !isPlainObject(opsJson.variables)) {
      throw new Error('"variables" must be a JSON object');
    }

    const mapJson = decodeMultipartField(map.toString(), 'map');

    // Apply file mappings
    for (const [key, paths] of Object.entries(mapJson)) {
      if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) {
        throw new Error('"map" entries must be arrays of strings');
      }
      const file = formData.get(key);
      if (file) {
        for (const path of paths) {
          setPath(opsJson, path, file);
        }
      }
    }
  }

  // Shapes are checked by validateRequest, as for the other body types
  // (`variables` already above when a map was applied)
  return {
    query: opsJson.query as ParsedBody['query'],
    operationName: opsJson.operationName as ParsedBody['operationName'],
    variables: opsJson.variables as ParsedBody['variables'],
    extensions: opsJson.extensions as ParsedBody['extensions'],
  };
}

/**
 * Read a form or multipart body, replacing the runtime's own parse error (its
 * wording varies between Bun versions) with a fixed message.
 */
async function readFormData(
  request: Request,
  message: string
): ReturnType<Request['formData']> {
  try {
    return await request.formData();
  } catch {
    throw new Error(message);
  }
}

/**
 * Decode a graphql-multipart-request-spec field that must hold a JSON object.
 */
function decodeMultipartField(raw: string, name: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in "${name}"`);
  }
  if (!isPlainObject(decoded)) {
    throw new Error(`"${name}" must be a JSON object`);
  }
  return decoded;
}

/**
 * Parse query string parameters
 *
 * @throws Error when `variables` or `extensions` is present but is not
 * decodable JSON (`Invalid JSON in "variables"`); answer it with a 400
 */
export function parseQuery(url: URL): ParsedBody {
  const params = url.searchParams;

  return {
    query: params.get('query') ?? undefined,
    operationName: params.get('operationName') ?? undefined,
    variables: parseJsonObject(params.get('variables'), 'variables'),
    extensions: parseJsonObject(params.get('extensions'), 'extensions'),
  };
}

/**
 * Decode `variables` or `extensions` from a JSON string.
 *
 * This is only a decoder: `null`, `undefined`, the empty string and a string
 * that decodes to `null` mean "none"; any other string is JSON-decoded (an
 * undecodable one throws, so the client gets a 400 instead of silently
 * running without its variables); a non-string value is returned as is.
 *
 * The shape is NOT checked here. The decoded value may be any JSON value, and
 * `validateRequest` rejects a non-object with a 400. (For a multipart upload
 * with a `map`, `parseMultipartBody` checks `variables` first, before the map
 * is applied.)
 * The return type reflects the shape `ParsedBody` promises once validated.
 */
function parseJsonObject(
  value: unknown,
  name: 'variables' | 'extensions'
): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    return value as Record<string, unknown>;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON in "${name}"`);
  }
  return parsed === null ? undefined : (parsed as Record<string, unknown>);
}

/**
 * Path segments that must never be traversed or written.
 *
 * Without this guard an unauthenticated multipart request whose `map` names
 * `__proto__.polluted` walks straight into `Object.prototype` and writes
 * there, poisoning every object in the process.
 */
const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Roots a multipart file path is allowed to address.
 *
 * The graphql-multipart-request-spec only ever maps files into the operation
 * payload, so anything else is a client error (or an attack) and is dropped.
 */
const ALLOWED_PATH_ROOTS: ReadonlySet<string> = new Set(['variables', 'operations']);

/**
 * Set a value at a path in an object.
 *
 * Only spec-legal paths are honoured: the first segment must be `variables`
 * or `operations`, and no segment may name a prototype-reaching key.
 * Intermediates are created with a null prototype and existence is checked
 * with `hasOwnProperty` (not `in`) so inherited keys cannot be traversed.
 */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');

  const root = parts[0];
  if (root === undefined || !ALLOWED_PATH_ROOTS.has(root)) {
    return;
  }

  for (const part of parts) {
    if (FORBIDDEN_PATH_SEGMENTS.has(part)) {
      return;
    }
  }

  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const existing = Object.prototype.hasOwnProperty.call(current, part)
      ? current[part]
      : undefined;

    if (typeof existing === 'object' && existing !== null) {
      current = existing as Record<string, unknown>;
    } else {
      const next = Object.create(null) as Record<string, unknown>;
      current[part] = next;
      current = next;
    }
  }

  const lastPart = parts[parts.length - 1]!;
  current[lastPart] = value;
}

/**
 * Validate a GraphQL request
 *
 * `query` holds the parameters parsed off the URL; it defaults to empty so
 * callers that only have a body can pass a single argument.
 *
 * Returns `{ valid: false, error }` (answer it with a 400) for a missing
 * query, a non-string `query` (`"query" must be a string`) or
 * `operationName`, and a `variables` or `extensions` that is not a plain
 * object (`"variables" must be a JSON object`). `null` counts as absent.
 */
export function validateRequest(
  body: ParsedBody,
  query: ParsedBody = {}
): RequestValidation {
  // Merge body and query params (body takes precedence)
  const merged = {
    query: body.query ?? query.query,
    operationName: body.operationName ?? query.operationName,
    variables: body.variables ?? query.variables,
    extensions: body.extensions ?? query.extensions,
  };

  if (merged.query === undefined || merged.query === null || merged.query === '') {
    return {
      valid: false,
      error: 'Query is required',
    };
  }
  if (typeof merged.query !== 'string') {
    return { valid: false, error: '"query" must be a string' };
  }
  const operationName: unknown = merged.operationName;
  if (
    operationName !== undefined &&
    operationName !== null &&
    typeof operationName !== 'string'
  ) {
    return { valid: false, error: '"operationName" must be a string' };
  }
  for (const field of ['variables', 'extensions'] as const) {
    const value: unknown = merged[field];
    if (value !== undefined && value !== null && !isPlainObject(value)) {
      return { valid: false, error: `"${field}" must be a JSON object` };
    }
  }

  return {
    valid: true,
    request: {
      query: merged.query,
      operationName: merged.operationName,
      variables: merged.variables,
      extensions: merged.extensions,
    },
  };
}
