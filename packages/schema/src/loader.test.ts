/**
 * @leaven-graphql/schema - Loader tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphQLObjectType } from 'graphql';
import {
  loadSchemaFromFile,
  loadTypeDefsFromFile,
  loadSchemaFromDirectory,
  loadTypeDefsFromDirectory,
  loadSchemaFromGlob,
  loadTypeDefsFromGlob,
} from './loader';

let root: string | undefined;
let schemasDir: string;
let orderedDir: string;
let emptyDir: string;
let customRootDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'leaven-loader-'));
  schemasDir = join(root, 'schemas');
  orderedDir = join(root, 'ordered');
  emptyDir = join(root, 'empty');
  customRootDir = join(root, 'custom-root');

  await Bun.write(join(root, 'single.graphql'), 'type Query { hello: String }');

  await Bun.write(join(schemasDir, 'base.graphql'), 'type Query { a: String }');
  await Bun.write(
    join(schemasDir, 'extra.gql'),
    'extend type Query { b: String }'
  );
  await Bun.write(join(schemasDir, 'notes.txt'), 'not a schema');
  await Bun.write(
    join(schemasDir, 'nested', 'user.graphql'),
    'type User { name: String }'
  );

  // Written in reverse alphabetical order to prove results are sorted by path
  await Bun.write(join(orderedDir, 'zz.graphql'), 'type Zz { x: String }');
  await Bun.write(join(orderedDir, 'aa.graphql'), 'type Aa { x: String }');

  await mkdir(emptyDir, { recursive: true });

  await Bun.write(
    join(customRootDir, 'a-schema.graphql'),
    'schema { query: RootQuery }'
  );
  await Bun.write(
    join(customRootDir, 'b-root.graphql'),
    'type RootQuery { a: String }'
  );
});

afterAll(async () => {
  // `root` stays undefined if mkdtemp itself failed; calling rm(undefined)
  // would throw here and mask the real beforeAll error.
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('loadSchemaFromFile', () => {
  test('should load a schema from a file', async () => {
    const schema = await loadSchemaFromFile(join(root!, 'single.graphql'));
    expect(schema.getQueryType()?.getFields().hello).toBeDefined();
  });

  test('should throw a friendly error for a missing file', async () => {
    await expect(
      loadSchemaFromFile(join(root!, 'missing.graphql'))
    ).rejects.toThrow('Schema file not found');
  });
});

describe('loadTypeDefsFromFile', () => {
  test('should return raw file contents', async () => {
    const typeDefs = await loadTypeDefsFromFile(join(root!, 'single.graphql'));
    expect(typeDefs).toBe('type Query { hello: String }');
  });

  test('should throw a friendly error for a missing file', async () => {
    await expect(
      loadTypeDefsFromFile(join(root!, 'missing.graphql'))
    ).rejects.toThrow('Schema file not found');
  });
});

describe('loadSchemaFromDirectory', () => {
  test('should merge files that each declare part of Query', async () => {
    const schema = await loadSchemaFromDirectory(schemasDir);

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeDefined();
    expect(fields?.b).toBeDefined();
  });

  test('should not descend into subdirectories by default', async () => {
    const schema = await loadSchemaFromDirectory(schemasDir);
    expect(schema.getType('User')).toBeUndefined();
  });

  test('should descend into subdirectories when recursive', async () => {
    const schema = await loadSchemaFromDirectory(schemasDir, {
      recursive: true,
    });

    const user = schema.getType('User') as GraphQLObjectType;
    expect(user).toBeDefined();
    expect(user.getFields().name).toBeDefined();
  });

  test('should throw when the directory has no schema files', async () => {
    await expect(loadSchemaFromDirectory(emptyDir)).rejects.toThrow(
      'No schema files found in directory'
    );
  });
});

describe('loadTypeDefsFromDirectory', () => {
  test('should only load files with the configured extensions', async () => {
    const typeDefs = await loadTypeDefsFromDirectory(schemasDir, {
      extensions: ['.graphql'],
    });

    expect(typeDefs).toEqual(['type Query { a: String }']);
  });

  test('should return contents in sorted path order', async () => {
    const typeDefs = await loadTypeDefsFromDirectory(orderedDir);

    expect(typeDefs).toEqual([
      'type Aa { x: String }',
      'type Zz { x: String }',
    ]);
  });
});

describe('loadSchemaFromGlob', () => {
  test('should load schemas matching the pattern', async () => {
    const schema = await loadSchemaFromGlob('*.graphql', { cwd: schemasDir });

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeDefined();
    expect(fields?.b).toBeUndefined();
  });

  test('should merge all matches of a recursive pattern', async () => {
    const schema = await loadSchemaFromGlob('**/*.{graphql,gql}', {
      cwd: schemasDir,
    });

    const fields = schema.getQueryType()?.getFields();
    expect(fields?.a).toBeDefined();
    expect(fields?.b).toBeDefined();
    expect(schema.getType('User')).toBeDefined();
  });
});

describe('loadTypeDefsFromGlob', () => {
  test('should return contents in sorted path order', async () => {
    const typeDefs = await loadTypeDefsFromGlob('*.graphql', {
      cwd: orderedDir,
    });

    expect(typeDefs).toEqual([
      'type Aa { x: String }',
      'type Zz { x: String }',
    ]);
  });

  test('should throw when nothing matches', async () => {
    await expect(
      loadTypeDefsFromGlob('*.nope', { cwd: emptyDir })
    ).rejects.toThrow('No files found matching pattern');
  });
});

describe('custom root operation types', () => {
  test('should keep a schema definition from another file (loadSchemaFromDirectory)', async () => {
    const schema = await loadSchemaFromDirectory(customRootDir);

    expect(schema.getQueryType()?.name).toBe('RootQuery');
    expect(schema.getQueryType()?.getFields().a).toBeDefined();
  });

  test('should keep a schema definition from another file (loadSchemaFromGlob)', async () => {
    const schema = await loadSchemaFromGlob('*.graphql', { cwd: customRootDir });

    expect(schema.getQueryType()?.name).toBe('RootQuery');
    expect(schema.getQueryType()?.getFields().a).toBeDefined();
  });
});
