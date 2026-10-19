/**
 * @leaven-graphql/schema - Merge tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, spyOn } from 'bun:test';
import {
  buildSchema,
  graphql,
  parse,
  print,
  subscribe,
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  type ExecutionResult,
  type GraphQLOutputType,
} from 'graphql';
import { mergeSchemas, mergeSchemasFromStrings, type MergeOptions } from './merge';
import type { Resolvers } from './resolvers';

/**
 * Build a single-field schema whose one query field has the given resolver
 */
function querySchema(field: string, resolve: () => unknown): GraphQLSchema {
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { [field]: { type: GraphQLString, resolve } },
    }),
  });
}

describe('mergeSchemasFromStrings', () => {
  test('should merge a type with its extension', () => {
    const schema = mergeSchemasFromStrings([
      'type Query { a: String }',
      'extend type Query { b: String }',
    ]);

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeDefined();
    expect(fields?.b).toBeDefined();
  });

  test('should merge an extension that appears before the base type', () => {
    const schema = mergeSchemasFromStrings([
      'extend type Query { b: String }',
      'type Query { a: String }',
    ]);

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeDefined();
    expect(fields?.b).toBeDefined();
  });

  test('should merge multiple extensions of the same type', () => {
    const schema = mergeSchemasFromStrings([
      'type Query { a: String }',
      'extend type Query { b: String }',
      'extend type Query { c: Int }',
    ]);

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeDefined();
    expect(fields?.b).toBeDefined();
    expect(fields?.c).toBeDefined();
  });

  test('should merge extensions of non-root types', () => {
    const schema = mergeSchemasFromStrings([
      'type Query { user: User } type User { id: ID! }',
      'extend type User { email: String }',
    ]);

    const user = schema.getType('User') as GraphQLObjectType;
    expect(user.getFields().id).toBeDefined();
    expect(user.getFields().email).toBeDefined();
  });

  test('should merge distinct types from separate strings', () => {
    const schema = mergeSchemasFromStrings([
      'type Query { user: User } type User { id: ID! }',
      'type Post { title: String! }',
    ]);

    expect(schema.getType('User')).toBeDefined();
    expect(schema.getType('Post')).toBeDefined();
  });

  test('should keep the first definition on conflict by default', () => {
    const schema = mergeSchemasFromStrings([
      'type Query { a: String }',
      'type Query { b: String }',
    ]);

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeDefined();
    expect(fields?.b).toBeUndefined();
  });

  test('should keep the last definition when onTypeConflict is "last"', () => {
    const schema = mergeSchemasFromStrings(
      ['type Query { a: String }', 'type Query { b: String }'],
      undefined,
      { onTypeConflict: 'last' }
    );

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeUndefined();
    expect(fields?.b).toBeDefined();
  });

  test('should throw when onTypeConflict is "error"', () => {
    expect(() =>
      mergeSchemasFromStrings(
        ['type Query { a: String }', 'type Query { b: String }'],
        undefined,
        { onTypeConflict: 'error' }
      )
    ).toThrow('Type conflict: Query is defined multiple times');
  });

  test('should still merge extensions when onTypeConflict is "error"', () => {
    const schema = mergeSchemasFromStrings(
      ['type Query { a: String }', 'extend type Query { b: String }'],
      undefined,
      { onTypeConflict: 'error' }
    );

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeDefined();
    expect(fields?.b).toBeDefined();
  });

  test('should still merge extensions declared before the base under "error"', () => {
    const schema = mergeSchemasFromStrings(
      ['extend type Query { b: String }', 'type Query { a: String }'],
      undefined,
      { onTypeConflict: 'error' }
    );

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeDefined();
    expect(fields?.b).toBeDefined();
  });

  test('should keep extensions when a later base definition wins under "last"', () => {
    const schema = mergeSchemasFromStrings(
      [
        'type Query { a: String }',
        'extend type Query { b: String }',
        'type Query { c: String }',
      ],
      undefined,
      { onTypeConflict: 'last' }
    );

    const fields = schema.getQueryType()?.getFields();
    expect(Object.keys(fields ?? {}).sort()).toEqual(['b', 'c']);
  });

  test('should keep extensions when the first base definition wins by default', () => {
    const schema = mergeSchemasFromStrings([
      'type Query { a: String }',
      'extend type Query { b: String }',
      'type Query { c: String }',
    ]);

    const fields = schema.getQueryType()?.getFields();
    expect(Object.keys(fields ?? {}).sort()).toEqual(['a', 'b']);
  });

  test('should throw for resolvers on unknown types', () => {
    expect(() =>
      mergeSchemasFromStrings(['type Query { hello: String }'], {
        User: { name: () => 'x' },
      })
    ).toThrow('Resolvers reference unknown type "User"');
  });

  test('should throw for resolvers on unknown fields', () => {
    expect(() =>
      mergeSchemasFromStrings(['type Query { hello: String }'], {
        Query: { helo: () => 'x' },
      })
    ).toThrow('Resolvers reference unknown field "Query.helo"');
  });

  test('should throw for resolvers on a type without fields', () => {
    expect(() =>
      mergeSchemasFromStrings(['scalar Cursor type Query { hello: String }'], {
        Cursor: { anything: () => 'x' },
      })
    ).toThrow('Resolvers reference type "Cursor", which has no fields');
  });

  test('should support the { resolve, subscribe } resolver form', async () => {
    const schema = mergeSchemasFromStrings(
      ['type Query { _: String } type Subscription { tick: Int }'],
      {
        Subscription: {
          tick: {
            subscribe: async function* () {
              yield 1;
              yield 2;
            },
            resolve: (payload) => (payload as number) * 10,
          },
        },
      }
    );

    const result = await subscribe({
      schema,
      document: parse('subscription { tick }'),
    });

    const values: unknown[] = [];
    for await (const payload of result as AsyncIterable<ExecutionResult>) {
      expect(payload.errors).toBeUndefined();
      values.push(payload.data?.tick);
    }

    expect(values).toEqual([10, 20]);
  });

  test('should throw for a null resolver instead of a bare TypeError', () => {
    expect(() =>
      mergeSchemasFromStrings(['type Query { hello: String }'], {
        Query: { hello: null as unknown as () => string },
      })
    ).toThrow(
      'Resolver for "Query.hello" must be a function or a { resolve, subscribe } object'
    );
  });

  test('should attach provided resolvers', async () => {
    const schema = mergeSchemasFromStrings(['type Query { hello: String }'], {
      Query: { hello: () => 'hi' },
    });

    const result = await graphql({ schema, source: '{ hello }' });
    expect(result.data?.hello).toBe('hi');
  });

  test('should rethrow build failures instead of hiding them', () => {
    expect(() =>
      mergeSchemasFromStrings(['type Query { a: Missing }'])
    ).toThrow(/Failed to merge schemas/);
  });
});

