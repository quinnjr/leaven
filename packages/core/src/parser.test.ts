/**
 * @leaven-graphql/core - Parser tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import {
  parseDocument,
  validateDocument,
  calculateQueryDepth,
  calculateQueryDepths,
  getOperationType,
  parseRequest,
  countFields,
  getOperationNames,
  MAX_ANALYSIS_VISITS,
} from './parser';
import { buildSchema, getIntrospectionQuery, GraphQLError } from 'graphql';
import { DepthLimitError, ErrorCode, LeavenError } from '@leaven-graphql/errors';

describe('parseDocument', () => {
  test('should parse a valid GraphQL query', () => {
    const query = '{ hello }';
    const document = parseDocument(query);

    expect(document).toBeDefined();
    expect(document.kind).toBe('Document');
    expect(document.definitions.length).toBe(1);
  });

  test('should throw for invalid GraphQL syntax', () => {
    expect(() => parseDocument('{ hello')).toThrow();
  });

  test('should enforce max depth limit', () => {
    const deepQuery = `{
      a {
        b {
          c {
            d {
              e
            }
          }
        }
      }
    }`;

    let thrown: unknown;
    try {
      parseDocument(deepQuery, { maxDepth: 2 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GraphQLError);
    expect((thrown as GraphQLError).message).toMatch(/exceeds maximum allowed depth/);
    expect((thrown as GraphQLError).extensions.code).toBe(ErrorCode.DEPTH_LIMIT);
    // Raised through DepthLimitError, so the limits travel with the error
    expect((thrown as GraphQLError).extensions.depth).toBe(5);
    expect((thrown as GraphQLError).extensions.maxDepth).toBe(2);
    expect((thrown as GraphQLError).originalError).toBeInstanceOf(DepthLimitError);
    expect(((thrown as GraphQLError).originalError as DepthLimitError).statusCode).toBe(
      400
    );
  });

  test('should allow queries within max depth', () => {
    const query = '{ a { b } }';
    const document = parseDocument(query, { maxDepth: 5 });
    expect(document).toBeDefined();
  });

  test('should enforce max depth through fragment spreads', () => {
    const query = `
      { a { ...Deep } }
      fragment Deep on A { b { c { d { e } } } }
    `;

    expect(() => parseDocument(query, { maxDepth: 2 })).toThrow(
      /exceeds maximum allowed depth/
    );
  });

  test('should reject queries exceeding maxTokens', () => {
    expect(() =>
      parseDocument('{ a b c d e f g h i j k l m n o p }', { maxTokens: 5 })
    ).toThrow(/token/i);
  });

  test('should allow queries within maxTokens', () => {
    const document = parseDocument('{ hello }', { maxTokens: 100 });
    expect(document).toBeDefined();
  });
});

describe('validateDocument', () => {
  const schema = buildSchema(`
    type Query {
      hello: String
      user(id: ID!): User
    }
    type User {
      id: ID!
      name: String
    }
  `);

  test('should validate a correct query', () => {
    const document = parseDocument('{ hello }');
    const result = validateDocument(schema, document);

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test('should return errors for invalid field', () => {
    const document = parseDocument('{ nonexistent }');
    const result = validateDocument(schema, document);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('should validate queries with arguments', () => {
    const document = parseDocument('{ user(id: "1") { id name } }');
    const result = validateDocument(schema, document);

    expect(result.valid).toBe(true);
  });
});

describe('calculateQueryDepth', () => {
  test('should return 0 for empty query', () => {
    const document = parseDocument('query Empty { __typename }');
    // __typename is at depth 1
    const depth = calculateQueryDepth(document);
    expect(depth).toBeGreaterThanOrEqual(0);
  });

  test('should calculate correct depth for nested query', () => {
    const document = parseDocument(`{
      a {
        b {
          c
        }
      }
    }`);
    const depth = calculateQueryDepth(document);
    expect(depth).toBe(3);
  });

  test('should handle multiple root fields', () => {
    const document = parseDocument(`{
      a { b }
      c { d { e } }
    }`);
    const depth = calculateQueryDepth(document);
    expect(depth).toBe(3);
  });

  test('should count depth hidden behind a fragment spread', () => {
    const document = parseDocument(`
      { a { ...Deep } }
      fragment Deep on A { b { c { d { e } } } }
    `);
    // a=1, then fragment fields continue at a's child depth: b=2, c=3, d=4, e=5
    const depth = calculateQueryDepth(document);
    expect(depth).toBe(5);
  });

  test('should not add depth for inline fragments', () => {
    const document = parseDocument(`{
      a {
        ... on A {
          b
        }
      }
    }`);
    // a=1, b=2 — the inline fragment itself adds no level
    const depth = calculateQueryDepth(document);
    expect(depth).toBe(2);
  });

  test('should terminate on a self-referencing cyclic fragment', () => {
    const document = parseDocument(`
      { a { ...A } }
      fragment A on T { b { ...A } }
    `);
    // a=1, b=2, then the spread of A inside A is cut off by cycle detection
    const depth = calculateQueryDepth(document);
    expect(depth).toBe(2);
  });

  test('should terminate on mutually cyclic fragments', () => {
    const document = parseDocument(`
      { a { ...A } }
      fragment A on T { b { ...B } }
      fragment B on T { c { ...A } }
    `);
    // a=1, b=2, c=3, then the spread of A inside B is cut off by cycle detection
    const depth = calculateQueryDepth(document);
    expect(depth).toBe(3);
  });

  test('should count fragment spreads reached via separate paths', () => {
    const document = parseDocument(`
      {
        a { ...F }
        x { y { ...F } }
      }
      fragment F on T { leaf }
    `);
    // F's relative depth (1) is memoised once and applied at both spread
    // sites, so the deepest wins: a.F = 2, x.y.F = 3
    const depth = calculateQueryDepth(document);
    expect(depth).toBe(3);
  });

  test('should not let a cycle-truncated fragment leak into another spread site', () => {
    // A and B are mutually cyclic, so whichever one is expanded first cuts the
    // other short. Memoising that truncated value and reusing it at the other
    // site makes the answer depend on the order the root fields appear in.
    const fragments = `
      fragment A on T { p { ...B } }
      fragment B on T { q { ...A } }
    `;
    const cyclicFirst = parseDocument(`{ a { ...A } x { y { ...B } } }${fragments}`);
    const deepFirst = parseDocument(`{ x { y { ...B } } a { ...A } }${fragments}`);

    expect(calculateQueryDepth(cyclicFirst)).toBe(calculateQueryDepth(deepFirst));
    // x=1, y=2, B's q=3, A's p=4
    expect(calculateQueryDepth(cyclicFirst)).toBe(4);
  });

  test('should resolve chained doubly-spread fragments without fan-out', () => {
    // 20 chained fragments, each spreading the next twice. Re-expanding per
    // spread site is O(2^20) — measured at seconds of CPU and hundreds of MB
    // for a sub-kilobyte query, before validation ever runs.
    const chain = 20;
    const definitions: string[] = [];
    for (let i = 0; i < chain; i++) {
      definitions.push(`fragment F${i} on T { ...F${i + 1} ...F${i + 1} }`);
    }
    definitions.push(`fragment F${chain} on T { leaf }`);

    const document = parseDocument(`{ a { ...F0 } }\n${definitions.join('\n')}`);

    const start = performance.now();
    const depth = calculateQueryDepth(document);
    const elapsed = performance.now() - start;

    // a = 1, the whole fragment chain adds a single level for `leaf`
    expect(depth).toBe(2);
    expect(elapsed).toBeLessThan(250);
  });

  test('should reject a document that exceeds the analysis visit budget', () => {
    const fields = Array.from({ length: MAX_ANALYSIS_VISITS + 1 }, () => 'f').join(
      ' '
    );
    const document = parseDocument(`{ ${fields} }`);

    let thrown: unknown;
    try {
      calculateQueryDepth(document);
    } catch (error) {
      thrown = error;
    }

    // The message alone would still pass if this regressed to a plain Error
    // or lost its code, leaving the HTTP layer with nothing to map
    expect(thrown).toBeInstanceOf(GraphQLError);
    expect((thrown as GraphQLError).message).toMatch(/exceeded the maximum/);
    expect((thrown as GraphQLError).extensions.code).toBe(ErrorCode.COMPLEXITY_LIMIT);
  });
});

/** Parse and return the thrown error, or undefined when parsing succeeded */
function parseError(query: string, options: Parameters<typeof parseDocument>[1]): GraphQLError | undefined {
  try {
    parseDocument(query, options);
    return undefined;
  } catch (error) {
    return error as GraphQLError;
  }
}

