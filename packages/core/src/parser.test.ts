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
  getOperationType,
  parseRequest,
  countFields,
  getOperationNames,
  MAX_ANALYSIS_VISITS,
} from './parser';
import { buildSchema, GraphQLError } from 'graphql';
import { DepthLimitError, ErrorCode } from '@leaven-graphql/errors';

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

  test('should throw for missing operation', () => {
    expect(() =>
      parseRequest({
        query: 'query GetHello { hello }',
        operationName: 'NonExistent',
      })
    ).toThrow(/not found/);
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
    expect(() =>
      parseRequest({
        query: 'fragment F on User { id }',
      })
    ).toThrow(/No operation found/);
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