describe('mergeSchemas', () => {
  test('should throw for an empty schema list', () => {
    expect(() => mergeSchemas([])).toThrow('At least one schema is required');
  });

  test('should return the same instance for a single schema without resolvers', () => {
    const schema = buildSchema('type Query { a: String }');
    expect(mergeSchemas([schema])).toBe(schema);
  });

  test('should merge types from multiple schemas', () => {
    const a = buildSchema('type Query { a: String }');
    const b = buildSchema('type User { name: String }');

    const merged = mergeSchemas([a, b]);

    expect(merged.getQueryType()?.getFields().a).toBeDefined();
    expect(merged.getType('User')).toBeDefined();
  });

  test('should preserve resolvers across a two-schema merge', async () => {
    const a = mergeSchemasFromStrings(['type Query { hello: String }'], {
      Query: { hello: () => 'from A' },
    });
    const b = buildSchema('type User { name: String }');

    const merged = mergeSchemas([a, b]);
    const result = await graphql({ schema: merged, source: '{ hello }' });

    expect(result.errors).toBeUndefined();
    expect(result.data?.hello).toBe('from A');
  });

  test('should preserve resolvers from every source schema', async () => {
    const a = mergeSchemasFromStrings(['type Query { a: String }'], {
      Query: { a: () => 'A' },
    });
    const b = mergeSchemasFromStrings(['type Mutation { doIt: String }'], {
      Mutation: { doIt: () => 'done' },
    });

    const merged = mergeSchemas([a, b]);

    const queryResult = await graphql({ schema: merged, source: '{ a }' });
    expect(queryResult.data?.a).toBe('A');

    const mutationResult = await graphql({
      schema: merged,
      source: 'mutation { doIt }',
    });
    expect(mutationResult.data?.doIt).toBe('done');
  });

  test('should preserve custom scalar functions across a merge', async () => {
    const upper = new GraphQLScalarType({
      name: 'Upper',
      serialize: (value) => String(value).toUpperCase(),
    });

    const a = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          shout: { type: upper, resolve: () => 'hey' },
        },
      }),
    });
    const b = buildSchema('type User { name: String }');

    const merged = mergeSchemas([a, b]);
    const result = await graphql({ schema: merged, source: '{ shout }' });

    expect(result.errors).toBeUndefined();
    expect(result.data?.shout).toBe('HEY');
  });

  test('should throw when two schemas declare the same name as different kinds', () => {
    const scalarSchema = buildSchema(
      'scalar DateTime type Query { now: DateTime }'
    );
    const objectSchema = buildSchema(
      'type DateTime { iso: String } type Query { stamp: DateTime }'
    );

    expect(() => mergeSchemas([scalarSchema, objectSchema])).toThrow(
      'Cannot merge type "DateTime": source is GraphQLObjectType but merged is GraphQLScalarType'
    );
  });

  test('should warn when a source type is missing from the merged schema', () => {
    // The directive definition and the object type share the name "Marker",
    // so conflict resolution keeps the directive and drops the type. Nothing
    // references the type, so the merged schema still builds.
    const withDirective = buildSchema(
      'directive @Marker on FIELD_DEFINITION type Query { a: String }'
    );
    const withType = buildSchema(
      'type Marker { id: ID } type Query { b: String }'
    );

    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const merged = mergeSchemas([withDirective, withType]);

      expect(merged.getType('Marker')).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(
        'type "Marker" exists in a source schema but not in the merged schema'
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('should not warn when only built-in scalars drop out of the merge', () => {
    const withFloat = buildSchema('type Query { value: Float }');
    const withString = buildSchema('type Query { value: String }');

    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // 'last' hands Query.value to the String source, leaving Float
      // unreferenced and therefore absent from the merged schema.
      const merged = mergeSchemas([withFloat, withString], undefined, {
        onTypeConflict: 'last',
      });

      expect(merged.getType('Float')).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('should let explicit resolvers override source resolvers', async () => {
    const a = mergeSchemasFromStrings(['type Query { hello: String }'], {
      Query: { hello: () => 'from A' },
    });
    const b = buildSchema('type User { name: String }');

    const merged = mergeSchemas([a, b], {
      Query: { hello: () => 'override' },
    });

    const result = await graphql({ schema: merged, source: '{ hello }' });
    expect(result.data?.hello).toBe('override');
  });

  test('should keep root fields from every source schema', async () => {
    const users = querySchema('users', () => 'ada');
    const posts = querySchema('posts', () => 'hello');
    const comments = querySchema('comments', () => 'nice');

    const merged = mergeSchemas([users, posts, comments]);

    const result = await graphql({
      schema: merged,
      source: '{ users posts comments }',
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      users: 'ada',
      posts: 'hello',
      comments: 'nice',
    });
  });

  test('should keep mutation fields from every source schema', async () => {
    const mutationSchema = (field: string, value: string): GraphQLSchema =>
      new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: { _: { type: GraphQLString } },
        }),
        mutation: new GraphQLObjectType({
          name: 'Mutation',
          fields: { [field]: { type: GraphQLString, resolve: () => value } },
        }),
      });

    const merged = mergeSchemas([
      mutationSchema('createUser', 'user'),
      mutationSchema('createPost', 'post'),
    ]);

    const result = await graphql({
      schema: merged,
      source: 'mutation { createUser createPost }',
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ createUser: 'user', createPost: 'post' });
  });

  test('should merge the fields of a shared non-root type', () => {
    const a = buildSchema('type Query { user: User } type User { id: ID! }');
    const b = buildSchema(
      'type Query { other: String } type User { email: String }'
    );

    const merged = mergeSchemas([a, b]);
    const user = merged.getType('User') as GraphQLObjectType;

    expect(Object.keys(user.getFields())).toEqual(['id', 'email']);
  });

  test('should merge the fields of a shared input type', () => {
    const a = buildSchema(
      'input Filter { id: ID } type Query { a(f: Filter): String }'
    );
    const b = buildSchema(
      'input Filter { name: String } type Query { b(f: Filter): String }'
    );

    const merged = mergeSchemas([a, b]);
    const filter = merged.getType('Filter') as GraphQLInputObjectType;

    expect(Object.keys(filter.getFields())).toEqual(['id', 'name']);
  });

  test('should replace a definition with no field map under "last"', () => {
    const a = buildSchema('enum Status { ACTIVE } type Query { status: Status }');
    const b = buildSchema('enum Status { ARCHIVED } type Query { s: Status }');

    const merged = mergeSchemas([a, b], undefined, { onTypeConflict: 'last' });
    const status = merged.getType('Status') as GraphQLEnumType;

    expect(status.getValues().map((value) => value.name)).toEqual(['ARCHIVED']);
  });

  test('should throw for a duplicate definition with no field map under "error"', () => {
    const a = buildSchema('scalar DateTime type Query { now: DateTime }');
    const b = buildSchema('scalar DateTime type Query { then: DateTime }');

    expect(() =>
      mergeSchemas([a, b], undefined, { onTypeConflict: 'error' })
    ).toThrow('Type conflict: DateTime is defined multiple times');
  });

  test('should union the interfaces a shared type implements', () => {
    const a = buildSchema(
      'interface Node { id: ID! } type Query { user: User } type User implements Node { id: ID! }'
    );
    const b = buildSchema(
      'interface Timestamped { createdAt: String } type Query { u: User } type User implements Timestamped { createdAt: String }'
    );

    const merged = mergeSchemas([a, b]);
    const user = merged.getType('User') as GraphQLObjectType;

    expect(user.getInterfaces().map((i) => i.name).sort()).toEqual([
      'Node',
      'Timestamped',
    ]);
  });

  test('should let the first schema win a field conflict by default', async () => {
    const a = querySchema('hello', () => 'from A');
    const b = querySchema('hello', () => 'from B');

    const merged = mergeSchemas([a, b]);
    const result = await graphql({ schema: merged, source: '{ hello }' });

    expect(result.data?.hello).toBe('from A');
  });

  test('should let the last schema win a field conflict under "last"', async () => {
    const a = querySchema('hello', () => 'from A');
    const b = querySchema('hello', () => 'from B');

    const merged = mergeSchemas([a, b], undefined, {
      onTypeConflict: 'last',
    });
    const result = await graphql({ schema: merged, source: '{ hello }' });

    expect(result.data?.hello).toBe('from B');
  });

  test('should throw on a field conflict under "error"', () => {
    const a = querySchema('hello', () => 'from A');
    const b = querySchema('hello', () => 'from B');

    expect(() =>
      mergeSchemas([a, b], undefined, { onTypeConflict: 'error' })
    ).toThrow('Type conflict: Query.hello is defined multiple times');
  });

  test('should preserve isTypeOf across a merge', async () => {
    const cat = new GraphQLObjectType({
      name: 'Cat',
      fields: { name: { type: GraphQLString } },
      isTypeOf: (value) => (value as { meows?: boolean }).meows === true,
    });
    const dog = new GraphQLObjectType({
      name: 'Dog',
      fields: { name: { type: GraphQLString } },
      isTypeOf: (value) => (value as { barks?: boolean }).barks === true,
    });
    // No resolveType, so graphql-js falls back to each member's isTypeOf
    const pet = new GraphQLUnionType({ name: 'Pet', types: [cat, dog] });

    const a = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          pet: { type: pet, resolve: () => ({ barks: true, name: 'Rex' }) },
        },
      }),
    });
    const b = buildSchema('type Unrelated { x: String }');

    const merged = mergeSchemas([a, b]);
    const result = await graphql({
      schema: merged,
      source: '{ pet { __typename ... on Dog { name } } }',
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.pet).toEqual({ __typename: 'Dog', name: 'Rex' });
  });

  test('should preserve union resolveType across a merge', async () => {
    const cat = new GraphQLObjectType({
      name: 'Cat',
      fields: { name: { type: GraphQLString } },
    });
    const dog = new GraphQLObjectType({
      name: 'Dog',
      fields: { name: { type: GraphQLString } },
    });
    const pet = new GraphQLUnionType({
      name: 'Pet',
      types: [cat, dog],
      resolveType: () => 'Cat',
    });

    const a = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          pet: { type: pet, resolve: () => ({ name: 'Whiskers' }) },
        },
      }),
    });
    const b = buildSchema('type Unrelated { x: String }');

    const merged = mergeSchemas([a, b]);
    const result = await graphql({
      schema: merged,
      source: '{ pet { __typename ... on Cat { name } } }',
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.pet).toEqual({ __typename: 'Cat', name: 'Whiskers' });
  });

  test('should preserve interface resolveType and field resolvers across a merge', async () => {
    const idResolver = (): string => 'from-interface';

    const node = new GraphQLInterfaceType({
      name: 'Node',
      fields: { id: { type: GraphQLID, resolve: idResolver } },
      resolveType: () => 'User',
    });
    const user = new GraphQLObjectType({
      name: 'User',
      interfaces: [node],
      fields: { id: { type: GraphQLID, resolve: () => 'u1' } },
    });

    const a = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { node: { type: node, resolve: () => ({}) } },
      }),
      types: [user],
    });
    const b = buildSchema('type Unrelated { x: String }');

    const merged = mergeSchemas([a, b]);

    const mergedNode = merged.getType('Node') as GraphQLInterfaceType;
    expect(mergedNode.getFields().id?.resolve).toBe(idResolver);

    const result = await graphql({
      schema: merged,
      source: '{ node { __typename id } }',
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.node).toEqual({ __typename: 'User', id: 'u1' });
  });

  test('should preserve subscribe functions across a merge', async () => {
    const a = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { _: { type: GraphQLString } },
      }),
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          ticks: {
            type: GraphQLInt,
            subscribe: async function* () {
              yield { ticks: 1 };
              yield { ticks: 2 };
            },
          },
        },
      }),
    });
    const b = buildSchema('type Unrelated { x: String }');

    const merged = mergeSchemas([a, b]);
    const result = await subscribe({
      schema: merged,
      document: parse('subscription { ticks }'),
    });

    const values: unknown[] = [];
    for await (const payload of result as AsyncIterable<ExecutionResult>) {
      expect(payload.errors).toBeUndefined();
      values.push(payload.data?.ticks);
    }

    expect(values).toEqual([1, 2]);
  });
});

