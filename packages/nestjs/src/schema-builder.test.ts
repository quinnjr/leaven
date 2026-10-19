/**
 * @leaven-graphql/nestjs - Schema Builder tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import 'reflect-metadata';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  buildSchema,
  graphql,
  parse,
  printSchema,
} from 'graphql';
import { readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SchemaBuilderService,
  getResolverMetadata,
  registerResolverMetadata,
  clearResolverMetadata,
  generateSchemaFile,
  type ResolverMetadata,
} from './schema-builder';
import { Deprecated, Description } from './decorators';
import { LeavenDriver } from './driver';
import type { LeavenModuleOptions } from './types';

describe('SchemaBuilderService', () => {
  let schema: GraphQLSchema;
  let driver: LeavenDriver;

  beforeEach(() => {
    schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          hello: {
            type: GraphQLString,
            resolve: () => 'world',
          },
        },
      }),
    });

    driver = new LeavenDriver({});
  });

  afterEach(() => {
    driver.onModuleDestroy();
  });

  describe('buildSchema', () => {
    test('should return provided schema', async () => {
      const options: LeavenModuleOptions = { schema };
      const builder = new SchemaBuilderService(options, driver);

      const result = await builder.buildSchema();

      expect(result).toBe(schema);
    });

    test('should return null when no schema source provided', async () => {
      const options: LeavenModuleOptions = {};
      const builder = new SchemaBuilderService(options, driver);

      const result = await builder.buildSchema();

      expect(result).toBeNull();
    });

    test('should initialize and set schema on module init', async () => {
      const options: LeavenModuleOptions = { schema };
      const builder = new SchemaBuilderService(options, driver);

      await builder.onModuleInit();

      expect(builder.getSchema()).toBe(schema);
      expect(driver.getSchema()).toBe(schema);
    });
  });

  describe('getSchema', () => {
    test('should return null before initialization', () => {
      const options: LeavenModuleOptions = { schema };
      const builder = new SchemaBuilderService(options, driver);

      expect(builder.getSchema()).toBeNull();
    });

    test('should return schema after initialization', async () => {
      const options: LeavenModuleOptions = { schema };
      const builder = new SchemaBuilderService(options, driver);

      await builder.onModuleInit();

      expect(builder.getSchema()).toBe(schema);
    });
  });

  describe('setSchema', () => {
    test('should update the schema', async () => {
      const options: LeavenModuleOptions = { schema };
      const builder = new SchemaBuilderService(options, driver);
      await builder.onModuleInit();

      const newSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            goodbye: {
              type: GraphQLString,
              resolve: () => 'world',
            },
          },
        }),
      });

      builder.setSchema(newSchema);

      expect(builder.getSchema()).toBe(newSchema);
      expect(driver.getSchema()).toBe(newSchema);
    });
  });

  describe('isSchemaReady', () => {
    test('should return false before initialization', () => {
      const options: LeavenModuleOptions = { schema };
      const builder = new SchemaBuilderService(options, driver);

      expect(builder.isSchemaReady()).toBe(false);
    });

    test('should return true after initialization', async () => {
      const options: LeavenModuleOptions = { schema };
      const builder = new SchemaBuilderService(options, driver);

      await builder.onModuleInit();

      expect(builder.isSchemaReady()).toBe(true);
    });
  });
});

describe('SchemaBuilderService with typeDefs', () => {
  let driver: LeavenDriver;

  beforeEach(() => {
    driver = new LeavenDriver({});
  });

  afterEach(() => {
    driver.onModuleDestroy();
  });

  test('should build schema from typeDefs without resolvers', async () => {
    const typeDefs = `
      type Query {
        hello: String
      }
    `;

    const options: LeavenModuleOptions = { typeDefs };
    const builder = new SchemaBuilderService(options, driver);

    const result = await builder.buildSchema();

    expect(result).toBeInstanceOf(GraphQLSchema);
    expect(result?.getQueryType()?.getFields()['hello']).toBeDefined();
  });

  test('should set schema on driver during onModuleInit for SDL-only typeDefs', async () => {
    const typeDefs = `
      type Query {
        hello: String
      }
    `;

    const options: LeavenModuleOptions = { typeDefs };
    const builder = new SchemaBuilderService(options, driver);

    await builder.onModuleInit();

    expect(builder.isSchemaReady()).toBe(true);
    expect(driver.getSchema()).toBeInstanceOf(GraphQLSchema);
  });

  test('should handle array of typeDefs', async () => {
    const typeDefs = [
      `type Query { hello: String }`,
      `extend type Query { goodbye: String }`,
    ];

    const options: LeavenModuleOptions = { typeDefs };
    const builder = new SchemaBuilderService(options, driver);

    const result = await builder.buildSchema();

    expect(result).toBeInstanceOf(GraphQLSchema);
    const fields = result?.getQueryType()?.getFields();
    expect(fields?.['hello']).toBeDefined();
    expect(fields?.['goodbye']).toBeDefined();
  });

  test('should handle DocumentNode typeDefs', async () => {
    const typeDefs = parse(`type Query { hello: String }`);

    const options: LeavenModuleOptions = { typeDefs };
    const builder = new SchemaBuilderService(options, driver);

    const result = await builder.buildSchema();

    expect(result).toBeInstanceOf(GraphQLSchema);
    expect(result?.getQueryType()?.getFields()['hello']).toBeDefined();
  });

  test('should handle array of mixed string and DocumentNode typeDefs', async () => {
    const typeDefs = [
      `type Query { hello: String }`,
      parse(`extend type Query { goodbye: String }`),
    ];

    const options: LeavenModuleOptions = { typeDefs };
    const builder = new SchemaBuilderService(options, driver);

    const result = await builder.buildSchema();

    expect(result).toBeInstanceOf(GraphQLSchema);
    const fields = result?.getQueryType()?.getFields();
    expect(fields?.['hello']).toBeDefined();
    expect(fields?.['goodbye']).toBeDefined();
  });

  test('should return null when only resolvers provided without typeDefs', async () => {
    const resolvers = {
      Query: {
        hello: () => 'world',
      },
    };

    const options: LeavenModuleOptions = { resolvers };
    const builder = new SchemaBuilderService(options, driver);

    const result = await builder.buildSchema();

    expect(result).toBeNull();
  });

  test('should build an executable schema whose resolvers actually run', async () => {
    const options: LeavenModuleOptions = {
      typeDefs: 'type Query { hello: String }',
      resolvers: { Query: { hello: () => 'world' } },
    };
    const builder = new SchemaBuilderService(options, driver);

    const schema = await builder.buildSchema();
    expect(schema).toBeInstanceOf(GraphQLSchema);

    const result = await graphql({ schema: schema!, source: '{ hello }' });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ hello: 'world' });
  });

  test('should merge an array of typeDefs into one executable schema', async () => {
    const options: LeavenModuleOptions = {
      typeDefs: [
        `type Query { hello: String }`,
        `extend type Query { goodbye: String }`,
      ],
      resolvers: {
        Query: {
          hello: () => 'world',
          goodbye: () => 'farewell',
        },
      },
    };
    const builder = new SchemaBuilderService(options, driver);

    const schema = await builder.buildSchema();
    const result = await graphql({ schema: schema!, source: '{ hello goodbye }' });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ hello: 'world', goodbye: 'farewell' });
  });

  test('should accept an array of resolver maps and run every resolver in it', async () => {
    const options: LeavenModuleOptions = {
      typeDefs: `
        type Query {
          hello: String
          goodbye: String
        }
      `,
      resolvers: [
        { Query: { hello: () => 'world' } },
        { Query: { goodbye: () => 'farewell' } },
      ],
    };
    const builder = new SchemaBuilderService(options, driver);

    const schema = await builder.buildSchema();
    const result = await graphql({ schema: schema!, source: '{ hello goodbye }' });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ hello: 'world', goodbye: 'farewell' });
  });

  test('should hand the executable schema to the driver on module init', async () => {
    const options: LeavenModuleOptions = {
      typeDefs: 'type Query { hello: String }',
      resolvers: { Query: { hello: () => 'world' } },
    };
    const builder = new SchemaBuilderService(options, driver);

    await builder.onModuleInit();

    expect(builder.isSchemaReady()).toBe(true);
    expect(driver.getSchema()).toBe(builder.getSchema());
  });

  test('should apply @Description and @Deprecated resolver metadata to schema fields', async () => {
    class QueryResolvers {
      @Description('Fetch the greeting')
      public hello(): string {
        return 'world';
      }

      @Deprecated('Use hello instead')
      public legacyHello(): string {
        return 'world';
      }
    }

    const options: LeavenModuleOptions = {
      typeDefs: 'type Query { hello: String, legacyHello: String }',
      resolvers: { Query: new QueryResolvers() as unknown as Record<string, unknown> },
    };
    const builder = new SchemaBuilderService(options, driver);

    const schema = await builder.buildSchema();
    const fields = schema!.getQueryType()!.getFields();

    expect(fields['hello']?.description).toBe('Fetch the greeting');
    expect(fields['legacyHello']?.deprecationReason).toBe('Use hello instead');
    expect(printSchema(schema!)).toContain('@deprecated(reason: "Use hello instead")');
  });
});

describe('SchemaBuilderService with autoSchemaFile', () => {
  let driver: LeavenDriver;

  beforeEach(() => {
    driver = new LeavenDriver({});
  });

  afterEach(() => {
    driver.onModuleDestroy();
  });

  test('should throw a clear error because code-first generation is not implemented', async () => {
    const builder = new SchemaBuilderService({ autoSchemaFile: true }, driver);

    await expect(builder.buildSchema()).rejects.toThrow(
      'code-first schema generation is not implemented'
    );
  });

  test('should fail at bootstrap rather than leaving the driver schemaless', async () => {
    const builder = new SchemaBuilderService({ autoSchemaFile: true }, driver);

    await expect(builder.onModuleInit()).rejects.toThrow('autoSchemaFile');
    expect(builder.isSchemaReady()).toBe(false);
    expect(driver.getSchema()).toBeNull();
  });
});

describe('generateSchemaFile', () => {
  const testFilePath = join(tmpdir(), 'leaven-nestjs-test-schema.graphql');
  const nestedRoot = join(tmpdir(), 'leaven-nestjs-schema-test');

  afterEach(async () => {
    try {
      await unlink(testFilePath);
    } catch {
      // File may not exist
    }
    await rm(nestedRoot, { recursive: true, force: true });
  });

  test('should generate schema file', async () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          hello: {
            type: GraphQLString,
            resolve: () => 'world',
          },
        },
      }),
    });

    await generateSchemaFile(schema, { path: testFilePath });

    const content = await readFile(testFilePath, 'utf-8');

    expect(content).toContain('type Query');
    expect(content).toContain('hello');
  });

  test('should sort schema when sortSchema is true', async () => {
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          zebra: { type: GraphQLString },
          apple: { type: GraphQLString },
        },
      }),
    });

    await generateSchemaFile(schema, { path: testFilePath, sortSchema: true });

    const content = await readFile(testFilePath, 'utf-8');

    // In sorted order, apple should come before zebra
    const appleIndex = content.indexOf('apple');
    const zebraIndex = content.indexOf('zebra');
    expect(appleIndex).toBeLessThan(zebraIndex);
  });

  test('should include descriptions by default', async () => {
    const schema = buildSchema(`
      """A greeting type"""
      type Query {
        """Says hello"""
        hello(
          """Name to greet"""
          name: String
        ): String
      }
    `);

    await generateSchemaFile(schema, { path: testFilePath });

    const content = await readFile(testFilePath, 'utf-8');

    expect(content).toContain('A greeting type');
    expect(content).toContain('Says hello');
    expect(content).toContain('Name to greet');
  });

  test('should strip descriptions when includeDescriptions is false', async () => {
    const schema = buildSchema(`
      """A greeting type"""
      type Query {
        """Says hello"""
        hello(
          """Name to greet"""
          name: String
        ): String
      }
    `);

    await generateSchemaFile(schema, {
      path: testFilePath,
      includeDescriptions: false,
    });

    const content = await readFile(testFilePath, 'utf-8');

    expect(content).not.toContain('A greeting type');
    expect(content).not.toContain('Says hello');
    expect(content).not.toContain('Name to greet');
    // The schema itself must still be intact
    expect(content).toContain('type Query');
    expect(content).toContain('hello');
    expect(content).toContain('name: String');
  });

  test('should create missing parent directories for nested paths', async () => {
    const nestedPath = join(nestedRoot, 'deeply', 'nested', 'schema.graphql');
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          hello: { type: GraphQLString },
        },
      }),
    });

    await generateSchemaFile(schema, { path: nestedPath });

    const content = await readFile(nestedPath, 'utf-8');
    expect(content).toContain('type Query');
  });
});

describe('Resolver Metadata', () => {
  beforeEach(() => {
    clearResolverMetadata();
  });

  test('should register metadata', () => {
    const metadata: ResolverMetadata = {
      type: 'Query',
      name: 'hello',
      returnType: String,
      target: class TestResolver {},
      methodName: 'hello',
    };

    registerResolverMetadata(metadata);

    expect(getResolverMetadata()).toHaveLength(1);
    expect(getResolverMetadata()[0]).toEqual(metadata);
  });

  test('should register multiple metadata entries', () => {
    const metadata1: ResolverMetadata = {
      type: 'Query',
      name: 'hello',
      returnType: String,
      target: class TestResolver {},
      methodName: 'hello',
    };

    const metadata2: ResolverMetadata = {
      type: 'Mutation',
      name: 'updateHello',
      returnType: String,
      target: class TestResolver {},
      methodName: 'updateHello',
    };

    registerResolverMetadata(metadata1);
    registerResolverMetadata(metadata2);

    expect(getResolverMetadata()).toHaveLength(2);
  });

  test('should clear metadata', () => {
    const metadata: ResolverMetadata = {
      type: 'Query',
      name: 'hello',
      returnType: String,
      target: class TestResolver {},
      methodName: 'hello',
    };

    registerResolverMetadata(metadata);
    expect(getResolverMetadata()).toHaveLength(1);

    clearResolverMetadata();
    expect(getResolverMetadata()).toHaveLength(0);
  });

  test('should return a copy of metadata', () => {
    const metadata: ResolverMetadata = {
      type: 'Query',
      name: 'hello',
      returnType: String,
      target: class TestResolver {},
      methodName: 'hello',
    };

    registerResolverMetadata(metadata);

    const result = getResolverMetadata();
    result.push(metadata);

    // Original should not be modified
    expect(getResolverMetadata()).toHaveLength(1);
  });
});
