/**
 * @leaven-graphql/nestjs - NestJS Module
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  Module,
  DynamicModule,
  Global,
  Inject,
  Optional,
  Provider,
  type MiddlewareConsumer,
  type NestModule,
  type Type,
  type InjectionToken,
} from '@nestjs/common';
import {
  LEAVEN_MODULE_OPTIONS,
  LEAVEN_DRIVER,
  LEAVEN_PUBSUB,
  type LeavenModuleOptions,
  type LeavenModuleAsyncOptions,
  type LeavenOptionsFactory,
} from './types';
import { createPubSub, type PubSub } from '@leaven-graphql/ws';
import { LEAVEN_MAX_COMPLEXITY, LEAVEN_MAX_DEPTH } from './guards';
import { LeavenDriver } from './driver';
import { GraphQLMiddleware } from './middleware';
import { SchemaBuilderService } from './schema-builder';
import { SubscriptionManager } from './subscriptions';

/**
 * Injection tokens for the Leaven module options and driver.
 *
 * Defined in `./types` (see the note there) and re-exported here so that
 * existing `import { LEAVEN_MODULE_OPTIONS, LEAVEN_DRIVER } from './module'`
 * sites keep working.
 */
export { LEAVEN_MODULE_OPTIONS, LEAVEN_DRIVER, LEAVEN_PUBSUB };