describe('root operation types', () => {
  test('should keep a custom query root name (mergeSchemasFromStrings)', async () => {
    const schema = mergeSchemasFromStrings([
      'schema { query: RootQuery } type RootQuery { a: String }',
    ]);

    expect(schema.getQueryType()?.name).toBe('RootQuery');

    const result = await graphql({
      schema,
      source: '{ a }',
      rootValue: { a: 'ok' },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.a).toBe('ok');
  });

  test('should combine schema definitions and extensions across sources (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings([
      'schema { query: RootQuery } type RootQuery { a: String }',
      'type RootMutation { b: String } extend schema { mutation: RootMutation }',
      'schema { query: RootQuery }',
    ]);

    expect(schema.getQueryType()?.name).toBe('RootQuery');
    expect(schema.getMutationType()?.name).toBe('RootMutation');
  });

  test('should keep default roots alongside an extend schema (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings([
      'type Query { a: String }',
      'type RootMutation { b: String } extend schema { mutation: RootMutation }',
    ]);

    expect(schema.getQueryType()?.name).toBe('Query');
    expect(schema.getMutationType()?.name).toBe('RootMutation');
  });

  test.each([
    ['default', undefined, 'QueryA', 'QueryB'],
    ['first', { onTypeConflict: 'first' }, 'QueryA', 'QueryB'],
    ['last', { onTypeConflict: 'last' }, 'QueryB', 'QueryA'],
    ['error', { onTypeConflict: 'error' }, 'QueryA', 'QueryB'],
  ] as const)(
    'should resolve conflicting root names under the %s policy (mergeSchemasFromStrings)',
    (_policy, options, rootName, loserName) => {
      const schema = mergeSchemasFromStrings(
        [
          'schema { query: QueryA } type QueryA { a: String }',
          'schema { query: QueryB } type QueryB { b: String }',
        ],
        undefined,
        options
      );
      expect(schema.getQueryType()?.name).toBe(rootName);
      expect(Object.keys(schema.getQueryType()!.getFields()).sort()).toEqual([
        'a',
        'b',
      ]);
      // The losing root type is unreferenced, so it is not left behind
      expect(schema.getType(loserName)).toBeUndefined();
    }
  );

  test('should not treat agreeing root names as a conflict (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings(
      [
        'schema { query: RootQuery } type RootQuery { a: String }',
        'schema { query: RootQuery }',
      ],
      undefined,
      { onTypeConflict: 'error' }
    );

    expect(schema.getQueryType()?.name).toBe('RootQuery');
  });

  test('should keep a custom root name when merging a schema with itself (mergeSchemas)', async () => {
    const source = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'RootQuery',
        fields: { a: { type: GraphQLString, resolve: () => 'ok' } },
      }),
    });

    const merged = mergeSchemas([source, source]);

    expect(merged.getQueryType()?.name).toBe('RootQuery');
    const result = await graphql({ schema: merged, source: '{ a }' });
    expect(result.errors).toBeUndefined();
    expect(result.data?.a).toBe('ok');
  });

  test('should combine custom roots from different sources (mergeSchemas)', () => {
    const a = buildSchema('schema { query: RootQuery } type RootQuery { a: String }');
    const b = buildSchema(
      'schema { query: RootQuery mutation: RootMutation } type RootQuery { b: String } type RootMutation { c: String }'
    );

    const merged = mergeSchemas([a, b]);

    expect(Object.keys(merged.getQueryType()!.getFields())).toEqual(['a', 'b']);
    expect(merged.getMutationType()?.name).toBe('RootMutation');
  });

  test.each([
    ['default', undefined, 'Query', 'RootQuery'],
    ['last', { onTypeConflict: 'last' }, 'RootQuery', 'Query'],
    ['error', { onTypeConflict: 'error' }, 'Query', 'RootQuery'],
  ] as const)('should resolve conflicting root names under the %s policy (mergeSchemas)', async (_policy, options, rootName, loserName) => {
    const a = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { a: { type: GraphQLString, resolve: () => 'from a' } },
      }),
    });
    const b = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'RootQuery',
        fields: { b: { type: GraphQLString, resolve: () => 'from b' } },
      }),
    });

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    let merged: GraphQLSchema;
    try {
      merged = mergeSchemas([a, b], undefined, options);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(merged.getQueryType()?.name).toBe(rootName);
    expect(merged.getType(loserName)).toBeUndefined();

    const result = await graphql({ schema: merged, source: '{ a b }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ a: 'from a', b: 'from b' });
  });
});

