/**
 * @leaven-graphql/nestjs - Module tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import 'reflect-metadata';
import { describe, test, expect } from 'bun:test';
import { Test } from '@nestjs/testing';
import { Injectable, type MiddlewareConsumer } from '@nestjs/common';
import { PubSub, createPubSub } from '@leaven-graphql/ws';
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from 'graphql';
import { LeavenModule, LEAVEN_MODULE_OPTIONS, LEAVEN_DRIVER, LEAVEN_PUBSUB } from './module';
import { LeavenDriver } from './driver';
import { SchemaBuilderService } from './schema-builder';
import { SubscriptionManager, InjectPubSub } from './subscriptions';
import { GraphQLMiddleware } from './middleware';
import type { LeavenModuleOptions, LeavenModuleAsyncOptions } from './types';

const createSchema = (): GraphQLSchema =>
  new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        hello: {
          type: GraphQLString,
          resolve: () => 'Hello World!',
        },
      },
    }),
  });

type MiddlewareRequest = Parameters<GraphQLMiddleware['use']>[0];
type MiddlewareResponse = Parameters<GraphQLMiddleware['use']>[1];

/**
 * Invoke the middleware with a fake POST request and capture the response.
 */
async function invokeMiddleware(
  middleware: GraphQLMiddleware,
  query: string,
  path = '/graphql'
): Promise<{ statusCode: number; body: unknown; nextCalled: boolean }> {
  let statusCode = 0;
  let body: unknown;
  let nextCalled = false;

  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    send(payload: unknown) {
      body = payload;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
  };

  await middleware.use(
    { method: 'POST', path, body: { query }, headers: { 'content-type': 'application/json' } } as MiddlewareRequest,
    res as unknown as MiddlewareResponse,
    () => {
      nextCalled = true;
    }
  );

  return { statusCode, body, nextCalled };
}

/**
 * Create a MiddlewareConsumer spy capturing applied middleware and routes.
 */
function createConsumerSpy(): {
  consumer: MiddlewareConsumer;
  applied: unknown[];
  routes: unknown[];
} {
  const applied: unknown[] = [];
  const routes: unknown[] = [];
  const consumer = {
    apply(...middleware: unknown[]) {
      applied.push(...middleware);
      return {
        forRoutes(...r: unknown[]) {
          routes.push(...r);
          return consumer;
        },
      };
    },
  };
  return { consumer: consumer as unknown as MiddlewareConsumer, applied, routes };
}

