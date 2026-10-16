/**
 * @leaven-graphql/nestjs - Type definitions
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { Type } from '@nestjs/common';
import type { ModuleMetadata } from '@nestjs/common/interfaces';
import type { GraphQLSchema, DocumentNode } from 'graphql';
import type { DocumentCacheConfig, ParseOptions } from '@leaven-graphql/core';
import type { PubSub } from '@leaven-graphql/ws';
import type { SubscriptionConfig } from './subscriptions';

/**
 * Injection token for the Leaven module options.
 *
 * Defined in this file (which has no runtime imports) rather than in
 * `module.ts` so that the services registered by `LeavenModule` — which
 * inject this token — can be imported by `module.ts` without creating a
 * circular runtime dependency. The token is re-exported from `./module`
 * so existing `import { LEAVEN_MODULE_OPTIONS } from './module'` sites
 * keep working.
 */
export const LEAVEN_MODULE_OPTIONS = 'LEAVEN_MODULE_OPTIONS';

/**
 * Injection token for the Leaven driver.
 *
 * See {@link LEAVEN_MODULE_OPTIONS} for why this constant lives here and is
 * re-exported from `./module`.
 */
export const LEAVEN_DRIVER = 'LEAVEN_DRIVER';

/**
 * Injection token for the module's shared {@link PubSub} instance, resolved
 * by `@InjectPubSub()`.
 *
 * See {@link LEAVEN_MODULE_OPTIONS} for why this constant lives here and is
 * re-exported from `./module`.
 */
export const LEAVEN_PUBSUB = 'LEAVEN_PUBSUB';

/**
 * Configuration options for the Leaven GraphQL module
 */
export interface LeavenModuleOptions {
  /**
   * Path for the GraphQL endpoint
   * @default '/graphql'
   */
  path?: string;

  /**
   * Pre-built GraphQL schema (schema-first approach)
   */
  schema?: GraphQLSchema;

  /**
   * Type definitions for schema-first approach
   */
  typeDefs?: string | DocumentNode | Array<string | DocumentNode>;

  /**
   * Resolvers for schema-first approach
   */
  resolvers?: Record<string, unknown> | Array<Record<string, unknown>>;

  /**
   * Enable auto-schema generation (code-first approach)
   *
   * @remarks Not implemented. Leaven has no code-first pipeline, so setting
   * this without also supplying `schema` or `typeDefs` makes
   * `SchemaBuilderService` throw at bootstrap rather than start a server
   * that fails every request. Unset by default, which is why
   * `forRoot({})` boots (with no schema) instead of throwing.
   */
  autoSchemaFile?: boolean | string;

  /**
   * Sort schema alphabetically
   *
   * @deprecated Has no effect; removal target 0.3.0. Sort the emitted SDL
   * instead by passing `sortSchema` to `generateSchemaFile`.
   * @default false
   */
  sortSchema?: boolean;

  /**
   * Build schema options for code-first
   *
   * @deprecated Has no effect; removal target 0.3.0. The code-first pipeline
   * these options describe is not implemented.
   */
  buildSchemaOptions?: BuildSchemaOptions;

  /**
   * Plugins to use
   *
   * @deprecated Has no effect; removal target 0.3.0. No plugin host reads
   * this option.
   */
  plugins?: LeavenPlugin[];

  /**
   * Enable GraphQL Playground
   * @default true in development
   */
  playground?: boolean;

  /**
   * Enable introspection
   * @default true in development
   */
  introspection?: boolean;

  /**
   * Document cache configuration
   */
  cache?: DocumentCacheConfig | boolean;

  /**
   * Maximum query complexity allowed
   */
  maxComplexity?: number;

  /**
   * Maximum query depth allowed
   */
  maxDepth?: number;

  /**
   * Parser limits, in the same shape as the core executor's `parseOptions`.
   *
   * Applied everywhere the module parses a document: the executor (HTTP and
   * subscription transports alike), query analysis for the complexity/depth
   * guards, and the subscription transport's synchronous operation-type
   * detection. A document over a limit is rejected through the executor's
   * normal error response.
   *
   * `maxTokens` defaults to 10000; set it to `Infinity` to opt out.
   * `maxDepth` here is overridden by the top-level `maxDepth` when both are set.
   */
  parseOptions?: ParseOptions;

  /**
   * Enable execution metrics
   * @default false
   */
  metrics?: boolean;

  /**
   * Enable debug mode.
   *
   * @deprecated Not implemented; setting it has no effect. Accepted only so
   * existing configurations keep compiling.
   * @default false
   */
  debug?: boolean;