describe('root type folding', () => {
  test.each([
    ['first', undefined, 'RootQuery', 'Query'],
    ['last', { onTypeConflict: 'last' }, 'Query', 'RootQuery'],
  ] as const)('should merge a default Query into a custom query root under "%s" (mergeSchemasFromStrings)', async (_policy, options, rootName, loserName) => {
    const schema = mergeSchemasFromStrings(
      [
        'schema { query: RootQuery } type RootQuery { a: String }',
        'type Query { b: String }',
      ],
      undefined,
      options
    );
    expect(schema.getQueryType()?.name).toBe(rootName);
    expect(schema.getType(loserName)).toBeUndefined();

    const result = await graphql({
      schema,
      source: '{ a b }',
      rootValue: { a: 'A', b: 'B' },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ a: 'A', b: 'B' });
  });

  test.each([
    ['default', undefined, 'Query', 'A root', 'tagA'],
    ['first', { onTypeConflict: 'first' }, 'Query', 'A root', 'tagA'],
    ['last', { onTypeConflict: 'last' }, 'RootB', 'B root', 'tagB'],
  ] as const)('should take the root description and directives from the winning candidate under the %s policy (mergeSchemasFromStrings)', (_policy, options, rootName, description, directive) => {
    const typeDefs = [
      'directive @tagA on OBJECT directive @tagB on OBJECT """A root""" type Query @tagA { a: String }',
      'schema { query: RootB } """B root""" type RootB @tagB { b: String }',
    ];

    const root = mergeSchemasFromStrings(typeDefs, undefined, options).getQueryType()!;
    expect(root.name).toBe(rootName);
    expect(root.description).toBe(description);
    expect(root.astNode?.directives?.map((d) => d.name.value)).toEqual([directive]);
    expect(Object.keys(root.getFields())).toEqual(['a', 'b']);
  });

  test('should drop the losing candidate\'s description when the winner has none (mergeSchemasFromStrings)', () => {
    const root = mergeSchemasFromStrings(
      [
        '"""A root""" type Query { a: String }',
        'schema { query: RootB } type RootB { b: String }',
      ],
      undefined,
      { onTypeConflict: 'last' }
    ).getQueryType()!;

    expect(root.name).toBe('RootB');
    expect(root.description).toBeUndefined();
  });

  test('should not throw under "error" when the roots share no field (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings(
      [
        'schema { query: RootQuery } type RootQuery { a: String }',
        'type Query { b: String }',
      ],
      undefined,
      { onTypeConflict: 'error' }
    );

    expect(schema.getQueryType()?.name).toBe('RootQuery');
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(['a', 'b']);
  });

  test('should throw under "error" on a root field defined with different types (mergeSchemasFromStrings)', () => {
    expect(() =>
      mergeSchemasFromStrings(
        [
          'schema { query: RootQuery } type RootQuery { a: String }',
          'type Query { a: Int }',
        ],
        undefined,
        { onTypeConflict: 'error' }
      )
    ).toThrow('Type conflict: RootQuery.a is defined multiple times');
  });

  test('should resolve a shared root field per policy (mergeSchemasFromStrings)', () => {
    const typeDefs = [
      'schema { query: RootQuery } type RootQuery { a: String }',
      'type Query { a: Int }',
    ];

    expect(
      mergeSchemasFromStrings(typeDefs).getQueryType()!.getFields().a!.type.toString()
    ).toBe('String');
    expect(
      mergeSchemasFromStrings(typeDefs, undefined, { onTypeConflict: 'last' })
        .getQueryType()!
        .getFields()
        .a!.type.toString()
    ).toBe('Int');
  });

  test('should fold extensions of the losing root type (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings([
      'schema { query: RootQuery } type RootQuery { a: String }',
      'type Query { b: String }',
      'extend type Query { c: String }',
    ]);

    expect(schema.getType('Query')).toBeUndefined();
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(['a', 'b', 'c']);
  });

  test('should keep a losing root type that another type references (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings([
      'schema { query: RootQuery } type RootQuery { a: String }',
      'type Query { b: String } type Wrapper { inner: Query }',
    ]);

    expect(schema.getQueryType()?.name).toBe('RootQuery');
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(['a', 'b']);
    expect(Object.keys((schema.getType('Query') as GraphQLObjectType).getFields())).toEqual(['b']);
  });

  test('should leave an undefined root type to the schema build error (mergeSchemasFromStrings)', () => {
    expect(() =>
      mergeSchemasFromStrings([
        'schema { query: Missing }',
        'type Query { b: String }',
      ])
    ).toThrow('Failed to merge schemas');
  });

  test('should not throw under "error" when the roots share no field (mergeSchemas)', () => {
    const a = buildSchema('schema { query: RootQuery } type RootQuery { a: String }');
    const b = buildSchema('type Query { b: String }');

    const merged = mergeSchemas([a, b], undefined, { onTypeConflict: 'error' });

    expect(merged.getQueryType()?.name).toBe('RootQuery');
    expect(Object.keys(merged.getQueryType()!.getFields())).toEqual(['a', 'b']);
  });

  test('should throw under "error" on a root field defined with different types (mergeSchemas)', () => {
    const a = buildSchema('schema { query: RootQuery } type RootQuery { a: String }');
    const b = buildSchema('type Query { a: Int }');

    expect(() =>
      mergeSchemas([a, b], undefined, { onTypeConflict: 'error' })
    ).toThrow('Type conflict: RootQuery.a is defined multiple times');
  });

  test('should keep a referenced losing root type and its resolvers (mergeSchemas)', async () => {
    const query: GraphQLObjectType = new GraphQLObjectType({
      name: 'Query',
      fields: () => ({
        b: { type: GraphQLString, resolve: () => 'B' },
        self: { type: query, resolve: () => ({}) },
      }),
    });
    const a = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'RootQuery',
        fields: { a: { type: GraphQLString, resolve: () => 'A' } },
      }),
    });
    const b = new GraphQLSchema({ query });

    const merged = mergeSchemas([a, b]);

    expect(merged.getQueryType()?.name).toBe('RootQuery');
    expect(merged.getType('Query')).toBeDefined();
    const result = await graphql({ schema: merged, source: '{ a b self { b } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ a: 'A', b: 'B', self: { b: 'B' } });
  });
});

