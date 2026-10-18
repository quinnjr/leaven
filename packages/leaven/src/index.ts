/**
 * Leaven - A high-performance GraphQL library for the Bun runtime
 *
 * Meta-package that re-exports the Leaven runtime modules — core, http, ws,
 * sse, context, errors, plugins, and playground — plus selected schema-building
 * helpers from `@leaven-graphql/schema`. The NestJS integration is not
 * included here; it ships separately as `@leaven-graphql/nestjs`.
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { createServer } from '@leaven-graphql/http';

// Re-export the runtime packages for convenience
// Core exports everything
export * from '@leaven-graphql/core';
// Schema may have duplicates with core, exclude them
export {
  SchemaBuilder,
  createSchemaBuilder,
  mergeSchemas,
  mergeSchemasFromStrings,
  createResolvers,
  mergeResolvers,
  loadSchemaFromFile,
  loadSchemaFromDirectory,
} from '@leaven-graphql/schema';
export * from '@leaven-graphql/http';
export * from '@leaven-graphql/ws';
export * from '@leaven-graphql/sse';
export * from '@leaven-graphql/context';
export * from '@leaven-graphql/errors';
export * from '@leaven-graphql/plugins';
export * from '@leaven-graphql/playground';

// `ContextFactory` is exported by two packages with different shapes:
// `@leaven-graphql/context` builds a context from an input (`<TInput,
// TContext>`), while `@leaven-graphql/http` maps a request to a context
// (`<TContext>`). The star exports above leave the name ambiguous (TS2308), so
// resolve it explicitly — the dedicated context package keeps the bare name.
export type { ContextFactory } from '@leaven-graphql/context';
export type { ContextFactory as HttpContextFactory } from '@leaven-graphql/http';

// Named exports for common usage patterns
export {
  // Core
  LeavenExecutor,
  createExecutor,
  DocumentCache,
  createDocumentCache,
  parseDocument,
  validateDocument,
  compileQuery,
  CompiledQuery,
  OperationRegistry,
  createOperationRegistry,
} from '@leaven-graphql/core';

// Schema exports are already included above

export {
  // HTTP
  createHandler,
  createBunHandler,
  LeavenServer,
  createServer,
} from '@leaven-graphql/http';

export {
  // WebSocket
  WebSocketHandler,
  createWebSocketHandler,
  SubscriptionManager,
  createSubscriptionManager,
  PubSub,
  createPubSub,
} from '@leaven-graphql/ws';

export {
  // SSE
  createEventStream,
  createEventStreamResponse,
  acceptsEventStream,
  formatResultErrors,
} from '@leaven-graphql/sse';

export {
  // Context
  ContextBuilder,
  createContextBuilder,
  ContextStore,
  createContextStore,
  RequestContext,
  createRequestContext,
} from '@leaven-graphql/context';

export {
  // Errors
  LeavenError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  formatError,
  formatErrors,
  ErrorCode,
} from '@leaven-graphql/errors';

export {
  // Plugins
  PluginManager,
  createPluginManager,
  createPlugin,
  composePlugins,
  createCachingPlugin,
  createLoggingPlugin,
  createTracingPlugin,
  createDepthLimitPlugin,
  createComplexityPlugin,
} from '@leaven-graphql/plugins';

export {
  // Playground
  renderPlayground,
  createPlaygroundHandler,
  renderGraphiQL,
  createGraphiQLHandler,
} from '@leaven-graphql/playground';

/**
 * Quick start helper to create a GraphQL server
 */
export function leaven(config: import('@leaven-graphql/http').ServerConfig): import('@leaven-graphql/http').LeavenServer {
  return createServer(config);
}