describe('calculateQueryDepths', () => {
  test('should split introspection depth from the rest of the document', () => {
    const document = parseDocument(`{
      a { b { c } }
      __schema { types { fields { name } } }
    }`);

    expect(calculateQueryDepths(document)).toEqual({ depth: 3, introspectionDepth: 4 });
  });

  test('should report 0 introspection depth for a document without introspection', () => {
    expect(calculateQueryDepths(parseDocument('{ a { b } }'))).toEqual({
      depth: 2,
      introspectionDepth: 0,
    });
  });

  test('should keep calculateQueryDepth as the deepest of the two', () => {
    const document = parseDocument(getIntrospectionQuery());

    expect(calculateQueryDepth(document)).toBe(15);
    expect(calculateQueryDepths(document)).toEqual({ depth: 0, introspectionDepth: 15 });
  });

  test('should count __typename as an ordinary field', () => {
    expect(calculateQueryDepths(parseDocument('{ a { __typename } __typename }'))).toEqual({
      depth: 2,
      introspectionDepth: 0,
    });
  });

  test('should treat __schema and __type only at the operation root as introspection', () => {
    // graphql-js only defines the meta-fields on the query root; a nested
    // `__type` is rejected by validation, so it must not escape maxDepth here
    const document = parseDocument('{ a { __type(name: "X") { ofType { ofType { name } } } } }');

    expect(calculateQueryDepths(document)).toEqual({ depth: 5, introspectionDepth: 0 });
  });

  test('should treat meta-fields reached through root inline fragments and spreads as introspection', () => {
    const document = parseDocument(`
      { ... on Query { __type(name: "X") { name } } ...Root }
      fragment Root on Query { __schema { types { name } } }
    `);

    expect(calculateQueryDepths(document)).toEqual({ depth: 0, introspectionDepth: 3 });
  });

  test('should count a fragment shared inside and outside introspection under both limits', () => {
    const shared = 'fragment F on T { ofType { ofType { name } } }';
    const introspectionFirst = parseDocument(
      `{ __type(name: "X") { ...F } a { b { ...F } } } ${shared}`
    );
    const regularFirst = parseDocument(
      `{ a { b { ...F } } __type(name: "X") { ...F } } ${shared}`
    );

    // __type = 1, F adds 3 below it; a.b = 2, F adds 3 below that
    expect(calculateQueryDepths(introspectionFirst)).toEqual({ depth: 5, introspectionDepth: 4 });
    expect(calculateQueryDepths(regularFirst)).toEqual({ depth: 5, introspectionDepth: 4 });
  });

  test('should memoise a fragment with root meta-fields separately per spread site', () => {
    const intro = 'fragment Intro on Query { __schema { types { fields { name } } } }';
    const rootFirst = parseDocument(`{ ...Intro a { ...Intro } } ${intro}`);
    const nestedFirst = parseDocument(`{ a { ...Intro } ...Intro } ${intro}`);

    // At the root the fragment is introspection (depth 4); under `a` its
    // `__schema` is an ordinary field, so the path counts as regular depth 5
    expect(calculateQueryDepths(rootFirst)).toEqual({ depth: 5, introspectionDepth: 4 });
    expect(calculateQueryDepths(nestedFirst)).toEqual({ depth: 5, introspectionDepth: 4 });
  });

  test('should stay linear for doubly-spread fragment chains used in both modes', () => {
    const chain = 20;
    const definitions: string[] = [];
    for (let i = 0; i < chain; i++) {
      definitions.push(`fragment F${i} on T { ...F${i + 1} ...F${i + 1} }`);
    }
    definitions.push(`fragment F${chain} on T { leaf { ofType { name } } }`);
    definitions.push('fragment Root on Query { __type(name: "X") { ...F0 } a { ...F0 } }');

    const document = parseDocument(
      `{ ...Root __schema { types { ...F0 } } b { ...Root } }\n${definitions.join('\n')}`
    );

    const start = performance.now();
    const depths = calculateQueryDepths(document);
    const elapsed = performance.now() - start;

    // b.__type.leaf.ofType.name and b.a.leaf.ofType.name are regular (5);
    // __schema.types.leaf.ofType.name is introspection (5)
    expect(depths).toEqual({ depth: 5, introspectionDepth: 5 });
    expect(elapsed).toBeLessThan(250);
  });
});