describe('explicit resolvers for a folded root type', () => {
  const CUSTOM_ROOT = 'schema { query: RootQuery } type RootQuery { a: String }';
  const DEFAULT_ROOT = 'type Query { b: String }';
  // Each root references the other, so whichever loses the fold is kept.
  const CUSTOM_ROOT_REFERENCING =
    'schema { query: RootQuery } type RootQuery { a: String toQuery: Query } type Query { unused: String }';
  const DEFAULT_ROOT_REFERENCING = 'type Query { b: String toRoot: RootQuery }';

  const resolvers = (): { RootQuery: { a: () => string }; Query: { b: () => string } } => ({
    RootQuery: { a: () => 'A' },
    Query: { b: () => 'B' },
  });

  const policies = [
    ['first', undefined, 'RootQuery', 'Query', 'b'],
    ['last', { onTypeConflict: 'last' }, 'Query', 'RootQuery', 'a'],
  ] as const;

  test.each(policies)(
    'should apply a dropped losing root type\'s resolvers to the winner under "%s" (mergeSchemasFromStrings)',
    async (_policy, options, rootName, loserName) => {
      const schema = mergeSchemasFromStrings(
        [CUSTOM_ROOT, DEFAULT_ROOT],
        resolvers(),
        options
      );

      expect(schema.getQueryType()?.name).toBe(rootName);
      expect(schema.getType(loserName)).toBeUndefined();

      const result = await graphql({ schema, source: '{ a b }' });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ a: 'A', b: 'B' });
    }
  );

  test.each(policies)(
    'should apply a kept losing root type\'s resolvers to the winner and itself under "%s" (mergeSchemasFromStrings)',
    async (_policy, options, rootName, loserName, loserField) => {
      const schema = mergeSchemasFromStrings(
        [
          'schema { query: RootQuery } type RootQuery { a: String toQuery: Query }',
          DEFAULT_ROOT_REFERENCING,
        ],
        resolvers(),
        options
      );

      expect(schema.getQueryType()?.name).toBe(rootName);
      const loser = schema.getType(loserName) as GraphQLObjectType;
      expect(loser).toBeDefined();
      expect(loser.getFields()[loserField]!.resolve).toBeFunction();

      const result = await graphql({ schema, source: '{ a b }' });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ a: 'A', b: 'B' });
    }
  );

  test.each(policies)(
    'should apply a dropped losing root type\'s resolvers to the winner under "%s" (mergeSchemas)',
    async (_policy, options, rootName, loserName) => {
      const merged = mergeSchemas(
        [buildSchema(CUSTOM_ROOT), buildSchema(DEFAULT_ROOT)],
        resolvers(),
        options
      );

      expect(merged.getQueryType()?.name).toBe(rootName);
      expect(merged.getType(loserName)).toBeUndefined();

      const result = await graphql({ schema: merged, source: '{ a b }' });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ a: 'A', b: 'B' });
    }
  );

  test.each(policies)(
    'should apply a kept losing root type\'s resolvers to the winner and itself under "%s" (mergeSchemas)',
    async (_policy, options, rootName, loserName, loserField) => {
      const merged = mergeSchemas(
        [
          buildSchema(CUSTOM_ROOT_REFERENCING),
          buildSchema(
            'type Query { b: String toRoot: RootQuery } type RootQuery { unused: String }'
          ),
        ],
        resolvers(),
        options
      );

      expect(merged.getQueryType()?.name).toBe(rootName);
      const loser = merged.getType(loserName) as GraphQLObjectType;
      expect(loser).toBeDefined();
      expect(loser.getFields()[loserField]!.resolve).toBeFunction();

      const result = await graphql({ schema: merged, source: '{ a b }' });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ a: 'A', b: 'B' });
    }
  );

  test.each([
    ['mergeSchemasFromStrings', (typeDefs: string[], resolvers: Resolvers) =>
      mergeSchemasFromStrings(typeDefs, resolvers)],
    ['mergeSchemas', (typeDefs: string[], resolvers: Resolvers) =>
      mergeSchemas(typeDefs.map((sdl) => buildSchema(sdl)), resolvers)],
  ] as const)('should apply a bare function keyed by a losing subscription root as subscribe on the winner (%s)', (_entryPoint, merge) => {
    const subscribeFn = async function* (): AsyncGenerator<{ t: string }> {
      yield { t: 'T' };
    };
    const schema = merge(
      [
        'schema { query: Q subscription: RootSub } type Q { x: String } type RootSub { s: String }',
        'type Subscription { t: String }',
      ],
      { Subscription: { t: subscribeFn } }
    );

    expect(schema.getSubscriptionType()?.name).toBe('RootSub');
    const field = schema.getSubscriptionType()!.getFields().t!;
    expect(field.subscribe).toBe(subscribeFn);
    expect(field.resolve).toBeUndefined();
  });
});

