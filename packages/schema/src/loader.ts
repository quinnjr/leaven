/**
 * @leaven-graphql/schema - Schema file loading utilities
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { buildSchema, type GraphQLSchema } from 'graphql';
import { Glob } from 'bun';
import { join } from 'node:path';

import { mergeSchemasFromStrings, type MergeOptions } from './merge';

/**
 * Options for schema loading.
 *
 * `extensions` and `recursive` are honoured only by the directory loaders.
 * The glob loaders ignore both: the pattern alone decides which files match
 * and whether subdirectories are searched.
 */
export interface LoaderOptions {
  /**
   * File extensions to load (default: ['.graphql', '.gql']). Directory
   * loaders only; ignored by the glob loaders.
   */
  extensions?: string[];
  /**
   * Has no effect — files are always read as UTF-8.
   *
   * @deprecated Removed in 0.3.0. Files are always read as UTF-8; this option
   * is ignored until then.
   */
  encoding?: BufferEncoding;
  /**
   * Whether to recursively search directories. Directory loaders only;
   * ignored by the glob loaders — use `**` in the pattern instead.
   */
  recursive?: boolean;
}

/**
 * Read a file as UTF-8 text, raising a friendly error when it does not exist
 */
async function readFileText(filePath: string): Promise<string> {
  try {
    return await Bun.file(filePath).text();
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new Error(`Schema file not found: ${filePath}`);
    }
    throw error;
  }
}

/**
 * Load a GraphQL schema from a file.
 *
 * The entire options bag is ignored — not just {@link LoaderOptions.encoding}.
 * It is accepted only so this loader keeps the same call signature as the
 * directory and glob loaders.
 *
 * @param filePath - Path to the schema file
 * @param _options - Accepted for signature compatibility with the other
 *   loaders; ignored in full. Files are always read as UTF-8, `extensions`
 *   is meaningless for an explicit path, and no directory traversal takes
 *   place for a single file.
 */
export async function loadSchemaFromFile(
  filePath: string,
  _options?: LoaderOptions
): Promise<GraphQLSchema> {
  const content = await readFileText(filePath);
  return buildSchema(content);
}

/**
 * Load GraphQL type definitions from a file
 */
export async function loadTypeDefsFromFile(
  filePath: string
): Promise<string> {
  return readFileText(filePath);
}

/**
 * Load and merge GraphQL schemas from a directory.
 *
 * Files are read in sorted path order and merged with
 * {@link mergeSchemasFromStrings}, so `extend type` definitions spread across
 * files are combined and duplicate type definitions follow the
 * {@link MergeOptions.onTypeConflict} policy.
 */
export async function loadSchemaFromDirectory(
  directoryPath: string,
  options?: LoaderOptions & MergeOptions
): Promise<GraphQLSchema> {
  const typeDefs = await loadTypeDefsFromDirectory(directoryPath, options);
  return mergeSchemasFromStrings(typeDefs, undefined, options);
}

/**
 * Load type definitions from a directory.
 *
 * Returns file contents in sorted path order so results are reproducible
 * across filesystems.
 */
export async function loadTypeDefsFromDirectory(
  directoryPath: string,
  options?: LoaderOptions
): Promise<string[]> {
  const extensions = options?.extensions ?? ['.graphql', '.gql'];
  const suffixes = extensions.map((ext) =>
    ext.startsWith('.') ? ext.slice(1) : ext
  );
  const extensionPattern =
    suffixes.length === 1 ? suffixes[0]! : `{${suffixes.join(',')}}`;
  const pattern = options?.recursive
    ? `**/*.${extensionPattern}`
    : `*.${extensionPattern}`;

  const glob = new Glob(pattern);
  const paths: string[] = [];

  for await (const entry of glob.scan({ cwd: directoryPath })) {
    paths.push(entry);
  }

  if (paths.length === 0) {
    throw new Error(`No schema files found in directory: ${directoryPath}`);
  }

  paths.sort();

  return Promise.all(
    paths.map((entry) => Bun.file(join(directoryPath, entry)).text())
  );
}

/**
 * Load and merge GraphQL schemas matching a glob pattern.
 *
 * Files are read in sorted path order and merged with
 * {@link mergeSchemasFromStrings}, so `extend type` definitions spread across
 * files are combined and duplicate type definitions follow the
 * {@link MergeOptions.onTypeConflict} policy.
 *
 * Of the {@link LoaderOptions}, `extensions` and `recursive` are ignored: the
 * pattern alone decides which files match. Only `cwd` and the merge options
 * take effect.
 */
export async function loadSchemaFromGlob(
  pattern: string,
  options?: LoaderOptions & MergeOptions & { cwd?: string }
): Promise<GraphQLSchema> {
  const typeDefs = await loadTypeDefsFromGlob(pattern, options);
  return mergeSchemasFromStrings(typeDefs, undefined, options);
}

/**
 * Load type definitions matching a glob pattern.
 *
 * Returns file contents in sorted path order so results are reproducible
 * across filesystems.
 *
 * Of the {@link LoaderOptions}, `extensions` and `recursive` are ignored: the
 * pattern alone decides which files match. Only `cwd` takes effect.
 */
export async function loadTypeDefsFromGlob(
  pattern: string,
  options?: LoaderOptions & { cwd?: string }
): Promise<string[]> {
  const glob = new Glob(pattern);
  const cwd = options?.cwd ?? process.cwd();

  const paths: string[] = [];

  for await (const entry of glob.scan({ cwd })) {
    paths.push(entry);
  }

  if (paths.length === 0) {
    throw new Error(`No files found matching pattern: ${pattern}`);
  }

  paths.sort();

  return Promise.all(paths.map((entry) => Bun.file(join(cwd, entry)).text()));
}