  /**
   * Context factory function
   */
  context?: ContextFactory;

  /**
   * Format error function
   */
  formatError?: FormatErrorFn;

  /**
   * GraphQL-over-WebSocket subscription configuration.
   *
   * Consumed by the `SubscriptionManager` registered by `LeavenModule` to
   * control connection lifecycle hooks (`onConnect`, `onDisconnect`,
   * `onSubscribe`, `onOperation`, `onComplete`), the per-connection context
   * factory, keep-alive behavior, the connection-init timeout, and the
   * maximum number of subscriptions per connection.
   */
  subscriptions?: SubscriptionConfig;

  /**
   * PubSub instance shared by the module and resolved by `@InjectPubSub()`.
   *
   * Defaults to a per-module in-memory instance. Supply your own to share
   * one across modules, or to use a distributed engine so that events
   * published on one server instance reach subscribers on another.
   */
  pubSub?: PubSub;

  /**
   * Canonical origin (scheme + authority, e.g. `https://api.example.com`)
   * used to build `request.url` for the context factory.
   *
   * The `Host` header is client-controlled, so it is not trusted to form that
   * URL. When this is unset, a syntactically valid `Host` is used and anything
   * else falls back to the default.
   *
   * @default 'http://localhost'
   */
  publicUrl?: string;

  /**
   * Enable CORS handling on the GraphQL endpoint.
   *
   * Opt-in. While this is unset `GraphQLMiddleware` emits no `Access-Control-*`
   * headers at all and delegates `OPTIONS` preflights to the next handler, so
   * a stock `LeavenModule.forRoot({ schema })` never answers with a wildcard
   * origin. `true` (or an options object that omits `origin`) enables the
   * permissive `Access-Control-Allow-Origin: *`; supply `origin` to narrow it.
   * `false` is equivalent to leaving it unset.
   *
   * @default undefined — no CORS headers are emitted
   */
  cors?: boolean | CorsOptions;

  /**
   * Include stack traces in errors.
   *
   * This is honored in **every** environment, not just development: enabling
   * it also suppresses the production masking that otherwise replaces an
   * unexpected error's message with a generic one (a masked error carries no
   * stack to include, so masking and this option are mutually exclusive).
   * Leave it off in production unless you intend to expose internals.
   *
   * @default false
   */
  includeStacktraceInErrorResponses?: boolean;
}

/**
 * Async configuration via a factory function.
 */
export interface LeavenModuleFactoryAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Factory function producing the module options
   */
  useFactory: (
    ...args: unknown[]
  ) => Promise<LeavenModuleOptions> | LeavenModuleOptions;

  /**
   * Injection tokens for factory
   */
  inject?: unknown[];

  useClass?: never;
  useExisting?: never;
}

/**
 * Async configuration via a class implementing {@link LeavenOptionsFactory},
 * instantiated by the module.
 */
export interface LeavenModuleClassAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Class to instantiate
   */
  useClass: Type<LeavenOptionsFactory>;

  useFactory?: never;
  useExisting?: never;

  /**
   * Ignored for the `useClass` form — the factory class is instantiated by
   * Nest and receives its own constructor injections. Accepted so that
   * configurations carrying an `inject` array keep compiling.
   */
  inject?: unknown[];
}

/**
 * Async configuration via an existing provider implementing
 * {@link LeavenOptionsFactory}.
 */
export interface LeavenModuleExistingAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Existing provider to use
   */
  useExisting: Type<LeavenOptionsFactory>;

  useFactory?: never;
  useClass?: never;

  /**
   * Ignored for the `useExisting` form — the referenced provider is resolved
   * from the container with its own injections. Accepted so that
   * configurations carrying an `inject` array keep compiling.
   */
  inject?: unknown[];
}

/**
 * Options for async module configuration.
 *
 * Exactly one of `useFactory`, `useClass`, or `useExisting` must be
 * supplied; `LeavenModule.forRootAsync` throws otherwise.
 */
export type LeavenModuleAsyncOptions =
  | LeavenModuleFactoryAsyncOptions
  | LeavenModuleClassAsyncOptions
  | LeavenModuleExistingAsyncOptions;

/**
 * Factory interface for creating Leaven options
 */
export interface LeavenOptionsFactory {
  createLeavenOptions(): Promise<LeavenModuleOptions> | LeavenModuleOptions;
}

/**
 * Build schema options for the code-first approach.
 *
 * @deprecated Has no effect; removal target 0.3.0. Leaven has no code-first
 * schema pipeline, so nothing reads these options.
 */
