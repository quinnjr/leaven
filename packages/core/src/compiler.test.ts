/**
 * @leaven-graphql/core - Compiler tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { parse, buildSchema, GraphQLError } from 'graphql';
import { ErrorCode } from '@leaven-graphql/errors';
import { CompiledQuery, compileQuery } from './compiler';
import { MAX_ANALYSIS_VISITS } from './parser';

const schema = buildSchema(`
  type Query {
    hello: String
    user(id: ID!): User
    users(first: Int, after: String): [User!]!
  }
  type User {
    id: ID!
    name: String
    email: String
    posts: [Post!]!
  }
  type Post {
    id: ID!
    title: String
    content: String
  }
`);

describe('CompiledQuery', () => {
  describe('constructor', () => {
    test('should compile a simple query', () => {
      const document = parse('{ hello }');
      const compiled = new CompiledQuery(schema, document);

      expect(compiled.operationType).toBe('query');
      expect(compiled.operationName).toBeNull();
      expect(compiled.fields.length).toBe(1);
      expect(compiled.fields[0]?.name).toBe('hello');
    });

    test('should compile a named query', () => {
      const document = parse('query GetHello { hello }');
      const compiled = new CompiledQuery(schema, document, 'GetHello');

      expect(compiled.operationName).toBe('GetHello');
    });

    test('should throw for non-existent operation', () => {
      const document = parse('query GetHello { hello }');
      expect(() => new CompiledQuery(schema, document, 'NonExistent')).toThrow();
    });

    test('should escape and cap a client operation name in the error text', () => {
      const document = parse('query GetUser { user(id: "1") { id } }');
      let message = '';
      try {
        new CompiledQuery(schema, document, `Evil\nforged\u001b[2J${'x'.repeat(500)}`);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('Evil\\nforged\\x1b[2J');
      expect(message).not.toMatch(/[\u0000-\u001f]/);
      expect(message.length).toBeLessThan(400);
    });

    test('should handle nested fields', () => {
      const document = parse('{ user(id: "1") { id name posts { title } } }');
      const compiled = new CompiledQuery(schema, document);

      expect(compiled.fields.length).toBe(1);
      expect(compiled.fields[0]?.children.length).toBe(3);
    });
  });

  describe('variable extraction', () => {
    test('should extract required variables', () => {
      const document = parse(`
        query GetUser($id: ID!) {
          user(id: $id) { id name }
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      expect(compiled.requiredVariables).toContain('id');
      expect(compiled.optionalVariables.length).toBe(0);
    });

    test('should extract optional variables', () => {
      const document = parse(`
        query GetUsers($first: Int = 10, $after: String) {
          users(first: $first, after: $after) { id }
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      expect(compiled.optionalVariables).toContain('first');
      expect(compiled.optionalVariables).toContain('after');
      expect(compiled.requiredVariables.length).toBe(0);
    });
  });

  describe('validateVariables', () => {
    test('should validate required variables are present', () => {
      const document = parse(`
        query GetUser($id: ID!) {
          user(id: $id) { id }
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      const result = compiled.validateVariables({ id: '1' });
      expect(result.valid).toBe(true);
      expect(result.missing.length).toBe(0);
    });

    test('should report missing required variables', () => {
      const document = parse(`
        query GetUser($id: ID!) {
          user(id: $id) { id }
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      const result = compiled.validateVariables({});
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('id');
    });

    test('should treat explicit undefined as missing', () => {
      const document = parse(`
        query GetUser($id: ID!) {
          user(id: $id) { id }
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      const result = compiled.validateVariables({ id: undefined });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('id');
    });

    test('should treat null as missing', () => {
      const document = parse(`
        query GetUser($id: ID!) {
          user(id: $id) { id }
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      const result = compiled.validateVariables({ id: null });
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('id');
    });
  });

  describe('getFieldNames', () => {
    test('should return all field names', () => {
      const document = parse('{ user(id: "1") { id name posts { title } } }');
      const compiled = new CompiledQuery(schema, document);

      const names = compiled.getFieldNames();
      expect(names).toContain('user');
      expect(names).toContain('id');
      expect(names).toContain('name');
      expect(names).toContain('posts');
      expect(names).toContain('title');
    });
  });

  describe('complexity calculation', () => {
    test('should calculate complexity with option enabled', () => {
      const document = parse('{ user(id: "1") { id name posts { title } } }');
      const compiled = new CompiledQuery(schema, document, undefined, {
        calculateComplexity: true,
      });

      expect(compiled.complexity).toBeGreaterThan(0);
    });

    test('should return 0 complexity when disabled', () => {
      const document = parse('{ hello }');
      const compiled = new CompiledQuery(schema, document);

      expect(compiled.complexity).toBe(0);
    });

    test('should invoke a custom complexity calculator', () => {
      const document = parse('{ user(id: "1") { id name posts { title } } }');

      const withDefault = new CompiledQuery(schema, document, undefined, {
        calculateComplexity: true,
      });
      const withCustom = new CompiledQuery(schema, document, undefined, {
        calculateComplexity: true,
        complexityCalculator: (field, depth) => 10 + depth,
      });

      // 5 fields: user (depth 0); id, name, posts (depth 1); title (depth 2).
      // Custom: (10+0) + 3*(10+1) + (10+2) = 55; default: 1 + 3*1.5 + 2 = 7.5.
      expect(withCustom.complexity).toBe(55);
      expect(withCustom.complexity).not.toBe(withDefault.complexity);
    });

    test('should pass the originating FieldNode to the calculator', () => {
      const document = parse('{ hello }');
      const seen: string[] = [];

      new CompiledQuery(schema, document, undefined, {
        calculateComplexity: true,
        complexityCalculator: (field, depth) => {
          seen.push(field.name.value);
          return depth + 1;
        },
      });

      expect(seen).toEqual(['hello']);
    });
  });

  describe('fragments', () => {
    test('should record fragment spreads by name instead of inlining them', () => {
      const document = parse(`
        query GetUser {
          user(id: "1") {
            ...UserFields
          }
        }
        fragment UserFields on User {
          id
          name
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      expect(compiled.fields[0]?.children.length).toBe(0);
      expect(compiled.fields[0]?.fragmentSpreads).toEqual(['UserFields']);

      const fragment = compiled.fragments.get('UserFields');
      expect(fragment?.typeCondition).toBe('User');
      expect(fragment?.fields.map((f) => f.name)).toEqual(['id', 'name']);
    });

    test('should handle inline fragments', () => {
      const document = parse(`
        query GetUser {
          user(id: "1") {
            ... on User {
              id
              name
            }
          }
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      expect(compiled.fields[0]?.children.length).toBe(2);
    });

    test('should terminate on cyclic fragment spreads', () => {
      const document = parse(`
        query GetUser {
          user(id: "1") {
            ...A
          }
        }
        fragment A on User {
          id
          ...B
        }
        fragment B on User {
          name
          ...A
        }
      `);
      const compiled = new CompiledQuery(schema, document, undefined, {
        calculateComplexity: true,
      });

      // Each fragment is compiled once; the cycle is cut when scoring.
      expect(compiled.fragments.get('A')?.fields.map((f) => f.name)).toEqual(['id']);
      expect(compiled.fragments.get('A')?.fragmentSpreads).toEqual(['B']);
      expect(compiled.fragments.get('B')?.fields.map((f) => f.name)).toEqual(['name']);
      expect(compiled.fragments.get('B')?.fragmentSpreads).toEqual(['A']);
      expect(compiled.getFieldNames()).toEqual(['user', 'id', 'name']);
      // user (0) + id (1) + name (1); the cyclic ...A adds nothing.
      expect(compiled.complexity).toBe(1 + 1.5 + 1.5);
    });

    test('should terminate on self-referential fragments nested in fields', () => {
      const document = parse(`
        query GetUser {
          user(id: "1") {
            ...UserTree
          }
        }
        fragment UserTree on User {
          id
          posts {
            title
            ...UserTree
          }
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      const names = compiled.getFieldNames();
      expect(names).toContain('user');
      expect(names).toContain('id');
      expect(names).toContain('posts');
      expect(names).toContain('title');
    });

    test('should score a fragment reused in sibling positions at every site', () => {
      const document = parse(`
        query GetUsers {
          a: user(id: "1") { ...Ids }
          b: user(id: "2") { ...Ids }
        }
        fragment Ids on User {
          id
        }
      `);
      const compiled = new CompiledQuery(schema, document, undefined, {
        calculateComplexity: true,
      });

      expect(compiled.fields[0]?.fragmentSpreads).toEqual(['Ids']);
      expect(compiled.fields[1]?.fragmentSpreads).toEqual(['Ids']);
      // Two user fields at depth 0 plus the fragment's `id` scored at depth 1
      // for each of the two spread sites.
      expect(compiled.complexity).toBe(1 + 1 + 1.5 + 1.5);
    });

    test('should resolve chained doubly-spread fragments without fan-out', () => {
      // 20 chained fragments, each spreading the next twice. Inlining (or
      // re-scoring) per spread site is O(2^20) and takes seconds; memoising
      // per fragment keeps it linear.
      const chain = 20;
      const definitions: string[] = [];
      for (let i = 0; i < chain; i++) {
        definitions.push(`fragment F${i} on User { ...F${i + 1} ...F${i + 1} }`);
      }
      definitions.push(`fragment F${chain} on User { id }`);

      const document = parse(
        `query Fanout { user(id: "1") { ...F0 } }\n${definitions.join('\n')}`
      );

      const start = performance.now();
      const compiled = new CompiledQuery(schema, document, undefined, {
        calculateComplexity: true,
      });
      const elapsed = performance.now() - start;

      expect(compiled.getFieldNames()).toEqual(['user', 'id']);
      expect(compiled.complexity).toBeGreaterThan(0);
      expect(Number.isFinite(compiled.complexity)).toBe(true);
      expect(elapsed).toBeLessThan(250);
    });

    test('should reject a document that exceeds the analysis visit budget', () => {
      const fields = Array.from({ length: MAX_ANALYSIS_VISITS + 1 }, () => 'id').join(
        ' '
      );
      const document = parse(`query Huge { user(id: "1") { ${fields} } }`);

      let thrown: unknown;
      try {
        new CompiledQuery(schema, document);
      } catch (error) {
        thrown = error;
      }

      // The message alone would still pass if this regressed to a plain Error
      // or lost its code, leaving the HTTP layer with nothing to map
      expect(thrown).toBeInstanceOf(GraphQLError);
      expect((thrown as GraphQLError).message).toMatch(/exceeded the maximum/);
      expect((thrown as GraphQLError).extensions.code).toBe(
        ErrorCode.COMPLEXITY_LIMIT
      );
    });

    test('should not let a cycle-truncated fragment score leak into another spread site', () => {
      // A and B are mutually cyclic, so whichever is scored first cuts the
      // other short. Memoising that truncated score and reusing it at the
      // sibling spread makes the complexity depend on root-field order.
      const fragments = `
        fragment A on User { id ...B }
        fragment B on User { name email ...A }
      `;
      const aFirst = parse(
        `query { a: user(id: "1") { ...A } b: user(id: "2") { ...B } }${fragments}`
      );
      const bFirst = parse(
        `query { b: user(id: "2") { ...B } a: user(id: "1") { ...A } }${fragments}`
      );

      const score = (document: ReturnType<typeof parse>): number =>
        new CompiledQuery(schema, document, undefined, { calculateComplexity: true })
          .complexity;

      expect(score(aFirst)).toBe(score(bFirst));
      // Each root user field: 1 at depth 0, plus A (id) 1.5 + B (name, email)
      // 3.0 at depth 1 — the cyclic re-entry adds nothing.
      expect(score(aFirst)).toBe(2 * (1 + 1.5 + 3));
    });
  });

  describe('arguments extraction', () => {
    test('should extract literal arguments', () => {
      const document = parse('{ user(id: "123") { id } }');
      const compiled = new CompiledQuery(schema, document);

      expect(compiled.fields[0]?.arguments.id).toBe('123');
    });

    test('should mark variable arguments', () => {
      const document = parse(`
        query GetUser($id: ID!) {
          user(id: $id) { id }
        }
      `);
      const compiled = new CompiledQuery(schema, document);

      const arg = compiled.fields[0]?.arguments.id as { __variable: string };
      expect(arg.__variable).toBe('id');
    });

    test('should handle list arguments', () => {
      const document = parse('{ users(first: 10) { id } }');
      const compiled = new CompiledQuery(schema, document);

      expect(compiled.fields[0]?.arguments.first).toBe(10);
    });
  });
});

describe('compileQuery', () => {
  test('should create a CompiledQuery', () => {
    const document = parse('{ hello }');
    const compiled = compileQuery(schema, document);

    expect(compiled).toBeInstanceOf(CompiledQuery);
  });

  test('should pass options to CompiledQuery', () => {
    const document = parse('{ hello }');
    const compiled = compileQuery(schema, document, undefined, {
      calculateComplexity: true,
    });

    expect(compiled.complexity).toBeGreaterThan(0);
  });
});
