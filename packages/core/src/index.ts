/**
 * @leaven-graphql/core - Core GraphQL execution engine for Leaven
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

export { LeavenExecutor, createExecutor } from './executor';
export type { ExecutorConfig, ExecutionResult, ExecutionContext } from './executor';

export {
  DocumentCache,
  createDocumentCache,
  estimateDocumentBytes,
  AST_BYTES_PER_QUERY_CHAR,
  DEFAULT_CACHE_MAX_BYTES,
} from './cache';
export type { DocumentCacheConfig, CacheEntry, CachedValidation, IDocumentCache, CacheStats } from './cache';
export { isPromise, resolveValue } from './cache';

export { RedisDocumentCache, createRedisCache } from './cache-redis';
export type { RedisCacheConfig, RedisClient } from './cache-redis';

export {
  parseDocument,
  validateDocument,
  calculateQueryDepth,
  parseRequest,
  countFields,
  getOperationNames,
  getOperationType,
  createVisitBudget,
  MAX_ANALYSIS_VISITS,
} from './parser';
export type { ParseOptions, ValidationResult } from './parser';

export { compileQuery, CompiledQuery } from './compiler';
export type { CompilerOptions, CompiledField, CompiledFragment } from './compiler';

export { OperationRegistry, createOperationRegistry } from './registry';
export type { OperationRegistryConfig, RegisteredOperation } from './registry';

export { escapeLog, LOG_VALUE_MAX_LENGTH } from './escape-log';

export * from './types';