describe('loser-keyed resolvers for a field only the winner has', () => {
  // Query loses to RootQuery and is kept, because RootQuery references it.
  const sources = [
    'schema { query: RootQuery } type RootQuery { a: String q: Query }',
    'type Query { b: String }',
  ];
  const merges = [
    ['mergeSchemasFromStrings', (r: Resolvers) => mergeSchemasFromStrings(sources, r)],
    [
      'mergeSchemas',
      // buildSchema needs Query defined wherever it is referenced
      (r: Resolvers) =>
        mergeSchemas(
          [buildSchema(`${sources[0]} type Query { b: String }`), buildSchema(sources[1]!)],
          r
        ),
    ],
  ] as const;

  test.each(merges)(
    'should apply the resolver to the winner when the losing root is kept (%s)',
    async (_name, merge) => {
      const schema = merge({ Query: { a: () => 'A' } });

      expect(schema.getQueryType()?.name).toBe('RootQuery');
      expect(schema.getType('Query')).toBeDefined();
      const result = await graphql({ schema, source: '{ a }' });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ a: 'A' });
    }
  );

  test.each(merges)(
    'should still reject a field the winner does not define (%s)',
    (_name, merge) => {
      expect(() => merge({ Query: { nope: () => 'x' } })).toThrow(
        'Resolvers reference unknown field "Query.nope".'
      );
    }
  );
});

describe('losing subscription root kept as an ordinary type', () => {
  test('should apply resolvers as resolve on a kept losing subscription root', async () => {
    const typeDefs = [
      'type Subscription { a: String } type Query { q: String }',
      'schema { query: Query, subscription: Sub } type Sub { a: String } extend type Query { sub: Sub }',
    ];
    const resolvers = {
      Sub: { a: () => 'custom' },
      Query: { sub: () => ({}) },
    };

    const schema = mergeSchemasFromStrings(typeDefs, resolvers);
    const result = await graphql({ schema, source: '{ sub { a } }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ sub: { a: 'custom' } });
  });
});

describe('default root names alongside a schema definition', () => {
  test('should keep a default Mutation when another source has a schema block (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings([
      'schema { query: RootQuery } type RootQuery { a: String }',
      'type Mutation { m: String }',
    ]);

    expect(schema.getQueryType()?.name).toBe('RootQuery');
    expect(schema.getMutationType()?.name).toBe('Mutation');
  });

  test('should keep a default Subscription when another source has a schema block (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings([
      'schema { query: RootQuery } type RootQuery { a: String }',
      'type Subscription { s: String }',
    ]);

    expect(schema.getQueryType()?.name).toBe('RootQuery');
    expect(schema.getSubscriptionType()?.name).toBe('Subscription');
  });
});

describe('a source schema definition is authoritative for its own roots', () => {
  const sdl =
    'schema { query: RootQuery } type RootQuery { a: String } type Mutation { m: String }';

  test('should not promote a default-named type in a source with a schema block (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings([sdl]);

    expect(buildSchema(sdl).getMutationType()).toBeUndefined();
    expect(schema.getMutationType()).toBeUndefined();
    expect(schema.getQueryType()?.name).toBe('RootQuery');
    expect(schema.getType('Mutation')).toBeDefined();
  });

  test('should still use a default Mutation from a source with no schema block (mergeSchemasFromStrings)', () => {
    const schema = mergeSchemasFromStrings([sdl, 'type Mutation { n: String }']);

    expect(schema.getMutationType()?.name).toBe('Mutation');
  });

  test('should not promote a non-root default-named type (mergeSchemas)', () => {
    const a = buildSchema(
      'schema { query: Query } type Query { a: String } type Mutation { m: String }'
    );
    const b = buildSchema('type Query { b: String }');

    expect(a.getMutationType()).toBeUndefined();
    const merged = mergeSchemas([a, b]);
    expect(merged.getMutationType()).toBeUndefined();
    expect(Object.keys(merged.getQueryType()!.getFields())).toEqual(['a', 'b']);
  });
});

