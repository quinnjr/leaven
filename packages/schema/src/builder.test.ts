/**
 * @leaven-graphql/schema - Builder tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import {
  graphql,
  parse,
  subscribe,
  type ExecutionResult,
  type GraphQLEnumType,
  type GraphQLObjectType,
} from 'graphql';
import { SchemaBuilder, createSchemaBuilder } from './builder';

/**
 * Drain a subscription result into an array of field values
 */
async function collectSubscription(
  result: unknown,
  fieldName: string
): Promise<unknown[]> {
  expect(Symbol.asyncIterator in (result as object)).toBe(true);

  const values: unknown[] = [];
  for await (const payload of result as AsyncIterable<ExecutionResult>) {
    expect(payload.errors).toBeUndefined();
    values.push(payload.data?.[fieldName]);
  }
  return values;
}

describe('SchemaBuilder', () => {
  describe('constructor', () => {
    test('should create builder with default options', () => {
      const builder = new SchemaBuilder();
      expect(builder).toBeDefined();
    });

    test('should create builder with custom options', () => {
      const builder = new SchemaBuilder({
        query: true,
        mutation: false,
        subscription: false,
      });
      expect(builder).toBeDefined();
    });
  });

  describe('addScalar', () => {
    test('should serialize values through the custom scalar', async () => {
      const builder = new SchemaBuilder();

      builder.addScalar({
        name: 'Date',
        description: 'Date scalar',
        serialize: (value) => (value as Date).toISOString(),
        parseValue: (value) => new Date(value as string),
      });

      builder.addQueryFields({
        now: {
          type: 'Date',
          resolve: () => new Date('2026-01-01'),
        },
      });

      const schema = builder.build();
      const result = await graphql({ schema, source: '{ now }' });

      expect(result.errors).toBeUndefined();
      expect(result.data?.now).toBe('2026-01-01T00:00:00.000Z');
    });

    test('should parse values through the custom scalar', async () => {
      const builder = new SchemaBuilder();

      builder.addScalar({
        name: 'Date',
        serialize: (value) => (value as Date).toISOString(),
        parseValue: (value) => new Date(value as string),
      });

      builder.addQueryFields({
        year: {
          type: 'Int!',
          args: { at: { type: 'Date!' } },
          resolve: (_, { at }: { at: Date }) => at.getUTCFullYear(),
        },
      });

      const schema = builder.build();
      const result = await graphql({
        schema,
        source: 'query ($at: Date!) { year(at: $at) }',
        variableValues: { at: '2031-06-02T00:00:00.000Z' },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data?.year).toBe(2031);
    });
  });

  describe('addEnum', () => {
    test('should serialize internal values back to enum names', async () => {
      const builder = new SchemaBuilder();

      builder.addEnum({
        name: 'Status',
        values: {
          ACTIVE: { value: 'active' },
          INACTIVE: { value: 'inactive' },
        },
      });

      builder.addQueryFields({
        status: {
          type: 'Status',
          resolve: () => 'active',
        },
      });

      const schema = builder.build();
      const result = await graphql({ schema, source: '{ status }' });

      expect(result.errors).toBeUndefined();
      expect(result.data?.status).toBe('ACTIVE');
    });

    test('should support enum with descriptions', async () => {
      const builder = new SchemaBuilder();

      builder.addEnum({
        name: 'Priority',
        description: 'Priority levels',
        values: {
          HIGH: { value: 1, description: 'High priority' },
          MEDIUM: { value: 2, description: 'Medium priority' },
          LOW: { value: 3, description: 'Low priority', deprecationReason: 'Use MEDIUM instead' },
        },
      });

      builder.addQueryFields({
        priority: { type: 'Priority', resolve: () => 1 },
      });

      const schema = builder.build();
      const priority = schema.getType('Priority') as GraphQLEnumType;

      expect(priority.description).toBe('Priority levels');
      expect(priority.getValue('HIGH')?.description).toBe('High priority');
      expect(priority.getValue('LOW')?.deprecationReason).toBe(
        'Use MEDIUM instead'
      );

      const result = await graphql({ schema, source: '{ priority }' });

      expect(result.errors).toBeUndefined();
      expect(result.data?.priority).toBe('HIGH');
    });
  });

  describe('addType', () => {
    test('should add object type', async () => {
      const builder = new SchemaBuilder();

      builder.addType({
        name: 'User',
        fields: {
          id: { type: 'ID!' },
          name: { type: 'String' },
          email: { type: 'String!' },
        },
      });

      builder.addQueryFields({
        user: {
          type: 'User',
          args: { id: { type: 'ID!' } },
          resolve: (_, { id }: { id: string }) => ({ id, name: 'Test', email: 'test@test.com' }),
        },
      });

      const schema = builder.build();
      const result = await graphql({
        schema,
        source: '{ user(id: "7") { id name email } }',
      });

      expect(result.errors).toBeUndefined();
      expect(result.data?.user).toEqual({
        id: '7',
        name: 'Test',
        email: 'test@test.com',
      });
    });

    test('should handle nested types', async () => {
      const builder = new SchemaBuilder();

      builder.addType({
        name: 'Post',
        fields: {
          id: { type: 'ID!' },
          title: { type: 'String!' },
        },
      });

      builder.addType({
        name: 'User',
        fields: {
          id: { type: 'ID!' },
          name: { type: 'String' },
          posts: { type: '[Post!]!' },
        },
      });

      builder.addQueryFields({
        user: {
          type: 'User',
          resolve: () => ({
            id: '1',
            name: 'Test',
            posts: [{ id: '1', title: 'Hello' }],
          }),
        },
      });

      const schema = builder.build();
      const result = await graphql({
        schema,
        source: '{ user { id name posts { id title } } }',
      });

      expect(result.errors).toBeUndefined();
      expect(result.data?.user).toEqual({
        id: '1',
        name: 'Test',
        posts: [{ id: '1', title: 'Hello' }],
      });
    });
  });

  describe('addInputType', () => {
    test('should accept the input object as a mutation argument', async () => {
      const builder = new SchemaBuilder();

      builder.addInputType({
        name: 'CreateUserInput',
        fields: {
          name: { type: 'String!' },
          email: { type: 'String!' },
        },
      });

      builder.addType({
        name: 'User',
        fields: {
          id: { type: 'ID!' },
          name: { type: 'String' },
        },
      });

      builder.addMutationFields({
        createUser: {
          type: 'User',
          args: { input: { type: 'CreateUserInput!' } },
          resolve: (_, { input }: { input: { name: string } }) => ({
            id: '1',
            name: input.name,
          }),
        },
      });

      const schema = builder.build();
      const result = await graphql({
        schema,
        source:
          'mutation { createUser(input: { name: "Ada", email: "ada@example.com" }) { id name } }',
      });

      expect(result.errors).toBeUndefined();
      expect(result.data?.createUser).toEqual({ id: '1', name: 'Ada' });
    });

    test('should reject an input object missing a required field', async () => {
      const builder = new SchemaBuilder();

      builder.addInputType({
        name: 'CreateUserInput',
        fields: { name: { type: 'String!' } },
      });

      builder.addMutationFields({
        createUser: {
          type: 'String!',
          args: { input: { type: 'CreateUserInput!' } },
          resolve: () => 'ok',
        },
      });

      const schema = builder.build();
      const result = await graphql({
        schema,
        source: 'mutation { createUser(input: {}) }',
      });

      // graphql 16 and 17 word this rejection differently.
      expect(result.errors?.[0]?.message).toMatch(
        /CreateUserInput\.name" of required type "String!" was not provided|"CreateUserInput" to include required field "name"/
      );
    });
  });

  describe('addInterface', () => {
    test('should let the object type implement the interface', async () => {
      const builder = new SchemaBuilder();

      builder.addInterface({
        name: 'Node',
        fields: {
          id: { type: 'ID!' },
        },
      });

      builder.addType({
        name: 'User',
        interfaces: ['Node'],
        fields: {
          id: { type: 'ID!' },
          name: { type: 'String' },
        },
      });

      builder.addQueryFields({
        user: {
          type: 'User',
          resolve: () => ({ id: '1', name: 'Test' }),
        },
      });

      const schema = builder.build();
      const user = schema.getType('User') as GraphQLObjectType;

      expect(user.getInterfaces().map((iface) => iface.name)).toEqual(['Node']);

      const result = await graphql({
        schema,
        source: '{ user { __typename ... on Node { id } name } }',
      });

      expect(result.errors).toBeUndefined();
      expect(result.data?.user).toEqual({
        __typename: 'User',
        id: '1',
        name: 'Test',
      });
    });
  });

  describe('addUnion', () => {
    test('should resolve the union member through resolveType', async () => {
      const builder = new SchemaBuilder();

      builder.addType({
        name: 'Cat',
        fields: {
          name: { type: 'String!' },
          meows: { type: 'Boolean!' },
        },
      });

      builder.addType({
        name: 'Dog',
        fields: {
          name: { type: 'String!' },
          barks: { type: 'Boolean!' },
        },
      });

      builder.addUnion({
        name: 'Pet',
        types: ['Cat', 'Dog'],
        resolveType: (value) =>
          (value as { meows?: boolean }).meows !== undefined ? 'Cat' : 'Dog',
      });

      builder.addQueryFields({
        pet: {
          type: 'Pet',
          resolve: () => ({ name: 'Whiskers', meows: true }),
        },
        stray: {
          type: 'Pet',
          resolve: () => ({ name: 'Rex', barks: true }),
        },
      });

      const schema = builder.build();
      const result = await graphql({
        schema,
        source: `{
          pet { __typename ... on Cat { name meows } }
          stray { __typename ... on Dog { name barks } }
        }`,
      });

      expect(result.errors).toBeUndefined();
      expect(result.data?.pet).toEqual({
        __typename: 'Cat',
        name: 'Whiskers',
        meows: true,
      });
      expect(result.data?.stray).toEqual({
        __typename: 'Dog',
        name: 'Rex',
        barks: true,
      });
    });

    test('should throw when a union names an unknown member type', () => {
      const builder = new SchemaBuilder();

      builder.addUnion({ name: 'Pet', types: ['Cat'] });
      builder.addQueryFields({ pet: { type: 'Pet' } });

      expect(() => builder.build()).toThrow(
        'Type "Cat" not found for union "Pet"'
      );
    });
  });

  describe('addQueryFields', () => {
    test('should add query fields', async () => {
      const builder = new SchemaBuilder();

      builder.addQueryFields({
        hello: {
          type: 'String!',
          resolve: () => 'Hello, World!',
        },
      });

      const schema = builder.build();
      const result = await graphql({ schema, source: '{ hello }' });

      expect(result.data?.hello).toBe('Hello, World!');
    });

    test('should add fields with arguments', async () => {
      const builder = new SchemaBuilder();

      builder.addQueryFields({
        greet: {
          type: 'String!',
          args: {
            name: { type: 'String!', description: 'Name to greet' },
          },
          resolve: (_, { name }: { name: string }) => `Hello, ${name}!`,
        },
      });

      const schema = builder.build();
      const result = await graphql({
        schema,
        source: '{ greet(name: "World") }',
      });

      expect(result.data?.greet).toBe('Hello, World!');
    });
  });

  describe('addMutationFields', () => {
    test('should add mutation fields', async () => {
      const builder = new SchemaBuilder();

      builder.addMutationFields({
        setMessage: {
          type: 'String!',
          args: { message: { type: 'String!' } },
          resolve: (_, { message }: { message: string }) => message,
        },
      });

      const schema = builder.build();
      const result = await graphql({
        schema,
        source: 'mutation { setMessage(message: "Hello") }',
      });

      expect(result.data?.setMessage).toBe('Hello');
    });
  });

  describe('addSubscriptionFields', () => {
    test('should add subscription fields', () => {
      const builder = new SchemaBuilder();

      builder.addSubscriptionFields({
        messageAdded: {
          type: 'String!',
          resolve: (payload: string) => payload,
        },
      });

      const schema = builder.build();
      expect(schema.getSubscriptionType()).toBeDefined();
    });

    test('should execute subscriptions end-to-end', async () => {
      const builder = new SchemaBuilder();

      builder.addSubscriptionFields({
        countdown: {
          type: 'Int!',
          subscribe: async function* () {
            yield { countdown: 3 };
            yield { countdown: 2 };
            yield { countdown: 1 };
          },
        },
      });

      const schema = builder.build();
      const result = await subscribe({
        schema,
        document: parse('subscription { countdown }'),
      });

      const values = await collectSubscription(result, 'countdown');
      expect(values).toEqual([3, 2, 1]);
    });

    test('should combine subscribe with a payload-mapping resolve', async () => {
      const builder = new SchemaBuilder();

      builder.addSubscriptionFields({
        doubled: {
          type: 'Int!',
          subscribe: async function* () {
            yield 1;
            yield 2;
          },
          resolve: (payload) => (payload as number) * 2,
        },
      });

      const schema = builder.build();
      const result = await subscribe({
        schema,
        document: parse('subscription { doubled }'),
      });

      const values = await collectSubscription(result, 'doubled');
      expect(values).toEqual([2, 4]);
    });
  });

  describe('build', () => {
    test('should build valid schema', () => {
      const builder = new SchemaBuilder();

      builder.addQueryFields({
        hello: { type: 'String', resolve: () => 'world' },
      });

      const schema = builder.build();

      expect(schema).toBeDefined();
      expect(schema.getQueryType()).toBeDefined();
    });

    test('should create empty query if no fields', () => {
      const builder = new SchemaBuilder();
      const schema = builder.build();

      expect(schema.getQueryType()).toBeDefined();
      expect(schema.getQueryType()?.getFields()._empty).toBeDefined();
    });
  });

  describe('applyResolvers', () => {
    test('should apply resolvers to fields', async () => {
      const builder = new SchemaBuilder();

      builder.addQueryFields({
        hello: { type: 'String' },
      });

      builder.applyResolvers({
        Query: {
          hello: () => 'Applied resolver',
        },
      });

      const schema = builder.build();
      const result = await graphql({ schema, source: '{ hello }' });

      expect(result.data?.hello).toBe('Applied resolver');
    });

    test('should apply resolvers to non-root types', async () => {
      const builder = new SchemaBuilder();

      builder.addType({
        name: 'User',
        fields: {
          firstName: { type: 'String!' },
          lastName: { type: 'String!' },
          fullName: { type: 'String!' },
        },
      });

      builder.addQueryFields({
        user: {
          type: 'User',
          resolve: () => ({ firstName: 'Ada', lastName: 'Lovelace' }),
        },
      });

      builder.applyResolvers({
        User: {
          fullName: (parent) => {
            const user = parent as { firstName: string; lastName: string };
            return `${user.firstName} ${user.lastName}`;
          },
        },
      });

      const schema = builder.build();
      const result = await graphql({ schema, source: '{ user { fullName } }' });

      expect(result.errors).toBeUndefined();
      expect(result.data?.user).toEqual({ fullName: 'Ada Lovelace' });
    });

    test('should route bare Subscription resolvers to subscribe', async () => {
      const builder = new SchemaBuilder();

      builder.addSubscriptionFields({
        tick: { type: 'Int!' },
      });

      builder.applyResolvers({
        Subscription: {
          tick: async function* () {
            yield { tick: 1 };
            yield { tick: 2 };
          },
        },
      });

      const schema = builder.build();
      const result = await subscribe({
        schema,
        document: parse('subscription { tick }'),
      });

      const values = await collectSubscription(result, 'tick');
      expect(values).toEqual([1, 2]);
    });

    test('should support the { resolve, subscribe } object form', async () => {
      const builder = new SchemaBuilder();

      builder.addSubscriptionFields({
        tick: { type: 'Int!' },
      });

      builder.applyResolvers({
        Subscription: {
          tick: {
            subscribe: async function* () {
              yield 1;
              yield 2;
            },
            resolve: (payload) => (payload as number) * 10,
          },
        },
      });

      const schema = builder.build();
      const result = await subscribe({
        schema,
        document: parse('subscription { tick }'),
      });

      const values = await collectSubscription(result, 'tick');
      expect(values).toEqual([10, 20]);
    });

    test('should throw for resolvers on unknown types', () => {
      const builder = new SchemaBuilder();

      builder.addQueryFields({
        hello: { type: 'String' },
      });

      expect(() =>
        builder.applyResolvers({
          User: { name: () => 'x' },
        })
      ).toThrow('applyResolvers: unknown type "User"');
    });

    test('should throw for resolvers on unknown fields', () => {
      const builder = new SchemaBuilder();

      builder.addQueryFields({
        hello: { type: 'String' },
      });

      expect(() =>
        builder.applyResolvers({
          Query: { helo: () => 'x' },
        })
      ).toThrow('applyResolvers: field "Query.helo" is not defined');
    });

    test('should take effect on non-root types after an earlier build', async () => {
      const builder = new SchemaBuilder();

      builder.addType({
        name: 'User',
        fields: { name: { type: 'String' } },
      });

      builder.addQueryFields({
        user: { type: 'User', resolve: () => ({}) },
      });

      // Reading the fields of the first schema memoises User's field thunk
      const first = builder.build();
      const before = await graphql({ schema: first, source: '{ user { name } }' });
      expect(before.errors).toBeUndefined();
      expect(before.data?.user).toEqual({ name: null });

      builder.applyResolvers({ User: { name: () => 'Ada' } });

      const second = builder.build();
      const after = await graphql({ schema: second, source: '{ user { name } }' });

      expect(after.errors).toBeUndefined();
      expect(after.data?.user).toEqual({ name: 'Ada' });
    });

    test('should not disturb the schema returned by an earlier build', async () => {
      const builder = new SchemaBuilder();

      builder.addType({
        name: 'User',
        fields: { name: { type: 'String' } },
      });

      builder.addQueryFields({
        user: { type: 'User', resolve: () => ({}) },
      });

      const first = builder.build();
      await graphql({ schema: first, source: '{ user { name } }' });

      builder.applyResolvers({ User: { name: () => 'Ada' } });
      builder.build();

      const again = await graphql({ schema: first, source: '{ user { name } }' });

      expect(again.errors).toBeUndefined();
      expect(again.data?.user).toEqual({ name: null });
    });
  });

  describe('repeated builds', () => {
    test('should keep interfaces and unions consistent across builds', async () => {
      const builder = new SchemaBuilder();

      builder.addInterface({
        name: 'Node',
        fields: { id: { type: 'ID!' } },
      });

      builder.addType({
        name: 'Cat',
        interfaces: ['Node'],
        fields: { id: { type: 'ID!' }, meows: { type: 'Boolean!' } },
      });

      builder.addType({
        name: 'Dog',
        interfaces: ['Node'],
        fields: { id: { type: 'ID!' }, barks: { type: 'Boolean!' } },
      });

      builder.addUnion({
        name: 'Pet',
        types: ['Cat', 'Dog'],
        resolveType: (value) =>
          (value as { meows?: boolean }).meows !== undefined ? 'Cat' : 'Dog',
      });

      builder.addQueryFields({
        pet: { type: 'Pet', resolve: () => ({ id: '1', meows: true }) },
      });

      const source = '{ pet { __typename ... on Cat { id meows } } }';
      const expected = { __typename: 'Cat', id: '1', meows: true };

      const first = await graphql({ schema: builder.build(), source });
      expect(first.errors).toBeUndefined();
      expect(first.data?.pet).toEqual(expected);

      // A second build must rewire the union members and interface
      // implementations onto the freshly created object types
      const second = await graphql({ schema: builder.build(), source });
      expect(second.errors).toBeUndefined();
      expect(second.data?.pet).toEqual(expected);
    });
  });
});

describe('createSchemaBuilder', () => {
  test('should create a SchemaBuilder', () => {
    const builder = createSchemaBuilder();
    expect(builder).toBeInstanceOf(SchemaBuilder);
  });
});
