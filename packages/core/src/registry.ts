/**
 * @leaven-graphql/core - Operation registry for persisted queries
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { DocumentNode, GraphQLSchema } from 'graphql';
import { parseDocument, validateDocument } from './parser';
import { CompiledQuery, compileQuery, type CompilerOptions } from './compiler';
import type { OperationType } from './types';

/**
 * Configuration for the operation registry
 */
export interface OperationRegistryConfig {
  /** GraphQL schema for validation */
  schema: GraphQLSchema;
  /** Enable automatic query compilation */
  compile?: boolean;
  /** Compiler options */
  compilerOptions?: CompilerOptions;
  /**
   * Policy flag (default: true) that the registry exposes as
   * {@link OperationRegistry.allowUnregistered} for a transport to enforce.
   * The registry itself does not enforce it: it has no execute path, so it
   * never rejects an unregistered operation. No Leaven transport reads it
   * either; enforce it in your own request handling (for example, look the
   * operation up before calling `execute`).
   */
  allowUnregistered?: boolean;
}

/**
 * A registered GraphQL operation
 */
export interface RegisteredOperation {
  /** Unique operation ID */
  id: string;
  /** Operation name */
  name: string | null;
  /** The query string */
  query: string;
  /** Parsed document */
  document: DocumentNode;
  /** Compiled query (if compilation is enabled) */
  compiled?: CompiledQuery;
  /** Operation type */
  operationType: OperationType;
  /** When this operation was registered */
  registeredAt: number;
  /** Hash of the query for integrity */
  hash: string;
}

/**
 * Registry for persisted/approved GraphQL operations
 */
export class OperationRegistry {
  /** Minimum prefix length accepted by {@link findByHashPrefix}. */
  private static readonly MIN_HASH_PREFIX_LENGTH = 8;

  private readonly operations: Map<string, RegisteredOperation>;
  /** Exact-match index from query hash to operation for O(1) lookups. */
  private readonly hashIndex: Map<string, RegisteredOperation>;
  private readonly schema: GraphQLSchema;
  private readonly shouldCompile: boolean;
  private readonly compilerOptions?: CompilerOptions;
  /**
   * Policy flag for your own request handling to enforce; neither the
   * registry nor any Leaven transport does.
   */
  public readonly allowUnregistered: boolean;

  constructor(config: OperationRegistryConfig) {
    this.operations = new Map();
    this.hashIndex = new Map();
    this.schema = config.schema;
    this.shouldCompile = config.compile ?? false;
    this.compilerOptions = config.compilerOptions;
    this.allowUnregistered = config.allowUnregistered ?? true;
  }

  /**
   * Generate a hash for a query
   */
  private generateHash(query: string): string {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(query);
    return hasher.digest('hex');
  }

  /**
   * Register a new operation
   */
  public register(
    query: string,
    options?: { id?: string; name?: string }
  ): RegisteredOperation {
    const hash = this.generateHash(query);
    const id = options?.id ?? hash.slice(0, 16);

    // Check if already registered
    if (this.operations.has(id)) {
      const existing = this.operations.get(id)!;
      if (existing.hash === hash) {
        return existing;
      }
      throw new Error(`Operation ID "${id}" already registered with different query`);
    }

    // Parse the document
    const document = parseDocument(query);

    // Validate against schema
    const validation = validateDocument(this.schema, document);
    if (!validation.valid) {
      const errorMessages = validation.errors.map((e) => e.message).join(', ');
      throw new Error(`Invalid operation: ${errorMessages}`);
    }

    // Get operation info
    const opDef = document.definitions.find(
      (d) => d.kind === 'OperationDefinition'
    ) as { operation: OperationType; name?: { value: string } } | undefined;

    if (!opDef) {
      throw new Error('No operation definition found in document');
    }

    // Compile if enabled
    let compiled: CompiledQuery | undefined;
    if (this.shouldCompile) {
      compiled = compileQuery(
        this.schema,
        document,
        options?.name ?? opDef.name?.value,
        this.compilerOptions
      );
    }

    const operation: RegisteredOperation = {
      id,
      name: options?.name ?? opDef.name?.value ?? null,
      query,
      document,
      compiled,
      operationType: opDef.operation,
      registeredAt: Date.now(),
      hash,
    };

    this.operations.set(id, operation);
    this.hashIndex.set(hash, operation);
    return operation;
  }

  /**
   * Register multiple operations at once
   */
  public registerAll(
    operations: Array<{ query: string; id?: string; name?: string }>
  ): RegisteredOperation[] {
    return operations.map((op) => this.register(op.query, { id: op.id, name: op.name }));
  }