describe('schema definition merging', () => {
  test('should carry the schema description', () => {
    const schema = mergeSchemasFromStrings([
      '"The API" schema { query: RootQuery } type RootQuery { a: String }',
      'type Mutation { m: String }',
    ]);

    expect(schema.description).toBe('The API');
  });

  test('should keep directives from both a schema definition and an extension', () => {
    const schema = mergeSchemasFromStrings([
      'directive @a on SCHEMA directive @b on SCHEMA schema @a { query: RootQuery } type RootQuery { x: String }',
      'extend schema @b',
    ]);

    expect(schema.astNode?.directives?.map((d) => d.name.value)).toEqual(['a', 'b']);
  });

  test('should keep every distinct occurrence of a repeatable directive', () => {
    const schema = mergeSchemasFromStrings([
      'directive @link(url: String!) repeatable on SCHEMA type Query { x: String }',
      'extend schema @link(url: "a") @link(url: "b")',
    ]);

    expect((schema.astNode?.directives ?? []).map((d) => print(d))).toEqual([
      '@link(url: "a")',
      '@link(url: "b")',
    ]);
  });

  test('should collapse an exact duplicate of a repeatable directive', () => {
    const schema = mergeSchemasFromStrings([
      'directive @link(url: String!) repeatable on SCHEMA schema @link(url: "a") { query: RootQuery } type RootQuery { x: String }',
      'extend schema @link(url: "a") @link(url: "b")',
    ]);

    expect((schema.astNode?.directives ?? []).map((d) => print(d))).toEqual([
      '@link(url: "a")',
      '@link(url: "b")',
    ]);
  });

  test('should keep the first occurrence of a repeated non-repeatable directive', () => {
    const schema = mergeSchemasFromStrings([
      'directive @tag(name: String) on SCHEMA schema @tag(name: "first") { query: RootQuery } type RootQuery { x: String }',
      'extend schema @tag(name: "second")',
    ]);

    const directives = schema.astNode?.directives ?? [];
    expect(directives).toHaveLength(1);
    expect(print(directives[0]!)).toBe('@tag(name: "first")');
  });

  test('should turn a bare extend schema plus a default Query into one schema definition', () => {
    const schema = mergeSchemasFromStrings([
      'directive @a on SCHEMA type Query { x: String }',
      'extend schema @a',
    ]);

    expect(schema.getQueryType()?.name).toBe('Query');
    expect(schema.astNode?.directives?.map((d) => d.name.value)).toEqual(['a']);
    expect(schema.extensionASTNodes).toHaveLength(0);
  });

  test('should keep a bare extend schema as an extension when there are no root types', () => {
    const schema = mergeSchemasFromStrings([
      'directive @a on SCHEMA type Thing { x: String }',
      'extend schema @a',
    ]);

    expect(schema.getQueryType()).toBeUndefined();
    expect(schema.extensionASTNodes).toHaveLength(1);
  });

  test('should take the schema description from a later source when the first has none', () => {
    const schema = mergeSchemasFromStrings([
      'schema { query: RootQuery } type RootQuery { a: String }',
      '"The API" schema { query: RootQuery }',
    ]);

    expect(schema.description).toBe('The API');
  });

  test('should dedupe a non-repeatable directive across bare extend schema sources with no root types', () => {
    const schema = mergeSchemasFromStrings([
      'directive @a on SCHEMA\n extend schema @a\n type T { x: Int }',
      'extend schema @a\n type U { y: Int }',
    ]);

    expect(schema.getQueryType()).toBeUndefined();
    expect(
      schema.extensionASTNodes.flatMap((node) =>
        (node.directives ?? []).map((d) => d.name.value)
      )
    ).toEqual(['a']);
  });
});

describe('schema-level directives (mergeSchemas)', () => {
  const printed = (schema: GraphQLSchema): string[] =>
    (schema.astNode?.directives ?? []).map((d) => print(d));

  test('should carry schema directives from SDL-built sources', () => {
    const merged = mergeSchemas([
      buildSchema('directive @a on SCHEMA schema @a { query: Query } type Query { x: String }'),
      buildSchema('directive @b on SCHEMA type User { id: ID } extend schema @b'),
    ]);

    expect(merged.getQueryType()?.name).toBe('Query');
    expect(printed(merged)).toEqual(['@a', '@b']);
  });

  test('should keep every distinct occurrence of a repeatable directive and collapse exact duplicates', () => {
    const link = 'directive @link(url: String!) repeatable on SCHEMA';
    const merged = mergeSchemas([
      buildSchema(`${link} schema @link(url: "a") { query: Query } type Query { x: String }`),
      buildSchema(`${link} type User { id: ID } extend schema @link(url: "a") @link(url: "b")`),
    ]);

    expect(printed(merged)).toEqual(['@link(url: "a")', '@link(url: "b")']);
  });

  test('should keep the first occurrence of a non-repeatable directive', () => {
    const tag = 'directive @tag(name: String) on SCHEMA';
    const merged = mergeSchemas([
      buildSchema(`${tag} schema @tag(name: "first") { query: Query } type Query { x: String }`),
      buildSchema(`${tag} type User { id: ID } extend schema @tag(name: "second")`),
    ]);

    expect(printed(merged)).toEqual(['@tag(name: "first")']);
  });

  test('should keep schema directives on custom root names', () => {
    const merged = mergeSchemas([
      buildSchema('directive @a on SCHEMA schema @a { query: RootQuery } type RootQuery { x: String }'),
      buildSchema('type User { id: ID }'),
    ]);

    expect(merged.getQueryType()?.name).toBe('RootQuery');
    expect(printed(merged)).toEqual(['@a']);
  });

  test('should carry schema directives on an extension when no source has a root type', () => {
    const merged = mergeSchemas([
      buildSchema('directive @a on SCHEMA type Thing { x: String } extend schema @a'),
      buildSchema('type Other { y: String }'),
    ]);

    expect(merged.getQueryType()).toBeUndefined();
    expect(
      merged.extensionASTNodes.flatMap((node) => node.directives ?? []).map((d) => print(d))
    ).toEqual(['@a']);
  });

  test('should carry the first schema description from SDL-built sources', () => {
    const merged = mergeSchemas([
      buildSchema('type User { id: ID }'),
      buildSchema('"First" schema { query: Query } type Query { x: String }'),
      buildSchema('"Second" schema { query: Query } type Query { y: String }'),
    ]);

    expect(merged.description).toBe('First');
    expect(merged.getQueryType()?.name).toBe('Query');
  });

  test('should carry the first schema description from code-built sources', () => {
    const query = (name: string): GraphQLObjectType =>
      new GraphQLObjectType({ name: 'Query', fields: { [name]: { type: GraphQLString } } });
    const merged = mergeSchemas([
      new GraphQLSchema({ query: query('a') }),
      new GraphQLSchema({ description: 'Code first', query: query('b') }),
      new GraphQLSchema({ description: 'Code second', query: query('c') }),
    ]);

    expect(merged.description).toBe('Code first');
    expect(Object.keys(merged.getQueryType()!.getFields())).toEqual(['a', 'b', 'c']);
  });

  test('should not add a schema definition for sources without schema directives', () => {
    const merged = mergeSchemas([
      buildSchema('type Query { x: String }'),
      buildSchema('type User { id: ID }'),
    ]);

    expect(merged.astNode).toBeUndefined();
  });
});