describe('parseDocument maxIntrospectionDepth', () => {
  const introspection = getIntrospectionQuery();

  test('should reject getIntrospectionQuery() under maxDepth alone, as before', () => {
    const error = parseError(introspection, { maxDepth: 10 });

    expect(error?.extensions.code).toBe(ErrorCode.DEPTH_LIMIT);
    expect(error?.extensions.depth).toBe(15);
    expect(error?.extensions.limit).toBeUndefined();
  });

  test('should accept getIntrospectionQuery() with a separate maxIntrospectionDepth', () => {
    expect(parseError(introspection, { maxDepth: 10, maxIntrospectionDepth: 20 })).toBeUndefined();
  });

  test('should still bound introspection with maxIntrospectionDepth', () => {
    const error = parseError(introspection, { maxDepth: 10, maxIntrospectionDepth: 5 });

    expect(error).toBeInstanceOf(GraphQLError);
    expect(error?.originalError).toBeInstanceOf(DepthLimitError);
    expect(error?.extensions.code).toBe(ErrorCode.DEPTH_LIMIT);
    expect(error?.extensions.depth).toBe(15);
    expect(error?.extensions.maxDepth).toBe(5);
    expect(error?.extensions.limit).toBe('maxIntrospectionDepth');
  });

  test('should still reject a non-introspection query deeper than maxDepth', () => {
    const deep = '{ a { b { c { d { e { f { g { h { i { j { k } } } } } } } } } } }';
    const error = parseError(deep, { maxDepth: 10, maxIntrospectionDepth: 20 });

    expect(error?.extensions.code).toBe(ErrorCode.DEPTH_LIMIT);
    expect(error?.extensions.depth).toBe(11);
    expect(error?.extensions.maxDepth).toBe(10);
    expect(error?.extensions.limit).toBe('maxDepth');
  });

  test('should reject a nested __type chain against maxDepth', () => {
    const nested = '{ a { __type(name: "X") { ofType { ofType { ofType { name } } } } } }';

    expect(parseError(nested, { maxDepth: 4, maxIntrospectionDepth: 20 })?.extensions.limit).toBe(
      'maxDepth'
    );
  });

  test('should apply both limits to a fragment shared inside and outside introspection', () => {
    const query = `
      { __type(name: "X") { ...F } a { b { ...F } } }
      fragment F on T { ofType { ofType { name } } }
    `;

    expect(parseError(query, { maxDepth: 5, maxIntrospectionDepth: 4 })).toBeUndefined();
    expect(parseError(query, { maxDepth: 4, maxIntrospectionDepth: 20 })?.extensions.limit).toBe(
      'maxDepth'
    );
    expect(parseError(query, { maxDepth: 20, maxIntrospectionDepth: 3 })?.extensions.limit).toBe(
      'maxIntrospectionDepth'
    );
  });

  test('should bound introspection when only maxIntrospectionDepth is set', () => {
    expect(parseError(introspection, { maxIntrospectionDepth: 5 })?.extensions.limit).toBe(
      'maxIntrospectionDepth'
    );
    expect(parseError('{ a { b { c { d { e { f } } } } } }', { maxIntrospectionDepth: 5 })).toBeUndefined();
  });

  test('should reject a pathologically deep ofType chain quickly', () => {
    const levels = 2000;
    const query = `{ __type(name: "X") { ${'ofType { '.repeat(levels)}name${' }'.repeat(levels)} } }`;

    const start = performance.now();
    const error = parseError(query, { maxDepth: 10, maxIntrospectionDepth: 20 });
    const elapsed = performance.now() - start;

    expect(error?.extensions.limit).toBe('maxIntrospectionDepth');
    expect(elapsed).toBeLessThan(250);
  });

  test('should reject a pathologically wide introspection document through the visit budget', () => {
    const aliases = Array.from(
      { length: MAX_ANALYSIS_VISITS + 1 },
      (_, i) => `t${i}: __type(name: "X") { name }`
    ).join(' ');
    const query = `{ ${aliases} }`;

    const start = performance.now();
    const error = parseError(query, { maxDepth: 10, maxIntrospectionDepth: 20 });
    const elapsed = performance.now() - start;

    expect(error?.extensions.code).toBe(ErrorCode.COMPLEXITY_LIMIT);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('getOperationType', () => {
  test('should return query for query operation', () => {
    const document = parseDocument('query { hello }');
    const type = getOperationType(document);
    expect(type).toBe('query');
  });

  test('should return mutation for mutation operation', () => {
    const document = parseDocument('mutation { createUser }');
    const type = getOperationType(document);
    expect(type).toBe('mutation');
  });

  test('should return subscription for subscription operation', () => {
    const document = parseDocument('subscription { newMessage }');
    const type = getOperationType(document);
    expect(type).toBe('subscription');
  });

  test('should handle named operations', () => {
    const document = parseDocument(`
      query GetHello { hello }
      mutation CreateUser { createUser }
    `);

    expect(getOperationType(document, 'GetHello')).toBe('query');
    expect(getOperationType(document, 'CreateUser')).toBe('mutation');
  });

  test('should return null for non-existent operation', () => {
    const document = parseDocument('query GetHello { hello }');
    const type = getOperationType(document, 'NonExistent');
    expect(type).toBeNull();
  });
});

describe('parseRequest', () => {
  test('should parse a request with query', () => {
    const result = parseRequest({ query: '{ hello }' });

    expect(result.query).toBe('{ hello }');
    expect(result.document).toBeDefined();
    expect(result.operation).toBeDefined();
    expect(result.operationType).toBe('query');
  });

  test('should parse a request with operation name', () => {
    const result = parseRequest({
      query: 'query GetHello { hello }',
      operationName: 'GetHello',
    });

    expect(result.operationName).toBe('GetHello');
    expect(result.operationType).toBe('query');
  });

  test('should throw a BAD_REQUEST LeavenError for an unknown operation name', () => {
    let thrown: unknown;
    try {
      parseRequest({ query: 'query GetHello { hello }', operationName: 'NonExistent' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LeavenError);
    expect((thrown as LeavenError).message).toBe('Unknown operation named "NonExistent".');
    expect((thrown as LeavenError).code).toBe(ErrorCode.BAD_REQUEST);
    expect((thrown as LeavenError).statusCode).toBe(400);
  });

  test('should require an operation name when the document has several operations', () => {
    expect(() => parseRequest({ query: 'query A { hello } query B { hello }' })).toThrow(
      'Must provide operation name if query contains multiple operations.'
    );
  });

  test('should treat a null operation name as unspecified', () => {
    const result = parseRequest({
      query: 'query A { hello }',
      operationName: null as unknown as undefined,
    });
    expect(result.operation.name?.value).toBe('A');
  });

  test('should escape and cap a client operation name in the error text', () => {
    let message = '';
    try {
      parseRequest({
        query: 'query GetHello { hello }',
        operationName: `Evil\r\nINFO forged ${'x'.repeat(500)}`,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Evil\\r\\nINFO forged');
    expect(message).not.toMatch(/[\r\n]/);
    expect(message.length).toBeLessThan(400);
  });

  test('should throw for document with no operations', () => {
    let thrown: unknown;
    try {
      parseRequest({ query: 'fragment F on User { id }' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LeavenError);
    expect((thrown as LeavenError).message).toBe('Must provide an operation.');
    expect((thrown as LeavenError).code).toBe(ErrorCode.BAD_REQUEST);
  });
});

describe('countFields', () => {
  test('should count fields in a simple query', () => {
    const document = parseDocument('{ a b c }');
    const count = countFields(document);
    expect(count).toBe(3);
  });

  test('should count nested fields', () => {
    const document = parseDocument('{ a { b { c } } }');
    const count = countFields(document);
    expect(count).toBe(3);
  });
});

describe('getOperationNames', () => {
  test('should return operation names', () => {
    const document = parseDocument(`
      query GetHello { hello }
      mutation CreateUser { createUser }
    `);
    const names = getOperationNames(document);

    expect(names).toContain('GetHello');
    expect(names).toContain('CreateUser');
    expect(names.length).toBe(2);
  });

  test('should return empty array for anonymous operations', () => {
    const document = parseDocument('{ hello }');
    const names = getOperationNames(document);
    expect(names.length).toBe(0);
  });
});