export interface BuildSchemaOptions {
  /**
   * Date scalar mode
   */
  dateScalarMode?: 'isoDate' | 'timestamp';

  /**
   * Number scalar mode
   */
  numberScalarMode?: 'integer' | 'float';

  /**
   * Skip check for resolvers
   */
  skipCheck?: boolean;

  /**
   * Orphaned types to include
   */
  orphanedTypes?: Type[];

  /**
   * Directives to include
   */
  directives?: DirectiveDefinition[];
}

/**
 * Directive definition
 */
export interface DirectiveDefinition {
  name: string;
  locations: string[];
  args?: Record<string, unknown>;
}

/**
 * Context factory function type.
 *
 * `request` is a Fetch API `Request` under both entry points — `GraphQLMiddleware`
 * adapts the Express request into one specifically so this signature holds — so
 * `request.headers.get()`, `await request.json()`, and `request.url` are always
 * available.
 *
 * `response` is NOT adapted. It is whatever the transport handed the entry
 * point: a Fetch `Response` via `LeavenDriver.handleRequest`, the **Express**
 * response via `GraphQLMiddleware` (where `status` is a method, not a number,
 * and headers are written with `setHeader(name, value)`). Prefer returning
 * values on the context over writing to `response` if the factory has to work
 * behind both.
 */
export type ContextFactory<TContext = Record<string, unknown>> = (
  request: Request,
  response: Response
) => TContext | Promise<TContext>;

/**
 * Error formatting function
 */
export type FormatErrorFn = (error: GraphQLFormattedError) => GraphQLFormattedError;

/**
 * GraphQL formatted error
 */
export interface GraphQLFormattedError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

/**
 * Plugin interface
 *
 * @deprecated Has no effect; removal target 0.3.0. No plugin host consumes
 * these hooks — use NestJS interceptors and guards instead.
 */
export interface LeavenPlugin {
  name: string;
  onInit?: () => void | Promise<void>;
  onRequest?: (context: PluginContext) => void | Promise<void>;
  onResponse?: (context: PluginContext, response: unknown) => void | Promise<void>;
  onError?: (context: PluginContext, error: Error) => void | Promise<void>;
}

/**
 * Plugin context
 *
 * @deprecated Has no effect; removal target 0.3.0. See {@link LeavenPlugin}.
 */
export interface PluginContext {
  request: Request;
  response?: Response;
  schema: GraphQLSchema;
  document?: DocumentNode;
  operationName?: string;
  variables?: Record<string, unknown>;
}

/**
 * CORS options
 */
export interface CorsOptions {
  origin?: string | string[] | boolean;
  methods?: string | string[];
  allowedHeaders?: string | string[];
  exposedHeaders?: string | string[];
  credentials?: boolean;
  maxAge?: number;
}

/**
 * Request context passed to resolvers.
 *
 * `req` and `res` are the **transport's own** request/response objects, and
 * the two shipped entry points do not agree on what those are:
 *
 * - `GraphQLMiddleware` (what `LeavenModule` wires up at `options.path`) stores
 *   the **Express** request and response. This is the path where `ctx.req.user`
 *   works, because Passport writes `user` onto the Express request.
 * - `LeavenDriver.handleRequest` — an alternative entry point for callers that
 *   already hold a Fetch pair, not used by `GraphQLMiddleware` — stores a
 *   genuine Fetch `Request`/`Response`. A Fetch `Request` has no `user`
 *   property, so `ctx.req.user` is always `undefined` there.
 *
 * The default type parameters name the Fetch types, which describe
 * `handleRequest`. Behind the middleware, parameterize with your framework's
 * types (`GqlContext<ExpressRequest, ExpressResponse>`) instead of relying on
 * the defaults.
 *
 * Code that must work behind either entry point should read values the
 * configured `context` factory placed on the context directly, rather than
 * reaching through `ctx.req`. The factory's first argument is a Fetch
 * `Request` under both entry points (the middleware adapts the Express request
 * for exactly this reason); its second argument is not adapted and is the
 * transport-native response.
 */
export interface GqlContext<TRequest = Request, TResponse = Response> {
  req: TRequest;
  res: TResponse;
  [key: string]: unknown;
}

/**
 * Execution context for GraphQL operations
 */
export interface GqlExecutionContext {
  getContext<T = GqlContext>(): T;
  getRoot<T = unknown>(): T;
  getArgs<T = Record<string, unknown>>(): T;
  getInfo<T = unknown>(): T;
}