describe('bare subscription resolvers', () => {
  test('should apply a bare function under Subscription as subscribe (mergeSchemasFromStrings)', async () => {
    const schema = mergeSchemasFromStrings(
      ['type Query { _: String } type Subscription { tick: Int }'],
      {
        Subscription: {
          tick: async function* () {
            yield { tick: 1 };
            yield { tick: 2 };
          },
        },
      }
    );

    const result = await subscribe({
      schema,
      document: parse('subscription { tick }'),
    });

    const values: unknown[] = [];
    for await (const payload of result as AsyncIterable<ExecutionResult>) {
      expect(payload.errors).toBeUndefined();
      values.push(payload.data?.tick);
    }

    expect(values).toEqual([1, 2]);
  });

  test('should apply a bare function under a custom subscription root as subscribe (mergeSchemas)', async () => {
    const a = buildSchema(
      'schema { query: Query subscription: Events } type Query { _: String } type Events { tick: Int }'
    );
    const b = buildSchema('type Query { other: String }');

    const merged = mergeSchemas([a, b], {
      Events: {
        tick: async function* () {
          yield { tick: 1 };
        },
      },
    });

    const result = await subscribe({
      schema: merged,
      document: parse('subscription { tick }'),
    });

    const values: unknown[] = [];
    for await (const payload of result as AsyncIterable<ExecutionResult>) {
      expect(payload.errors).toBeUndefined();
      values.push(payload.data?.tick);
    }

    expect(values).toEqual([1]);
  });
});

describe('resolver precedence for folded root types', () => {
  /**
   * Build a schema whose query root is `rootName`, each field resolving to a
   * constant
   */
  function rootSchema(
    rootName: string,
    fields: Record<string, [GraphQLOutputType, unknown]>
  ): GraphQLSchema {
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: rootName,
        fields: Object.fromEntries(
          Object.entries(fields).map(([name, [type, value]]) => [
            name,
            { type, resolve: () => value },
          ])
        ),
      }),
    });
  }

  test('should keep the resolver of the source that supplied its SDL for a winning root field under "first"', async () => {
    const merged = mergeSchemas([
      rootSchema('RootQuery', { a: [GraphQLString, 'A'] }),
      rootSchema('Query', { x: [GraphQLString, 'fromB-Query'] }),
      rootSchema('RootQuery', { x: [GraphQLString, 'fromC-RootQuery'] }),
    ]);

    expect(merged.getQueryType()?.name).toBe('RootQuery');
    const result = await graphql({ schema: merged, source: '{ a x }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ a: 'A', x: 'fromC-RootQuery' });
  });

  test('should keep the resolver of the source that supplied its SDL for a winning root field under "last"', async () => {
    const merged = mergeSchemas(
      [
        rootSchema('Query', { x: [GraphQLString, 'fromA-Query'] }),
        rootSchema('RootQuery', { x: [GraphQLString, 'fromB-RootQuery'] }),
        rootSchema('Query', { x: [GraphQLString, 'fromC-Query'] }),
      ],
      undefined,
      { onTypeConflict: 'last' }
    );

    expect(merged.getQueryType()?.name).toBe('RootQuery');
    const result = await graphql({ schema: merged, source: '{ x }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ x: 'fromB-RootQuery' });
  });

  test('should not coerce a losing root resolver into a winning field of another type', async () => {
    const merged = mergeSchemas([
      rootSchema('RootQuery', { a: [GraphQLString, 'A'] }),
      rootSchema('Query', { x: [GraphQLInt, 0] }),
      rootSchema('RootQuery', { x: [GraphQLBoolean, true] }),
    ]);

    expect(String(merged.getQueryType()!.getFields().x!.type)).toBe('Boolean');
    const result = await graphql({ schema: merged, source: '{ x }' });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ x: true });
  });

  test('should follow the losing root that supplied the field among losing roots', async () => {
    const sources = (): GraphQLSchema[] => [
      rootSchema('R1', { z: [GraphQLString, 'Z'] }),
      rootSchema('R2', { x: [GraphQLString, 'fromR2'] }),
      rootSchema('R3', { x: [GraphQLString, 'fromR3'] }),
    ];

    const first = mergeSchemas(sources());
    expect(first.getQueryType()?.name).toBe('R1');
    expect((await graphql({ schema: first, source: '{ x }' })).data).toEqual({
      x: 'fromR2',
    });

    const last = mergeSchemas(sources(), undefined, { onTypeConflict: 'last' });
    expect(last.getQueryType()?.name).toBe('R3');
    expect((await graphql({ schema: last, source: '{ x }' })).data).toEqual({
      x: 'fromR3',
    });
  });

  describe('explicit resolvers', () => {
    const typeDefs = [
      'schema { query: R1 } type R1 { x: String }',
      'schema { query: R2 } type R2 { x: String }',
      'schema { query: R3 } type R3 { x: String }',
    ];

    const merges = [
      [
        'mergeSchemasFromStrings',
        (resolvers: Resolvers, options?: MergeOptions) =>
          mergeSchemasFromStrings(typeDefs, resolvers, options),
      ],
      [
        'mergeSchemas',
        (resolvers: Resolvers, options?: MergeOptions) =>
          mergeSchemas(
            typeDefs.map((sdl) => buildSchema(sdl)),
            resolvers,
            options
          ),
      ],
    ] as const;

    const resolverFor = (name: string): Resolvers[string] => ({
      x: () => name,
    });

    test.each(merges)(
      'should let a key naming the winning root override losing-root keys whatever the key order (%s)',
      async (_entryPoint, merge) => {
        const first = merge({
          R1: resolverFor('R1'),
          R2: resolverFor('R2'),
          R3: resolverFor('R3'),
        });
        expect((await graphql({ schema: first, source: '{ x }' })).data).toEqual(
          { x: 'R1' }
        );

        const last = merge(
          {
            R3: resolverFor('R3'),
            R2: resolverFor('R2'),
            R1: resolverFor('R1'),
          },
          { onTypeConflict: 'last' }
        );
        expect((await graphql({ schema: last, source: '{ x }' })).data).toEqual(
          { x: 'R3' }
        );
      }
    );

    test.each(merges)(
      'should apply losing-root keys in fold precedence order (%s)',
      async (_entryPoint, merge) => {
        const first = merge({ R2: resolverFor('R2'), R3: resolverFor('R3') });
        expect((await graphql({ schema: first, source: '{ x }' })).data).toEqual(
          { x: 'R2' }
        );

        const last = merge(
          { R2: resolverFor('R2'), R1: resolverFor('R1') },
          { onTypeConflict: 'last' }
        );
        expect((await graphql({ schema: last, source: '{ x }' })).data).toEqual(
          { x: 'R2' }
        );
      }
    );
  });
});