describe('LeavenModule', () => {
  describe('forRoot', () => {
    test('should create module with default options', () => {
      const module = LeavenModule.forRoot();

      expect(module.module).toBe(LeavenModule);
      expect(module.providers).toBeDefined();
      expect(module.exports).toContain(LEAVEN_MODULE_OPTIONS);
      expect(module.exports).toContain(LEAVEN_DRIVER);
    });

    test('should create module with custom options', () => {
      const options: LeavenModuleOptions = {
        path: '/api/graphql',
        playground: true,
        introspection: true,
      };

      const module = LeavenModule.forRoot(options);

      expect(module.module).toBe(LeavenModule);
      expect(module.providers).toBeDefined();
      expect(module.providers?.length).toBeGreaterThan(0);
    });

    test('should provide options with correct token', () => {
      const options: LeavenModuleOptions = {
        path: '/custom',
      };

      const module = LeavenModule.forRoot(options);
      const optionsProvider = module.providers?.find(
        (p) => (p as { provide: symbol }).provide === LEAVEN_MODULE_OPTIONS
      );

      expect(optionsProvider).toBeDefined();
      expect((optionsProvider as { useValue: LeavenModuleOptions }).useValue).toEqual(options);
    });

    test('should provide driver with correct token', () => {
      const module = LeavenModule.forRoot();
      const driverProvider = module.providers?.find(
        (p) => (p as { provide: symbol }).provide === LEAVEN_DRIVER
      );

      expect(driverProvider).toBeDefined();
      expect((driverProvider as { useFactory: Function }).useFactory).toBeDefined();
    });

    test('should register schema builder, subscription manager, and middleware providers', () => {
      const module = LeavenModule.forRoot();

      expect(module.providers).toContain(SchemaBuilderService);
      expect(module.providers).toContain(SubscriptionManager);
      expect(module.providers).toContain(GraphQLMiddleware);
      expect(module.exports).toContain(SchemaBuilderService);
      expect(module.exports).toContain(SubscriptionManager);
    });
  });

  describe('forRootAsync', () => {
    test('should create module with factory', () => {
      const module = LeavenModule.forRootAsync({
        useFactory: () => ({
          path: '/graphql',
        }),
      });

      expect(module.module).toBe(LeavenModule);
      expect(module.providers).toBeDefined();
      expect(module.exports).toContain(LEAVEN_MODULE_OPTIONS);
      expect(module.exports).toContain(LEAVEN_DRIVER);
    });

    test('should create module with async factory', () => {
      const module = LeavenModule.forRootAsync({
        useFactory: async () => ({
          path: '/graphql',
          playground: true,
        }),
      });

      expect(module.module).toBe(LeavenModule);
      expect(module.providers).toBeDefined();
    });

    test('should create module with inject dependencies', () => {
      const ConfigService = class ConfigService {};

      const module = LeavenModule.forRootAsync({
        useFactory: (_config: unknown) => ({
          path: '/graphql',
        }),
        inject: [ConfigService],
      });

      expect(module.module).toBe(LeavenModule);
      expect(module.providers).toBeDefined();
    });

    test('should create module with useClass', () => {
      class CustomOptionsFactory {
        createLeavenOptions(): LeavenModuleOptions {
          return { path: '/graphql' };
        }
      }

      const module = LeavenModule.forRootAsync({
        useClass: CustomOptionsFactory,
      });

      expect(module.module).toBe(LeavenModule);
      expect(module.providers?.length).toBeGreaterThan(1);
    });

    test('should create module with useExisting', () => {
      class ExistingOptionsFactory {
        createLeavenOptions(): LeavenModuleOptions {
          return { path: '/graphql' };
        }
      }

      const module = LeavenModule.forRootAsync({
        useExisting: ExistingOptionsFactory,
      });

      expect(module.module).toBe(LeavenModule);
      expect(module.providers).toBeDefined();
    });

    test('should include imports', () => {
      const MockModule = class MockModule {};

      const module = LeavenModule.forRootAsync({
        imports: [MockModule as any],
        useFactory: () => ({}),
      });

      expect(module.imports).toContain(MockModule);
    });

    test('should register schema builder, subscription manager, and middleware providers', () => {
      const module = LeavenModule.forRootAsync({
        useFactory: () => ({}),
      });

      expect(module.providers).toContain(SchemaBuilderService);
      expect(module.providers).toContain(SubscriptionManager);
      expect(module.providers).toContain(GraphQLMiddleware);
      expect(module.exports).toContain(SchemaBuilderService);
      expect(module.exports).toContain(SubscriptionManager);
    });

    test('should throw when none of useFactory, useClass, or useExisting is provided', () => {
      expect(() =>
        LeavenModule.forRootAsync({} as LeavenModuleAsyncOptions)
      ).toThrow(
        'LeavenModule.forRootAsync requires one of useFactory, useClass, or useExisting'
      );
    });
  });

  describe('configure', () => {
    test('should apply GraphQLMiddleware at the default /graphql path', () => {
      const leavenModule = new LeavenModule({});
      const { consumer, applied, routes } = createConsumerSpy();

      leavenModule.configure(consumer);

      expect(applied).toContain(GraphQLMiddleware);
      expect(routes).toContain('/graphql');
    });

    test('should apply GraphQLMiddleware at a custom path', () => {
      const leavenModule = new LeavenModule({ path: '/api/graphql' });
      const { consumer, applied, routes } = createConsumerSpy();

      leavenModule.configure(consumer);

      expect(applied).toContain(GraphQLMiddleware);
      expect(routes).toContain('/api/graphql');
    });

    test('should do nothing when the module was imported without forRoot()', () => {
      const leavenModule = new LeavenModule();
      const { consumer, applied, routes } = createConsumerSpy();

      leavenModule.configure(consumer);

      expect(applied).toEqual([]);
      expect(routes).toEqual([]);
    });
  });

  describe('integration (NestJS testing module)', () => {
    test('should boot with a pre-built schema, wire it through the schema builder into the driver, and serve queries via the middleware', async () => {
      const schema = createSchema();
      const moduleRef = await Test.createTestingModule({
        imports: [LeavenModule.forRoot({ schema })],
      }).compile();
      await moduleRef.init();

      try {
        const builder = moduleRef.get(SchemaBuilderService);
        const driver = moduleRef.get<LeavenDriver>(LEAVEN_DRIVER);
        const subscriptions = moduleRef.get(SubscriptionManager);
        const middleware = moduleRef.get(GraphQLMiddleware);

        // Schema is built and shared between the builder and the driver
        expect(builder.isSchemaReady()).toBe(true);
        expect(driver.getSchema()).toBe(schema);
        expect(subscriptions).toBeInstanceOf(SubscriptionManager);
        expect(middleware).toBeInstanceOf(GraphQLMiddleware);

        // The middleware answers GraphQL requests end to end
        const { statusCode, body } = await invokeMiddleware(middleware, '{ hello }');
        expect(statusCode).toBe(200);
        expect((body as { errors?: unknown[] }).errors ?? []).toEqual([]);
        expect((body as { data?: unknown }).data).toEqual({ hello: 'Hello World!' });
      } finally {
        await moduleRef.close();
      }
    });

    test('should inject a working PubSub into providers via @InjectPubSub()', async () => {
      @Injectable()
      class FeedService {
        constructor(@InjectPubSub() public readonly pubSub: PubSub) {}
      }

      const moduleRef = await Test.createTestingModule({
        imports: [LeavenModule.forRoot({ schema: createSchema() })],
        providers: [FeedService],
      }).compile();
      await moduleRef.init();

      try {
        const service = moduleRef.get(FeedService);
        expect(service.pubSub).toBeInstanceOf(PubSub);

        // The injected instance is the module's, and it actually delivers
        const iterator = service.pubSub.asyncIterator<{ body: string }>('COMMENT_ADDED');
        moduleRef.get<PubSub>(LEAVEN_PUBSUB).publish('COMMENT_ADDED', { body: 'hello' });

        const first = await iterator.next();
        expect(first.value).toEqual({ body: 'hello' });
        await iterator.return?.(undefined);
      } finally {
        await moduleRef.close();
      }
    });

    test('should use a caller-supplied PubSub instance when one is configured', async () => {
      const pubSub = createPubSub();

      const moduleRef = await Test.createTestingModule({
        imports: [LeavenModule.forRoot({ schema: createSchema(), pubSub })],
      }).compile();
      await moduleRef.init();

      try {
        expect(moduleRef.get<PubSub>(LEAVEN_PUBSUB)).toBe(pubSub);
      } finally {
        await moduleRef.close();
      }
    });

    test('should boot via forRootAsync with useFactory and build the schema', async () => {
      const schema = createSchema();
      const moduleRef = await Test.createTestingModule({
        imports: [LeavenModule.forRootAsync({ useFactory: () => ({ schema }) })],
      }).compile();
      await moduleRef.init();

      try {
        const builder = moduleRef.get(SchemaBuilderService);
        const driver = moduleRef.get<LeavenDriver>(LEAVEN_DRIVER);

        expect(builder.isSchemaReady()).toBe(true);
        expect(driver.getSchema()).toBe(schema);
        expect(moduleRef.get(GraphQLMiddleware)).toBeInstanceOf(GraphQLMiddleware);
      } finally {
        await moduleRef.close();
      }
    });

    test('should boot with typeDefs/resolvers and keep the schema builder and driver in sync', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          LeavenModule.forRoot({
            typeDefs: 'type Query { hello: String }',
            resolvers: { Query: { hello: () => 'Hello World!' } },
          }),
        ],
      }).compile();
      await moduleRef.init();

      try {
        const builder = moduleRef.get(SchemaBuilderService);
        const driver = moduleRef.get<LeavenDriver>(LEAVEN_DRIVER);

        // Whatever the builder produced must be what the driver serves.
        expect(driver.getSchema()).toBe(builder.getSchema());
        expect(moduleRef.get(SubscriptionManager)).toBeInstanceOf(SubscriptionManager);
        expect(moduleRef.get(GraphQLMiddleware)).toBeInstanceOf(GraphQLMiddleware);
      } finally {
        await moduleRef.close();
      }
    });

    test('should build an executable schema from typeDefs/resolvers and serve queries', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          LeavenModule.forRoot({
            typeDefs: 'type Query { hello: String }',
            resolvers: { Query: { hello: () => 'Hello World!' } },
          }),
        ],
      }).compile();
      await moduleRef.init();

      try {
        const builder = moduleRef.get(SchemaBuilderService);
        const middleware = moduleRef.get(GraphQLMiddleware);

        expect(builder.isSchemaReady()).toBe(true);

        const { statusCode, body } = await invokeMiddleware(middleware, '{ hello }');
        expect(statusCode).toBe(200);
        expect((body as { data?: unknown }).data).toEqual({ hello: 'Hello World!' });
      } finally {
        await moduleRef.close();
      }
    });

    test('should inject module options into LeavenModule for middleware configuration', async () => {
      const schema = createSchema();
      const moduleRef = await Test.createTestingModule({
        imports: [LeavenModule.forRoot({ schema, path: '/api/graphql' })],
      }).compile();
      await moduleRef.init();

      try {
        const leavenModule = moduleRef.get(LeavenModule);
        const { consumer, applied, routes } = createConsumerSpy();

        leavenModule.configure(consumer);

        expect(applied).toContain(GraphQLMiddleware);
        expect(routes).toContain('/api/graphql');
      } finally {
        await moduleRef.close();
      }
    });
  });

  describe('token exports', () => {
    test('should export LEAVEN_MODULE_OPTIONS token', () => {
      expect(LEAVEN_MODULE_OPTIONS).toBe('LEAVEN_MODULE_OPTIONS');
    });

    test('should export LEAVEN_DRIVER token', () => {
      expect(LEAVEN_DRIVER).toBe('LEAVEN_DRIVER');
    });
  });
});