/**
 * Leaven GraphQL Module for NestJS
 *
 * This module provides integration between NestJS and Leaven GraphQL.
 * It can be used with both schema-first and code-first approaches.
 *
 * Configuring the module via {@link forRoot} or {@link forRootAsync}
 * registers the {@link LeavenDriver}, the {@link SchemaBuilderService}
 * (which builds the schema from `schema` or `typeDefs`/`resolvers` and
 * hands it to the driver), the {@link SubscriptionManager}, and the
 * {@link GraphQLMiddleware} serving the HTTP endpoint, which is applied
 * automatically at `options.path` (default `/graphql`).
 *
 * ## What this module does NOT wire
 *
 * - **The WebSocket transport.** {@link SubscriptionManager} is registered as a
 *   provider, but registering it does not open a socket: opening one requires
 *   `server.upgrade()` on the underlying HTTP server, and this module only has
 *   a `MiddlewareConsumer`, which cannot express an upgrade route. The manager
 *   deliberately owns the graphql-ws protocol and nothing else. Callers
 *   register the upgrade route at `subscriptions.path` themselves and hand each
 *   socket to the manager — see the package README's "Wiring the WebSocket
 *   transport".
 * - **The NestJS execution pipeline around resolvers.** Resolvers supplied via
 *   `resolvers` (or baked into a pre-built `schema`) are plain functions
 *   invoked by graphql-js, not Nest handlers, so `@UseGuards`,
 *   `@UseInterceptors`, and parameter decorators such as `@Args()` never fire
 *   for them. To get that pipeline, use `LeavenGraphQLDriver` (`graphql-driver.ts`) — the
 *   `@nestjs/graphql` `AbstractGraphQLDriver` bridge this package ships — with
 *   `GraphQLModule.forRoot({ driver: LeavenGraphQLDriver })` instead of this
 *   module. Query limits are unaffected: the executor enforces both
 *   `maxComplexity` and `maxDepth` directly on either path. See the note on
 *   {@link ComplexityGuard} for why the guards do not apply.
 *
 * @example
 * ```typescript
 * // Schema-first approach
 * @Module({
 *   imports: [
 *     LeavenModule.forRoot({
 *       typeDefs: `
 *         type Query {
 *           hello: String!
 *         }
 *       `,
 *       resolvers: {
 *         Query: {
 *           hello: () => 'Hello World!',
 *         },
 *       },
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * @example
 * ```typescript
 * // Async configuration
 * @Module({
 *   imports: [
 *     LeavenModule.forRootAsync({
 *       useFactory: (configService: ConfigService) => ({
 *         playground: configService.get('GRAPHQL_PLAYGROUND'),
 *         introspection: configService.get('GRAPHQL_INTROSPECTION'),
 *       }),
 *       inject: [ConfigService],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class LeavenModule implements NestModule {
  constructor(
    @Optional()
    @Inject(LEAVEN_MODULE_OPTIONS)
    private readonly options?: LeavenModuleOptions
  ) {}

  /**
   * Register the {@link GraphQLMiddleware} at the configured GraphQL
   * endpoint (`options.path`, default `/graphql`).
   *
   * Called automatically by NestJS during application initialization. When
   * the module is imported without `forRoot()`/`forRootAsync()` no options
   * provider exists (and no GraphQL providers are registered), so nothing
   * is wired.
   */
  public configure(consumer: MiddlewareConsumer): void {
    if (!this.options) {
      return;
    }

    consumer
      .apply(GraphQLMiddleware)
      .forRoutes(this.options.path ?? '/graphql');
  }

  /**
   * Configure the module synchronously.
   *
   * Registers the options and driver providers along with the
   * {@link SchemaBuilderService}, {@link SubscriptionManager}, and
   * {@link GraphQLMiddleware} so that importing this module yields a
   * working GraphQL endpoint.
   */
  public static forRoot(options: LeavenModuleOptions = {}): DynamicModule {
    const optionsProvider: Provider = {
      provide: LEAVEN_MODULE_OPTIONS,
      useValue: options,
    };

    const driverProvider: Provider = {
      provide: LEAVEN_DRIVER,
      useFactory: (opts: LeavenModuleOptions) => new LeavenDriver(opts),
      inject: [LEAVEN_MODULE_OPTIONS],
    };

    return {
      module: LeavenModule,
      providers: [
        optionsProvider,
        driverProvider,
        ...LeavenModule.createLimitProviders(),
        LeavenModule.createPubSubProvider(),
        SchemaBuilderService,
        SubscriptionManager,
        GraphQLMiddleware,
      ],
      exports: [
        LEAVEN_MODULE_OPTIONS,
        LEAVEN_DRIVER,
        LEAVEN_MAX_COMPLEXITY,
        LEAVEN_MAX_DEPTH,
        LEAVEN_PUBSUB,
        SchemaBuilderService,
        SubscriptionManager,
      ],
    };
  }

  /**
   * Build the providers backing {@link ComplexityGuard} and
   * {@link DepthGuard}.
   *
   * The guards inject their limits by token, so the tokens must resolve
   * even when the corresponding option is absent; `Infinity` expresses
   * "no limit" without the guards having to special-case `undefined`.
   */
  private static createLimitProviders(): Provider[] {
    return [
      {
        provide: LEAVEN_MAX_COMPLEXITY,
        useFactory: (opts: LeavenModuleOptions): number =>
          opts.maxComplexity ?? Infinity,
        inject: [LEAVEN_MODULE_OPTIONS],
      },
      {
        provide: LEAVEN_MAX_DEPTH,
        useFactory: (opts: LeavenModuleOptions): number =>
          opts.maxDepth ?? Infinity,
        inject: [LEAVEN_MODULE_OPTIONS],
      },
    ];
  }

  /**
   * Build the shared {@link PubSub} provider resolved by `@InjectPubSub()`.
   *
   * One instance per module so that a publisher and a subscriber in
   * different providers reach the same topics.
   */
  private static createPubSubProvider(): Provider {
    return {
      provide: LEAVEN_PUBSUB,
      useFactory: (opts: LeavenModuleOptions): PubSub =>
        opts.pubSub ?? createPubSub(),
      inject: [LEAVEN_MODULE_OPTIONS],
    };
  }

  /**
   * Configure the module asynchronously.
   *
   * Registers the same providers as {@link forRoot}, with the options
   * resolved via `useFactory`, `useClass`, or `useExisting`.
   */
  public static forRootAsync(options: LeavenModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);

    const driverProvider: Provider = {
      provide: LEAVEN_DRIVER,
      useFactory: (opts: LeavenModuleOptions) => new LeavenDriver(opts),
      inject: [LEAVEN_MODULE_OPTIONS],
    };

    return {
      module: LeavenModule,
      imports: options.imports ?? [],
      providers: [
        ...asyncProviders,
        driverProvider,
        ...LeavenModule.createLimitProviders(),
        LeavenModule.createPubSubProvider(),
        SchemaBuilderService,
        SubscriptionManager,
        GraphQLMiddleware,
      ],
      exports: [
        LEAVEN_MODULE_OPTIONS,
        LEAVEN_DRIVER,
        LEAVEN_MAX_COMPLEXITY,
        LEAVEN_MAX_DEPTH,
        LEAVEN_PUBSUB,
        SchemaBuilderService,
        SubscriptionManager,
      ],
    };
  }

  /**
   * Create async providers based on configuration
   *
   * @throws Error when none of `useFactory`, `useClass`, or `useExisting`
   * is supplied.
   */
  private static createAsyncProviders(
    options: LeavenModuleAsyncOptions
  ): Provider[] {
    if (!options.useFactory && !options.useClass && !options.useExisting) {
      throw new Error(
        'LeavenModule.forRootAsync requires one of useFactory, useClass, or useExisting'
      );
    }

    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }

    const useClass = options.useClass as Type<LeavenOptionsFactory>;
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  /**
   * Create the async options provider
   */
  private static createAsyncOptionsProvider(
    options: LeavenModuleAsyncOptions
  ): Provider {
    if (options.useFactory) {
      return {
        provide: LEAVEN_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: (options.inject ?? []) as InjectionToken[],
      };
    }

    const inject = [
      (options.useClass ?? options.useExisting) as Type<LeavenOptionsFactory>,
    ];

    return {
      provide: LEAVEN_MODULE_OPTIONS,
      useFactory: async (optionsFactory: LeavenOptionsFactory) =>
        optionsFactory.createLeavenOptions(),
      inject,
    };
  }
}
