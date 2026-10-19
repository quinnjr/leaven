/**
 * @leaven-graphql/core - Type definitions
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type {
  GraphQLSchema,
  DocumentNode,
  GraphQLError,
  GraphQLFormattedError,
  OperationDefinitionNode,
} from 'graphql';

/**
 * Variables passed to GraphQL operations
 */
export type Variables = Record<string, unknown>;

/**
 * GraphQL operation type
 */
export type OperationType = 'query' | 'mutation' | 'subscription';

/**
 * Request information for GraphQL operations
 */
export interface GraphQLRequest {
  /** The GraphQL query string */
  query: string;
  /** Operation name to execute (for documents with multiple operations) */
  operationName?: string;
  /** Variables for the operation */
  variables?: Variables;
  /** Extensions passed by the client */
  extensions?: Record<string, unknown>;
}

/**
 * Parsed GraphQL request with document node
 */
export interface ParsedRequest extends GraphQLRequest {
  /** Parsed document node */
  document: DocumentNode;
  /** The specific operation to execute */
  operation: OperationDefinitionNode;
  /** Type of operation */
  operationType: OperationType;
}

/**
 * GraphQL response following the spec
 */
export interface GraphQLResponse<TData = Record<string, unknown>> {
  /** Data returned by the operation */
  data?: TData | null;
  /** Errors that occurred during execution */
  errors?: readonly GraphQLFormattedError[];
  /** Extensions for additional metadata */
  extensions?: Record<string, unknown>;
}

/**
 * Async iterator for subscriptions
 */
export type SubscriptionIterator<TData = Record<string, unknown>> = AsyncIterableIterator<
  GraphQLResponse<TData>
>;

/**
 * Result of a GraphQL execution - can be a response or a subscription iterator
 */
export type ExecuteResult<TData = Record<string, unknown>> =
  | GraphQLResponse<TData>
  | SubscriptionIterator<TData>;

/**
 * Schema configuration options
 */
export interface SchemaConfig {
  /** The GraphQL schema */
  schema: GraphQLSchema;
  /** Enable introspection (default: true in development) */
  introspection?: boolean;
}

/**
 * Resolver function signature
 */
export type ResolverFn<
  TResult = unknown,
  TParent = unknown,
  TContext = unknown,
  TArgs = Record<string, unknown>,
> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: ResolverInfo,
) => TResult | Promise<TResult>;

/**
 * Resolver info passed to resolver functions
 */
export interface ResolverInfo {
  /** Field name being resolved */
  fieldName: string;
  /** Return type of the field */
  returnType: string;
  /** Parent type name */
  parentType: string;
  /** Path to this field in the query */
  path: readonly (string | number)[];
  /** The original graphql-js info object */
  graphqlInfo: unknown;
}

/**
 * Resolver map for a type
 */
export type ResolverMap<TContext = unknown> = Record<
  string,
  Record<string, ResolverFn<unknown, unknown, TContext, Record<string, unknown>>>
>;

/**
 * Field resolver result
 */
export interface FieldResult<T = unknown> {
  /** The resolved value */
  value: T;
  /** Any errors that occurred */
  errors?: readonly GraphQLError[];
}

/**
 * Execution timing information
 */
export interface ExecutionTiming {
  /** Time to parse the query (ms) */
  parseTime?: number;
  /** Time to validate the query (ms) */
  validationTime?: number;
  /** Time to execute the query (ms) */
  executionTime?: number;
  /** Total time (ms) */
  totalTime: number;
}

/**
 * Detailed execution metrics
 */
export interface ExecutionMetrics {
  /** Timing information */
  timing: ExecutionTiming;
  /** Whether the document was cached */
  documentCached: boolean;
  /** Whether validation was cached */
  validationCached?: boolean;
  /** Whether the compiled query was cached */
  queryCached: boolean;
  /**
   * Number of resolvers invoked.
   * Not currently tracked by the executor, which omits this field rather
   * than reporting an inaccurate count.
   */
  resolverCount?: number;
  /** Complexity score of the query */
  complexity?: number;
}

/**
 * Life cycle hooks for execution
 */
export interface ExecutionHooks<TContext = unknown> {
  /** Called before parsing */
  onParse?: (query: string) => void | Promise<void>;
  /** Called after parsing */
  onParsed?: (document: DocumentNode) => void | Promise<void>;
  /**
   * Called before validation. Skipped when the validation result comes from
   * the cache (a validation cache hit); {@link ExecutionHooks.onValidated}
   * still fires in that case.
   */
  onValidate?: (document: DocumentNode) => void | Promise<void>;
  /** Called after validation */
  onValidated?: (result: { valid: boolean; errors?: readonly GraphQLError[] }) => void | Promise<void>;
  /** Called before execution */
  onExecute?: (context: TContext, document: DocumentNode) => void | Promise<void>;
  /** Called after execution */
  onExecuted?: (result: GraphQLResponse) => void | Promise<void>;
  /**
   * Called when the operation itself fails: a parse error, a depth/token/
   * complexity-analysis rejection, or anything thrown by an earlier hook.
   *
   * NOT called for resolver-level errors. Those are collected by graphql-js
   * into `ExecutionResult.errors` and returned as a normal (partial-data)
   * response, so the request never reaches the executor's catch path. Inspect
   * `result.errors` in `onExecuted` to observe them.
   */
  onError?: (error: Error) => void | Promise<void>;
  /**
   * Called when a cache read or a background cache write fails. A failed read
   * is treated as a cache miss. Cache failures never fail the request; this
   * hook provides observability.
   */
  onCacheError?: (error: Error) => void | Promise<void>;
}