  /**
   * Get an operation by ID
   */
  public get(id: string): RegisteredOperation | null {
    return this.operations.get(id) ?? null;
  }

  /**
   * Get an operation by its full query hash.
   *
   * Performs an exact match only — partial hashes and empty strings return
   * `null`. Use {@link findByHashPrefix} for explicit prefix lookups.
   */
  public getByHash(hash: string): RegisteredOperation | null {
    return this.hashIndex.get(hash) ?? null;
  }

  /**
   * Find an operation by a prefix of its query hash.
   *
   * Intended for tooling/diagnostics, not as a lookup path for executing
   * operations — use {@link getByHash} with the full hash for that.
   *
   * @param prefix - Hash prefix, at least 8 characters long.
   * @returns The single matching operation, or `null` when no operation
   *   matches or the prefix is ambiguous (matches more than one operation).
   * @throws Error when `prefix` is shorter than 8 characters.
   */
  public findByHashPrefix(prefix: string): RegisteredOperation | null {
    if (prefix.length < OperationRegistry.MIN_HASH_PREFIX_LENGTH) {
      throw new Error(
        `Hash prefix must be at least ${OperationRegistry.MIN_HASH_PREFIX_LENGTH} characters, got ${prefix.length}`
      );
    }

    let match: RegisteredOperation | null = null;
    for (const op of this.operations.values()) {
      if (op.hash.startsWith(prefix)) {
        if (match !== null) {
          // Ambiguous prefix: more than one operation matches.
          return null;
        }
        match = op;
      }
    }
    return match;
  }

  /**
   * Check if an operation is registered
   */
  public has(id: string): boolean {
    return this.operations.has(id);
  }

  /**
   * Check if a query hash is registered.
   *
   * Exact match only — partial hashes and empty strings return `false`.
   */
  public hasHash(hash: string): boolean {
    return this.hashIndex.has(hash);
  }

  /**
   * Unregister an operation
   */
  public unregister(id: string): boolean {
    const operation = this.operations.get(id);
    if (!operation) {
      return false;
    }

    this.operations.delete(id);

    // Keep the hash index in sync. Another operation may share the same
    // hash (same query registered under a different ID), so re-index it.
    if (this.hashIndex.get(operation.hash) === operation) {
      this.hashIndex.delete(operation.hash);
      for (const op of this.operations.values()) {
        if (op.hash === operation.hash) {
          this.hashIndex.set(op.hash, op);
          break;
        }
      }
    }

    return true;
  }

  /**
   * Clear all registered operations
   */
  public clear(): void {
    this.operations.clear();
    this.hashIndex.clear();
  }

  /**
   * Get the number of registered operations
   */
  public get size(): number {
    return this.operations.size;
  }

  /**
   * Get all registered operations
   */
  public getAll(): RegisteredOperation[] {
    return Array.from(this.operations.values());
  }

  /**
   * Get operations by type
   */
  public getByType(type: OperationType): RegisteredOperation[] {
    return this.getAll().filter((op) => op.operationType === type);
  }

  /**
   * Export the registry as a JSON-serializable object
   */
  public export(): Record<string, { query: string; name: string | null; type: OperationType }> {
    const exported: Record<string, { query: string; name: string | null; type: OperationType }> = {};

    for (const [id, op] of this.operations) {
      exported[id] = {
        query: op.query,
        name: op.name,
        type: op.operationType,
      };
    }

    return exported;
  }

  /**
   * Import operations from a serialized registry.
   *
   * Entries that fail to register (parse errors, schema validation
   * failures, ID conflicts) are skipped. Pass `onError` to observe each
   * failure — without it, failures are silently dropped and only the
   * returned count reflects them.
   *
   * @param data - Serialized registry, as produced by {@link export}.
   * @param onError - Optional callback invoked for each entry that fails
   *   to import, receiving the entry (including its `id`) and the error.
   * @returns The number of operations successfully imported.
   */
  public import(
    data: Record<string, { query: string; name?: string | null; type?: OperationType }>,
    onError?: (
      entry: { id: string; query: string; name?: string | null; type?: OperationType },
      error: Error
    ) => void
  ): number {
    let imported = 0;

    for (const [id, op] of Object.entries(data)) {
      try {
        this.register(op.query, { id, name: op.name ?? undefined });
        imported++;
      } catch (error) {
        // Skip invalid operations, surfacing the failure if requested
        onError?.(
          { id, ...op },
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    return imported;
  }
}

/**
 * Create a new operation registry
 */
export function createOperationRegistry(
  config: OperationRegistryConfig
): OperationRegistry {
  return new OperationRegistry(config);
}
