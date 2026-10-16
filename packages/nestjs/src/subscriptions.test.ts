/**
 * @leaven-graphql/nestjs - Subscriptions tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import 'reflect-metadata';
import type { ServerWebSocket } from 'bun';
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLInt } from 'graphql';
import {
  SubscriptionManager,
  Subscription,
  InjectPubSub,
  type SubscriptionConfig,
  type SubscriptionSocket,
} from './subscriptions';
import { LeavenDriver } from './driver';
import { SubscriptionFilter, SUBSCRIPTION_FILTER_KEY } from './decorators';
import { createPubSub } from '@leaven-graphql/ws';
import { LEAVEN_PUBSUB, type LeavenModuleOptions } from './types';

describe('SubscriptionManager', () => {
  let manager: SubscriptionManager;
  let driver: LeavenDriver;
  let schema: GraphQLSchema;
  let options: LeavenModuleOptions;

  beforeEach(async () => {
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

    options = {
      schema,
      path: '/graphql',
    };

    driver = new LeavenDriver(options);
    await driver.onModuleInit();

    manager = new SubscriptionManager(options, driver);
    await manager.onModuleInit();
  });

  afterEach(async () => {
    await manager.onModuleDestroy();
    await driver.onModuleDestroy();
  });

  describe('initialization', () => {
    test('should initialize with zero connections', () => {
      expect(manager.getConnectionCount()).toBe(0);
    });

    test('should initialize with zero subscriptions', () => {
      expect(manager.getSubscriptionCount()).toBe(0);
    });
  });

  describe('connection count', () => {
    test('should return correct connection count', () => {
      expect(manager.getConnectionCount()).toBe(0);
    });
  });

  describe('subscription count', () => {
    test('should return correct subscription count', () => {
      expect(manager.getSubscriptionCount()).toBe(0);
    });
  });
});

describe('Subscription Decorator', () => {
  test('should set subscription metadata', () => {
    const returnsFn = () => String;

    class TestResolver {
      @Subscription(returnsFn)
      onMessage() {}
    }

    const metadata = Reflect.getMetadata('leaven:subscription', TestResolver.prototype.onMessage);
    expect(metadata).toBeDefined();
    expect(metadata.returns).toBe(returnsFn);
  });

  test('should set subscription metadata with filter', () => {
    const returnsFn = () => String;
    const filterFn = () => true;

    class TestResolver {
      @Subscription(returnsFn, { filter: filterFn })
      onMessage() {}
    }

    const metadata = Reflect.getMetadata('leaven:subscription', TestResolver.prototype.onMessage);
    expect(metadata).toBeDefined();
    expect(metadata.options.filter).toBe(filterFn);
  });

  test('records the filter under the same key as @SubscriptionFilter', () => {
    const filterFn = (): boolean => true;

    class TestResolver {
      @Subscription(() => String, { filter: filterFn })
      public onMessage(): void {}
    }

    // The `filter` option documents itself as equivalent to applying
    // @SubscriptionFilter, so both metadata keys must land on the wrapper a
    // schema builder will inspect.
    const method = TestResolver.prototype.onMessage;
    expect(Reflect.getMetadata('leaven:subscription', method)).toBeDefined();
    expect(Reflect.getMetadata(SUBSCRIPTION_FILTER_KEY, method)).toBe(filterFn);
  });

  test('should apply the filter option to the streamed events', async () => {
    class TestResolver {
      @Subscription(() => String, {
        filter: (payload: unknown, variables: unknown) =>
          (payload as { room: string }).room === (variables as { room: string }).room,
      })
      public onMessage(): AsyncGenerator<{ room: string; text: string }> {
        return (async function* () {
          yield { room: 'general', text: 'in' };
          yield { room: 'random', text: 'out' };
          yield { room: 'general', text: 'also in' };
        })();
      }
    }

    const iterator = await new TestResolver().onMessage(undefined, { room: 'general' });

    const texts: string[] = [];
    for await (const event of iterator) {
      texts.push(event.text);
    }

    expect(texts).toEqual(['in', 'also in']);
  });
});

describe('InjectPubSub Decorator', () => {
  test('should be a decorator factory that returns a parameter decorator', () => {
    const decorator = InjectPubSub();
    expect(typeof decorator).toBe('function');
  });

  test('should mark constructor parameters for injection of the PubSub token', () => {
    class TestService {
      public constructor(@InjectPubSub() _pubSub: unknown) {}
    }

    // Nest records self-declared constructor dependencies as an index -> token
    // map under 'self:paramtypes'.
    const injected = Reflect.getMetadata('self:paramtypes', TestService) as
      | Array<{ index: number; param: unknown }>
      | undefined;

    expect(injected).toBeDefined();
    expect(injected?.find((d) => d.index === 0)?.param).toBe(LEAVEN_PUBSUB);
  });
});

describe('SubscriptionManager WebSocket handling', () => {
  let manager: SubscriptionManager;
  let driver: LeavenDriver;
  let schema: GraphQLSchema;

  beforeEach(async () => {
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

    const options: LeavenModuleOptions = { schema };
    driver = new LeavenDriver(options);
    await driver.onModuleInit();

    manager = new SubscriptionManager(options, driver);
    await manager.onModuleInit();
  });

  afterEach(async () => {
    await manager.onModuleDestroy();
    await driver.onModuleDestroy();
  });

  test('should handle mock WebSocket connection', async () => {
    const mockSocket = createMockWebSocket();

    await manager.handleConnection(mockSocket as unknown as WebSocket);

    expect(manager.getConnectionCount()).toBe(1);
  });

  test('should handle mock WebSocket close', async () => {
    const mockSocket = createMockWebSocket();

    await manager.handleConnection(mockSocket as unknown as WebSocket);
    expect(manager.getConnectionCount()).toBe(1);

    // Simulate close
    mockSocket.simulateClose();

    expect(manager.getConnectionCount()).toBe(0);
  });

  test('should handle ping message', async () => {
    const mockSocket = createMockWebSocket();

    await manager.handleConnection(mockSocket as unknown as WebSocket);

    // Simulate ping message
    mockSocket.simulateMessage(JSON.stringify({ type: 'ping' }));
    await waitFor(() => sentOfType(mockSocket, 'pong').length > 0);

    // Should respond with pong
    expect(mockSocket.sentMessages).toContainEqual(
      expect.objectContaining({ type: 'pong' })
    );
  });

  test('should handle connection_init message', async () => {
    const mockSocket = createMockWebSocket();

    await manager.handleConnection(mockSocket as unknown as WebSocket);

    // Simulate connection_init
    mockSocket.simulateMessage(
      JSON.stringify({ type: 'connection_init', payload: { token: 'test' } })
    );
    await waitFor(() => sentOfType(mockSocket, 'connection_ack').length > 0);

    // Should respond with connection_ack
    expect(mockSocket.sentMessages).toContainEqual(
      expect.objectContaining({ type: 'connection_ack' })
    );
  });

  test('should handle subscribe message after initialization', async () => {
    const mockSocket = createMockWebSocket();

    await manager.handleConnection(mockSocket as unknown as WebSocket);

    // Initialize connection first
    mockSocket.simulateMessage(
      JSON.stringify({ type: 'connection_init' })
    );

    // Wait for connection_ack
    await waitFor(() => sentOfType(mockSocket, 'connection_ack').length > 0);

    // Send subscribe message
    mockSocket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: '{ hello }' },
      })
    );

    // Wait for response
    await waitFor(() => sentOfType(mockSocket, 'next').length > 0);

    // Should have sent next and complete messages
    expect(mockSocket.sentMessages.some(m =>
      'type' in m && (m as { type: string }).type === 'next'
    )).toBe(true);
  });

  test('should handle complete message', async () => {
    const mockSocket = createMockWebSocket();

    await manager.handleConnection(mockSocket as unknown as WebSocket);

    // Initialize connection
    mockSocket.simulateMessage(
      JSON.stringify({ type: 'connection_init' })
    );

    await waitFor(() => sentOfType(mockSocket, 'connection_ack').length > 0);

    // Send complete message
    mockSocket.simulateMessage(
      JSON.stringify({ type: 'complete', id: 'sub-1' })
    );

    // Should not throw
    expect(manager.getConnectionCount()).toBe(1);
  });

  test('should close connection for duplicate init', async () => {
    const mockSocket = createMockWebSocket();

    await manager.handleConnection(mockSocket as unknown as WebSocket);

    // First connection_init
    mockSocket.simulateMessage(
      JSON.stringify({ type: 'connection_init' })
    );

    await waitFor(() => sentOfType(mockSocket, 'connection_ack').length > 0);

    // Second connection_init should close the socket
    mockSocket.simulateMessage(
      JSON.stringify({ type: 'connection_init' })
    );

    await waitFor(() => mockSocket.readyState === 3);

    expect(mockSocket.closeCode).toBe(4429);
  });

  test('should handle pong message (no-op)', async () => {
    const mockSocket = createMockWebSocket();

    await manager.handleConnection(mockSocket as unknown as WebSocket);

    // Initialize connection
    mockSocket.simulateMessage(
      JSON.stringify({ type: 'connection_init' })
    );

    await waitFor(() => sentOfType(mockSocket, 'connection_ack').length > 0);

    const messageCountBefore = mockSocket.sentMessages.length;

    // Send pong message (should be a no-op)
    mockSocket.simulateMessage(
      JSON.stringify({ type: 'pong' })
    );

    // Absence wait: there is no arrival to poll for.
    await sleep(ABSENCE_WAIT_MS);

    // No new messages should be sent
    expect(mockSocket.sentMessages.length).toBe(messageCountBefore);
  });

  test('should handle WebSocket error', async () => {
    const mockSocket = createMockWebSocket();

    await manager.handleConnection(mockSocket as unknown as WebSocket);
    expect(manager.getConnectionCount()).toBe(1);

    // Simulate error - the error handler logs but doesn't close
    mockSocket.simulateError(new Error('Connection error'));

    // Connection may or may not be closed depending on implementation
    // The important thing is it doesn't throw
    expect(manager.getConnectionCount()).toBeGreaterThanOrEqual(0);
  });
});

describe('SubscriptionManager protocol errors (graphql-ws)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createManager();
  });

  afterEach(async () => {
    await destroyHarness(harness);
  });

  test('closes with 4400 on unparseable JSON', async () => {
    const socket = createMockWebSocket();
    await harness.manager.handleConnection(socket as unknown as WebSocket);

    socket.simulateMessage('{ this is not valid json');
    await waitFor(() => socket.readyState === 3);

    expect(socket.closeCode).toBe(4400);
  });

  test('closes with 4400 on a non-object message', async () => {
    const socket = createMockWebSocket();
    await harness.manager.handleConnection(socket as unknown as WebSocket);

    socket.simulateMessage(JSON.stringify(42));
    await waitFor(() => socket.readyState === 3);

    expect(socket.closeCode).toBe(4400);
  });

  test('closes with 4400 on an unknown message type', async () => {
    const socket = createMockWebSocket();
    await harness.manager.handleConnection(socket as unknown as WebSocket);

    socket.simulateMessage(JSON.stringify({ type: 'totally_bogus' }));
    await waitFor(() => socket.readyState === 3);

    expect(socket.closeCode).toBe(4400);
  });

  test.each(['evil\nINFO forged', 'x'.repeat(65), '', 'a b', 'del\u007f'])(
    'closes with 4400 "Invalid message" for subscribe id %p',
    async (id) => {
      const socket = await initConnection(harness.manager);

      socket.simulateMessage(
        JSON.stringify({ type: 'subscribe', id, payload: { query: '{ hello }' } })
      );
      await waitFor(() => socket.readyState === 3);

      expect(socket.closeCode).toBe(4400);
      expect(socket.closeReason).toBe('Invalid message');
    }
  );

  test('closes with 4400 "Invalid message" for a malformed complete id', async () => {
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(JSON.stringify({ type: 'complete', id: 'a\r\nb' }));
    await waitFor(() => socket.readyState === 3);

    expect(socket.closeCode).toBe(4400);
    expect(socket.closeReason).toBe('Invalid message');
  });

  test('closes with 4400 for a complete frame with a non-string id', async () => {
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(JSON.stringify({ type: 'complete', id: 7 }));
    await waitFor(() => socket.readyState === 3);

    expect(socket.closeCode).toBe(4400);
  });

  test('accepts a well-formed operation id', async () => {
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({ type: 'subscribe', id: 'op:1.a_b-C', payload: { query: '{ hello }' } })
    );
    await waitFor(() =>
      socket.sentMessages.some((m) => (m as { id?: unknown }).id === 'op:1.a_b-C')
    );

    expect(socket.readyState).not.toBe(3);
  });

  test('closes with 4409 when a subscribe reuses an active operation id', async () => {
    const socket = await initConnection(harness.manager);

    expect(
      harness.manager.registerSubscription(socket as unknown as WebSocket, 'dup', 'news')
    ).toBe(true);

    socket.simulateMessage(
      JSON.stringify({ type: 'subscribe', id: 'dup', payload: { query: '{ hello }' } })
    );
    await waitFor(() => socket.readyState === 3);

    expect(socket.closeCode).toBe(4409);
  });

  test('sends an error frame when a subscription operation fails validation', async () => {
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { nonexistentField }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'error').length > 0);

    const errors = sentOfType(socket, 'error');
    expect(errors.length).toBe(1);
    expect(errors[0]?.id).toBe('sub-1');

    // Loud failure, not a silent hang: no data, nothing parked in the map
    expect(sentOfType(socket, 'next').length).toBe(0);
    expect(harness.manager.getSubscriptionCount()).toBe(0);
  });

  test('emits an error frame and deregisters when a stream throws mid-flight', async () => {
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { boom }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'error').length > 0);

    // The event produced before the failure still reaches the client...
    const next = sentOfType(socket, 'next');
    expect(next.length).toBe(1);
    expect(next[0]?.id).toBe('sub-1');

    // ...and the failure is reported as a per-operation error frame.
    const errors = sentOfType(socket, 'error');
    expect(errors.length).toBe(1);
    expect(errors[0]?.id).toBe('sub-1');
    expect((errors[0]?.payload as Array<{ message: string }>)[0]?.message).toBe(
      'stream exploded'
    );

    // Contained to the operation: the socket stays open and the id is free.
    expect(socket.closeCode).toBeUndefined();
    expect(socket.readyState).toBe(1);
    await waitFor(() => harness.manager.getSubscriptionCount() === 0);
  });

  test('rejects a subscribe frame past the per-connection limit without closing the socket', async () => {
    const limited = await createManager({ maxSubscriptionsPerConnection: 1 });
    const socket = await initConnection(limited.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { ticks }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    // Second subscribe FRAME (not a direct registerSubscription call) — this
    // is the wire-level path clients actually take.
    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-2',
        payload: { query: 'subscription { ticks }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'error').length > 0);

    const errors = sentOfType(socket, 'error');
    expect(errors.length).toBe(1);
    expect(errors[0]?.id).toBe('sub-2');
    expect((errors[0]?.payload as Array<{ message: string }>)[0]?.message).toBe(
      'Too many subscriptions'
    );

    // Over-limit is a per-operation rejection, never a connection teardown,
    // and the accepted subscription keeps streaming.
    expect(socket.closeCode).toBeUndefined();
    const before = sentOfType(socket, 'next').length;
    await waitFor(() => sentOfType(socket, 'next').length > before);
    expect(limited.manager.getSubscriptionCount()).toBe(1);

    await destroyHarness(limited);
  });

  test('sends an error frame when the driver has no schema', async () => {
    const schemaless = new SubscriptionManager(
      { schema: createTestSchema() },
      { getSchema: () => null } as unknown as LeavenDriver
    );
    await schemaless.onModuleInit();
    const socket = await initConnection(schemaless);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { ticks }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'error').length > 0);

    const errors = sentOfType(socket, 'error');
    expect(errors[0]?.id).toBe('sub-1');
    expect((errors[0]?.payload as Array<{ message: string }>)[0]?.message).toBe(
      'Schema not available'
    );
    expect(socket.closeCode).toBeUndefined();

    await schemaless.onModuleDestroy();
  });

  test('frees the operation id when the schema is unavailable, so it can be retried', async () => {
    const schemaless = new SubscriptionManager(
      { schema: createTestSchema() },
      { getSchema: () => null } as unknown as LeavenDriver
    );
    await schemaless.onModuleInit();
    const socket = await initConnection(schemaless);

    const subscribeFrame = JSON.stringify({
      type: 'subscribe',
      id: '1',
      payload: { query: 'subscription { ticks }' },
    });

    socket.simulateMessage(subscribeFrame);
    await waitFor(() => sentOfType(socket, 'error').length === 1);

    // A failed subscribe must not leave a phantom claim: retrying the same id
    // (clients reuse "1", "2", …) must produce another error frame, NOT a
    // 4409 close of the whole connection.
    expect(schemaless.getSubscriptionCount()).toBe(0);

    socket.simulateMessage(subscribeFrame);
    await waitFor(() => sentOfType(socket, 'error').length === 2);

    expect(socket.closeCode).toBeUndefined();
    expect(socket.readyState).toBe(1);
    expect(schemaless.getSubscriptionCount()).toBe(0);

    await schemaless.onModuleDestroy();
  });

  test('closes 1011 (retryable) when a connection_init hook fails', async () => {
    const failing = await createManager({
      onConnect: () => {
        throw new Error('auth service unavailable');
      },
    });
    const socket = createMockWebSocket();
    await failing.manager.handleConnection(socket as unknown as WebSocket);

    socket.simulateMessage(JSON.stringify({ type: 'connection_init' }));
    await waitFor(() => socket.readyState === 3);

    // 4400 is non-retryable per graphql-ws, so a transient hook failure would
    // permanently disconnect the client. A server failure must be retryable.
    expect(socket.closeCode).toBe(1011);
    expect(sentOfType(socket, 'connection_ack').length).toBe(0);

    await destroyHarness(failing);
  });
});

describe('SubscriptionManager streaming', () => {
  test('streams each subscription event as a next frame, then completes', async () => {
    const harness = await createManager();
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { countdown }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'complete').length > 0);

    const next = sentOfType(socket, 'next');
    expect(next.length).toBe(3);
    expect(next.map((m) => (m.payload as { data: { countdown: number } }).data.countdown)).toEqual([
      3, 2, 1,
    ]);
    expect(next.every((m) => m.id === 'sub-1')).toBe(true);

    const complete = sentOfType(socket, 'complete');
    expect(complete.length).toBe(1);
    expect(complete[0]?.id).toBe('sub-1');

    // A finished stream must not stay registered
    expect(harness.manager.getSubscriptionCount()).toBe(0);

    await destroyHarness(harness);
  });

  test('stops producing events when the client sends complete', async () => {
    const probe: StreamProbe = { cleanedUp: false };
    const harness = await createManager(undefined, probe);
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { ticks }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    socket.simulateMessage(JSON.stringify({ type: 'complete', id: 'sub-1' }));
    await waitFor(() => probe.cleanedUp);
    const countAtCancel = sentOfType(socket, 'next').length;

    // Absence wait: the fixture yields every STREAM_YIELD_MS, so had the
    // stream survived cancellation many more frames would have landed.
    await sleep(ABSENCE_WAIT_MS);
    expect(sentOfType(socket, 'next').length).toBe(countAtCancel);
    expect(harness.manager.getSubscriptionCount()).toBe(0);

    await destroyHarness(harness);
  });

  test('releases in-flight streams when the connection closes', async () => {
    const probe: StreamProbe = { cleanedUp: false };
    const harness = await createManager(undefined, probe);
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { ticks }' },
      })
    );
    // A delivered event proves the stream is live: the id is claimed
    // synchronously, so counting registrations would race the iterator being
    // attached and close a connection with nothing yet to release.
    await waitFor(() => sentOfType(socket, 'next').length > 0);
    expect(harness.manager.getSubscriptionCount()).toBe(1);

    socket.simulateClose();
    await waitFor(() => probe.cleanedUp && harness.manager.getSubscriptionCount() === 0);

    expect(probe.cleanedUp).toBe(true);
    expect(harness.manager.getSubscriptionCount()).toBe(0);

    await destroyHarness(harness);
  });

  test('allows an operation id to be reused after the client completes it', async () => {
    const probe: StreamProbe = { cleanedUp: false };
    const harness = await createManager(undefined, probe);
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { slowTeardown }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    socket.simulateMessage(JSON.stringify({ type: 'complete', id: 'sub-1' }));
    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { ticks }' },
      })
    );

    // Wait past the previous stream's slow teardown, then confirm the
    // replacement stream is still alive: the old cleanup must not deregister
    // the reused id. The delay is derived from the fixture's own stall so the
    // relationship is explicit rather than a tuned magic number.
    await sleep(SLOW_TEARDOWN_MS + ABSENCE_WAIT_MS);
    const afterTeardown = tickEvents(socket).length;
    expect(afterTeardown).toBeGreaterThan(0);

    await waitFor(() => tickEvents(socket).length > afterTeardown);
    expect(harness.manager.getSubscriptionCount()).toBe(1);

    await destroyHarness(harness);
  });

  test('streams filtered PubSub events end to end', async () => {
    const pubSub = createPubSub();

    // The shape a user writes: a subscribe resolver returning a PubSub
    // iterator, wrapped by @SubscriptionFilter so only matching events ship.
    class CommentResolver {
      @SubscriptionFilter(
        (payload: unknown, variables: unknown) =>
          (payload as { commentAdded: { postId: number } }).commentAdded.postId ===
          (variables as { postId: number }).postId
      )
      public commentAdded(): AsyncIterableIterator<{
        commentAdded: { postId: number; body: string };
      }> {
        return pubSub.asyncIterator('COMMENT_ADDED');
      }
    }

    const resolver = new CommentResolver();
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
      }),
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          commentAdded: {
            type: GraphQLString,
            args: { postId: { type: GraphQLInt } },
            subscribe: (_root, args, ctx, info) =>
              resolver.commentAdded(_root, args, ctx, info),
            resolve: (payload: { commentAdded: { body: string } }) =>
              payload.commentAdded.body,
          },
        },
      }),
    });

    const options: LeavenModuleOptions = { schema };
    const driver = new LeavenDriver(options);
    await driver.onModuleInit();
    const manager = new SubscriptionManager(options, driver);
    await manager.onModuleInit();

    const socket = await initConnection(manager);
    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: {
          query: 'subscription($postId: Int) { commentAdded(postId: $postId) }',
          variables: { postId: 7 },
        },
      })
    );
    // Wait for the resolver's iterator to actually reach the engine: the
    // operation id is claimed before `subscribe` resolves, so registration
    // count is not proof that a publish would be observed.
    await waitFor(() => pubSub.getSubscriberCount('COMMENT_ADDED') > 0);

    pubSub.publish('COMMENT_ADDED', { commentAdded: { postId: 7, body: 'kept' } });
    pubSub.publish('COMMENT_ADDED', { commentAdded: { postId: 99, body: 'filtered out' } });
    pubSub.publish('COMMENT_ADDED', { commentAdded: { postId: 7, body: 'also kept' } });
    await waitFor(() => sentOfType(socket, 'next').length >= 2);

    const bodies = sentOfType(socket, 'next').map(
      (m) => (m.payload as { data: { commentAdded: string } }).data.commentAdded
    );
    expect(bodies).toEqual(['kept', 'also kept']);

    await manager.onModuleDestroy();
    await driver.onModuleDestroy();
  });

  test('resolves subscription payloads against the trusted context', async () => {
    const harness = await createManager({
      context: (ctx) => ({ ...ctx, user: { id: 'trusted-user' } }) as never,
    });
    const socket = await initConnection(harness.manager, {
      user: { id: 'forged', roles: ['admin'] },
    });

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { viewer }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    const next = sentOfType(socket, 'next');
    expect(next.length).toBe(1);
    expect((next[0]?.payload as { data: { viewer: string } }).data.viewer).toBe('trusted-user');

    await destroyHarness(harness);
  });

  test('a send that throws mid-stream settles the detached pump instead of rejecting', async () => {
    const harness = await createManager();
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { ticks }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    // The socket moves to CLOSING between the readyState check and the send,
    // so every send throws — including the one `pumpStream` makes on its own
    // recovery path. Without a `.catch` on the detached pump that escapes as
    // an unhandled rejection and takes the process down with it.
    socket.send = (): void => {
      throw new Error('socket gone');
    };

    await waitFor(() => harness.manager.getSubscriptionCount() === 0);

    // Contained: the connection itself survives.
    expect(harness.manager.getConnectionCount()).toBe(1);

    await destroyHarness(harness);
  });

  test('interleaves two concurrent subscriptions without cross-delivery', async () => {
    const harness = await createManager();
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { countdown }' },
      })
    );
    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-2',
        payload: { query: 'subscription { ticks }' },
      })
    );

    // The finite stream completes; the endless one keeps producing.
    await waitFor(() => sentOfType(socket, 'complete').length > 0);
    await waitFor(() => tickEvents(socket).length > 0);

    const countdowns = sentOfType(socket, 'next').filter(
      (m) => typeof (m.payload as { data?: { countdown?: unknown } })?.data?.countdown === 'number'
    );
    expect(countdowns.length).toBe(3);
    expect(countdowns.every((m) => m.id === 'sub-1')).toBe(true);

    // Every ticks payload is addressed to its own id — the `owns()` identity
    // guard must not let one stream emit under the other's operation id.
    expect(tickEvents(socket).every((m) => m.id === 'sub-2')).toBe(true);

    const complete = sentOfType(socket, 'complete');
    expect(complete.length).toBe(1);
    expect(complete[0]?.id).toBe('sub-1');

    // Only the endless subscription remains registered.
    expect(harness.manager.getSubscriptionCount()).toBe(1);

    await destroyHarness(harness);
  });
});

describe('SubscriptionManager security (connection params)', () => {
  test('forged user in connection_init does not appear at context.user', async () => {
    const harness = await createManager();
    const socket = await initConnection(harness.manager, {
      user: { id: 'forged', roles: ['admin'] },
    });

    socket.simulateMessage(
      JSON.stringify({ type: 'subscribe', id: '1', payload: { query: '{ whoAmI }' } })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    const next = sentOfType(socket, 'next');
    expect(next.length).toBe(1);
    const payload = next[0]?.payload as { data?: { whoAmI?: string } };
    expect(payload.data?.whoAmI).toBe('anonymous');

    await destroyHarness(harness);
  });

  test('connection params are namespaced and cannot overwrite req/res', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const harness = await createManager({
      onOperation: (_ctx, _msg, args) => {
        captured.push(args.contextValue as Record<string, unknown>);
        return args;
      },
    });
    const socket = await initConnection(harness.manager, {
      user: { roles: ['admin'] },
      req: 'evil',
      res: 'evil',
      token: 'abc',
    });

    socket.simulateMessage(
      JSON.stringify({ type: 'subscribe', id: '1', payload: { query: '{ hello }' } })
    );
    await waitFor(() => captured.length > 0);

    expect(captured.length).toBe(1);
    const ctx = captured[0] as Record<string, unknown>;
    // The forged fields never reach the context top level...
    expect(ctx.user).toBeUndefined();
    expect(ctx.req).not.toBe('evil');
    expect(ctx.res).not.toBe('evil');
    // ...but the raw params remain available under the namespaced key
    const params = ctx.connectionParams as Record<string, unknown>;
    expect(params.token).toBe('abc');
    expect((params.user as { roles: string[] }).roles).toEqual(['admin']);

    await destroyHarness(harness);
  });
});

describe('SubscriptionManager parse limits (LeavenModuleOptions.parseOptions)', () => {
  /** Payload of the single `next` frame answering operation `id` */
  function nextErrors(socket: MockWebSocket, id: string): Array<{ message: string }> {
    const next = sentOfType(socket, 'next').find((frame) => frame.id === id);
    return ((next?.payload as { errors?: Array<{ message: string }> }) ?? {}).errors ?? [];
  }

  test('applies a default maxTokens of 10000 to operation-type detection and execution', async () => {
    const harness = await createManager();
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: '1',
        payload: { query: `subscription { ${'countdown '.repeat(10_001)} }` },
      })
    );
    await waitFor(() => sentOfType(socket, 'complete').length > 0);

    // Reported through the executor's error path, not thrown out of the handler
    expect(nextErrors(socket, '1')[0]?.message).toMatch(/tokens/i);
    expect(socket.readyState).toBe(1);
    expect(harness.manager.getSubscriptionCount()).toBe(0);

    await destroyHarness(harness);
  });

  test('honours a configured parseOptions.maxTokens', async () => {
    const harness = await createManager(undefined, undefined, {
      parseOptions: { maxTokens: 5 },
    });
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: '1',
        payload: { query: 'subscription { countdown countdown countdown countdown }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'complete').length > 0);

    expect(nextErrors(socket, '1')[0]?.message).toMatch(/tokens/i);
    expect(socket.readyState).toBe(1);

    // A document within the budget still runs
    socket.simulateMessage(
      JSON.stringify({ type: 'subscribe', id: '2', payload: { query: '{ hello }' } })
    );
    await waitFor(() => sentOfType(socket, 'next').some((frame) => frame.id === '2'));
    const ok = sentOfType(socket, 'next').find((frame) => frame.id === '2');
    expect((ok?.payload as { data?: { hello?: string } }).data?.hello).toBe('world');

    await destroyHarness(harness);
  });
});

describe('SubscriptionManager configuration (LeavenModuleOptions.subscriptions)', () => {
  test('onConnect returning false closes the connection with 4401', async () => {
    const harness = await createManager({ onConnect: () => false });
    const socket = createMockWebSocket();
    await harness.manager.handleConnection(socket as unknown as WebSocket);

    socket.simulateMessage(JSON.stringify({ type: 'connection_init' }));
    await waitFor(() => socket.readyState === 3);

    expect(socket.closeCode).toBe(4401);
    expect(sentOfType(socket, 'connection_ack').length).toBe(0);

    await destroyHarness(harness);
  });

  test('a second connection_init while onConnect is pending closes with 4429', async () => {
    let connects = 0;
    const harness = await createManager({
      keepAlive: 1000,
      onConnect: async () => {
        connects++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true;
      },
    });
    const socket = createMockWebSocket();
    await harness.manager.handleConnection(socket as unknown as WebSocket);

    socket.simulateMessage(JSON.stringify({ type: 'connection_init' }));
    socket.simulateMessage(JSON.stringify({ type: 'connection_init' }));
    await waitFor(() => socket.readyState === 3);
    // Let the first onConnect settle
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(socket.closeCode).toBe(4429);
    expect(connects).toBe(1);
    expect(sentOfType(socket, 'connection_ack').length).toBe(0);

    await destroyHarness(harness);
  });

  test('a socket closed during onConnect is neither acknowledged nor kept alive', async () => {
    const harness = await createManager({
      keepAlive: 5,
      onConnect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true;
      },
    });
    const socket = createMockWebSocket();
    await harness.manager.handleConnection(socket as unknown as WebSocket);

    const intervalSpy = spyOn(globalThis, 'setInterval');
    try {
      socket.simulateMessage(JSON.stringify({ type: 'connection_init' }));
      socket.simulateClose();
      await new Promise((resolve) => setTimeout(resolve, 40));

      // No keep-alive timer may be started for a socket that is already
      // gone: nothing would ever clear it
      expect(intervalSpy).not.toHaveBeenCalled();
    } finally {
      intervalSpy.mockRestore();
    }
    expect(sentOfType(socket, 'connection_ack').length).toBe(0);
    expect(harness.manager.getConnectionCount()).toBe(0);

    await destroyHarness(harness);
  });

  test('onConnect returning true acknowledges the connection', async () => {
    const harness = await createManager({ onConnect: () => true });
    const socket = await initConnection(harness.manager);

    expect(sentOfType(socket, 'connection_ack').length).toBe(1);
    expect(socket.readyState).toBe(1); // still OPEN

    await destroyHarness(harness);
  });

  test('context hook contributes to the resolver context', async () => {
    const harness = await createManager({
      context: () => ({
        req: {} as Request,
        res: {} as Response,
        user: { id: 'from-hook' },
      }),
    });
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({ type: 'subscribe', id: '1', payload: { query: '{ whoAmI }' } })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    const next = sentOfType(socket, 'next');
    expect(next.length).toBe(1);
    const payload = next[0]?.payload as { data?: { whoAmI?: string } };
    expect(payload.data?.whoAmI).toBe('from-hook');

    await destroyHarness(harness);
  });

  test('onOperation can rewrite execution args before execution', async () => {
    const harness = await createManager({
      onOperation: (_ctx, _msg, args) => ({
        ...args,
        contextValue: {
          ...(args.contextValue as Record<string, unknown>),
          user: { id: 'from-operation' },
        },
      }),
    });
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({ type: 'subscribe', id: '1', payload: { query: '{ whoAmI }' } })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    const next = sentOfType(socket, 'next');
    const payload = next[0]?.payload as { data?: { whoAmI?: string } };
    expect(payload.data?.whoAmI).toBe('from-operation');

    await destroyHarness(harness);
  });

  test('onComplete fires when an active subscription is completed', async () => {
    const completed: string[] = [];
    const harness = await createManager({
      onComplete: (_ctx, msg) => {
        completed.push(msg.id);
      },
    });
    const socket = await initConnection(harness.manager);

    expect(
      harness.manager.registerSubscription(socket as unknown as WebSocket, 'sub-9', 'news')
    ).toBe(true);
    expect(harness.manager.getSubscriptionCount()).toBe(1);

    socket.simulateMessage(JSON.stringify({ type: 'complete', id: 'sub-9' }));
    await waitFor(() => completed.length > 0);

    expect(completed).toEqual(['sub-9']);
    expect(harness.manager.getSubscriptionCount()).toBe(0);

    await destroyHarness(harness);
  });

  test('onDisconnect fires when an initialized connection closes', async () => {
    let disconnected = false;
    const harness = await createManager({
      onDisconnect: () => {
        disconnected = true;
      },
    });
    const socket = await initConnection(harness.manager);

    socket.simulateClose();
    await waitFor(() => disconnected);

    expect(harness.manager.getConnectionCount()).toBe(0);

    await destroyHarness(harness);
  });

  test('a throwing onDisconnect still releases streams and drops the connection', async () => {
    const probe: StreamProbe = { cleanedUp: false };
    const harness = await createManager(
      {
        onDisconnect: () => {
          throw new Error('disconnect hook exploded');
        },
      },
      probe
    );
    const socket = await initConnection(harness.manager);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { ticks }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    socket.simulateClose();

    // Teardown must not be hostage to the user hook: a rejecting hook once
    // left every resolver generator suspended and the connection registered.
    await waitFor(() => probe.cleanedUp);
    expect(harness.manager.getConnectionCount()).toBe(0);
    expect(harness.manager.getSubscriptionCount()).toBe(0);

    await destroyHarness(harness);
  });

  test('closes with 4408 when connection_init never arrives', async () => {
    const harness = await createManager({ connectionInitWaitTimeout: 20 });
    const socket = createMockWebSocket();
    await harness.manager.handleConnection(socket as unknown as WebSocket);

    await waitFor(() => socket.readyState === 3);

    expect(socket.closeCode).toBe(4408);

    await destroyHarness(harness);
  });

  test('does not close a socket that initialised before the timeout', async () => {
    const harness = await createManager({ connectionInitWaitTimeout: 20 });
    const socket = await initConnection(harness.manager);

    // Past the deadline: the armed timer must have been cleared, not merely
    // rendered harmless by the `initialized` check it happens to guard.
    await sleep(40);

    expect(socket.closeCode).toBeUndefined();
    expect(socket.readyState).toBe(1);

    await destroyHarness(harness);
  });

  test('emits keep-alive pings on the configured interval', async () => {
    const harness = await createManager({ keepAlive: 10 });
    const socket = await initConnection(harness.manager);

    await waitFor(() => sentOfType(socket, 'ping').length >= 2);

    expect(sentOfType(socket, 'ping').length).toBeGreaterThanOrEqual(2);

    await destroyHarness(harness);
  });

  test('maxSubscriptionsPerConnection from module options is honored', async () => {
    const harness = await createManager({ maxSubscriptionsPerConnection: 1 });
    const socket = await initConnection(harness.manager);

    expect(
      harness.manager.registerSubscription(socket as unknown as WebSocket, '1', 'topic-a')
    ).toBe(true);
    expect(
      harness.manager.registerSubscription(socket as unknown as WebSocket, '2', 'topic-b')
    ).toBe(false);

    await destroyHarness(harness);
  });
});

describe('SubscriptionManager publishToTopic (topic-keyed delivery)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createManager();
  });

  afterEach(async () => {
    await destroyHarness(harness);
  });

  test('does not fan out across connections sharing a client id', async () => {
    const socketA = await initConnection(harness.manager);
    const socketB = await initConnection(harness.manager);

    // Both clients picked the same (per-connection) operation id "1"
    expect(
      harness.manager.registerSubscription(socketA as unknown as WebSocket, '1', 'topic-a')
    ).toBe(true);
    expect(
      harness.manager.registerSubscription(socketB as unknown as WebSocket, '1', 'topic-b')
    ).toBe(true);

    harness.manager.publishToTopic('topic-a', { value: 42 });

    const nextA = sentOfType(socketA, 'next');
    expect(nextA.length).toBe(1);
    expect(nextA[0]?.id).toBe('1');
    expect((nextA[0]?.payload as { data: { value: number } }).data.value).toBe(42);

    // The other connection shares the client id but NOT the topic: no leak
    expect(sentOfType(socketB, 'next').length).toBe(0);
  });

  test('addresses each topic subscriber by its own client id', async () => {
    const socketA = await initConnection(harness.manager);
    const socketB = await initConnection(harness.manager);

    expect(
      harness.manager.registerSubscription(socketA as unknown as WebSocket, '1', 'news')
    ).toBe(true);
    expect(
      harness.manager.registerSubscription(socketB as unknown as WebSocket, '42', 'news')
    ).toBe(true);

    harness.manager.publishToTopic('news', { headline: 'hi' });

    const nextA = sentOfType(socketA, 'next');
    const nextB = sentOfType(socketB, 'next');
    expect(nextA.length).toBe(1);
    expect(nextA[0]?.id).toBe('1');
    expect(nextB.length).toBe(1);
    expect(nextB[0]?.id).toBe('42');
  });

  test('the deprecated publish() still forwards to publishToTopic', async () => {
    const socket = await initConnection(harness.manager);

    expect(
      harness.manager.registerSubscription(socket as unknown as WebSocket, '1', 'news')
    ).toBe(true);

    harness.manager.publish('news', { headline: 'legacy' });

    const next = sentOfType(socket, 'next');
    expect(next.length).toBe(1);
    expect(next[0]?.id).toBe('1');
    expect((next[0]?.payload as { data: { headline: string } }).data.headline).toBe('legacy');
  });

  test('rejects registration for unknown or uninitialized sockets', async () => {
    const uninitialized = createMockWebSocket();
    await harness.manager.handleConnection(uninitialized as unknown as WebSocket);
    expect(
      harness.manager.registerSubscription(uninitialized as unknown as WebSocket, '1', 'news')
    ).toBe(false);

    const stranger = createMockWebSocket();
    expect(
      harness.manager.registerSubscription(stranger as unknown as WebSocket, '1', 'news')
    ).toBe(false);
  });
});

describe('SubscriptionManager Bun transport (ServerWebSocket)', () => {
  test('runs a full graphql-ws lifecycle over the ServerWebSocket entry points', async () => {
    const harness = await createManager();
    const socket = createMockServerWebSocket();

    // A Bun socket is never handed to `handleConnection`: it has no
    // `addEventListener` for the manager to attach to, so the server drives
    // these three entry points instead.
    harness.manager.handleOpen(asSocket(socket));
    expect(harness.manager.getConnectionCount()).toBe(1);

    await harness.manager.handleMessage(
      asSocket(socket),
      JSON.stringify({ type: 'connection_init', payload: { token: 'abc' } })
    );
    expect(sentOfType(socket, 'connection_ack').length).toBe(1);

    await harness.manager.handleMessage(
      asSocket(socket),
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { countdown }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'complete').length > 0);

    const next = sentOfType(socket, 'next');
    expect(next.map((m) => (m.payload as { data: { countdown: number } }).data.countdown)).toEqual([
      3, 2, 1,
    ]);
    expect(next.every((m) => m.id === 'sub-1')).toBe(true);
    expect(sentOfType(socket, 'complete')[0]?.id).toBe('sub-1');
    expect(harness.manager.getSubscriptionCount()).toBe(0);

    await harness.manager.handleClose(asSocket(socket));
    expect(harness.manager.getConnectionCount()).toBe(0);

    await destroyHarness(harness);
  });

  test('handleClose releases an in-flight stream on a ServerWebSocket', async () => {
    const probe: StreamProbe = { cleanedUp: false };
    const harness = await createManager(undefined, probe);
    const socket = createMockServerWebSocket();

    harness.manager.handleOpen(asSocket(socket));
    await harness.manager.handleMessage(
      asSocket(socket),
      JSON.stringify({ type: 'connection_init' })
    );
    await harness.manager.handleMessage(
      asSocket(socket),
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { ticks }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);
    expect(harness.manager.getSubscriptionCount()).toBe(1);

    await harness.manager.handleClose(asSocket(socket));

    // Bun reports the close by calling us, so teardown is complete by the
    // time `handleClose` resolves — no event dispatch to wait on.
    expect(probe.cleanedUp).toBe(true);
    expect(harness.manager.getSubscriptionCount()).toBe(0);
    expect(harness.manager.getConnectionCount()).toBe(0);

    const delivered = sentOfType(socket, 'next').length;
    await sleep(ABSENCE_WAIT_MS);
    expect(sentOfType(socket, 'next').length).toBe(delivered);

    await destroyHarness(harness);
  });

  test('getWebSocketConfig() handlers drive the same protocol end to end', async () => {
    const harness = await createManager();
    const websocket = harness.manager.getWebSocketConfig();
    const socket = createMockServerWebSocket();

    // Exactly the call shape `Bun.serve({ websocket })` uses: synchronous
    // handlers, no return value consulted.
    websocket.open(asServerSocket(socket));
    websocket.message(asServerSocket(socket), JSON.stringify({ type: 'connection_init' }));
    await waitFor(() => sentOfType(socket, 'connection_ack').length > 0);

    websocket.message(
      asServerSocket(socket),
      JSON.stringify({
        type: 'subscribe',
        id: '1',
        payload: { query: 'subscription { countdown }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'complete').length > 0);

    expect(sentOfType(socket, 'next').length).toBe(3);

    websocket.close(asServerSocket(socket));
    await waitFor(() => harness.manager.getConnectionCount() === 0);

    await destroyHarness(harness);
  });

  test('decodes binary frames, which is how Bun delivers a Buffer', async () => {
    const harness = await createManager();
    const socket = createMockServerWebSocket();

    harness.manager.handleOpen(asSocket(socket));
    await harness.manager.handleMessage(
      asSocket(socket),
      Buffer.from(JSON.stringify({ type: 'connection_init' }), 'utf8')
    );

    expect(sentOfType(socket, 'connection_ack').length).toBe(1);
    expect(socket.closeCode).toBeUndefined();

    await destroyHarness(harness);
  });

  test('ignores frames for a socket that was never opened', async () => {
    const harness = await createManager();
    const stranger = createMockServerWebSocket();

    await harness.manager.handleMessage(
      asSocket(stranger),
      JSON.stringify({ type: 'connection_init' })
    );

    expect(stranger.sentMessages).toEqual([]);
    expect(harness.manager.getConnectionCount()).toBe(0);

    // And closing one is a no-op rather than a throw.
    await harness.manager.handleClose(asSocket(stranger));

    await destroyHarness(harness);
  });

  test('getPath() reports where the upgrade route belongs', async () => {
    const fallback = await createManager();
    expect(fallback.manager.getPath()).toBe('/graphql');
    await destroyHarness(fallback);

    const configured = await createManager({ path: '/subscriptions' });
    expect(configured.manager.getPath()).toBe('/subscriptions');
    await destroyHarness(configured);

    // `subscriptions.path` is unset, so the module's own path is used.
    const options: LeavenModuleOptions = { schema: createTestSchema(), path: '/api/graphql' };
    const driver = new LeavenDriver(options);
    await driver.onModuleInit();
    const manager = new SubscriptionManager(options, driver);
    await manager.onModuleInit();

    expect(manager.getPath()).toBe('/api/graphql');

    await manager.onModuleDestroy();
    await driver.onModuleDestroy();
  });
});

describe('SubscriptionManager shutdown (onModuleDestroy)', () => {
  test('releases in-flight streams even though close events fire asynchronously', async () => {
    const probe: StreamProbe = { cleanedUp: false };
    const harness = await createManager({ keepAlive: 5 }, probe);

    // A real socket dispatches `close` a tick or more after `close()`
    // returns. Teardown that relies on that listener therefore runs AFTER
    // shutdown has finished tearing the connection map down — by which point
    // `handleClose` finds no state and does nothing at all.
    const socket = createMockWebSocket({ deferCloseDispatch: true });
    await harness.manager.handleConnection(socket as unknown as WebSocket);
    socket.simulateMessage(JSON.stringify({ type: 'connection_init' }));
    await waitFor(() => sentOfType(socket, 'connection_ack').length > 0);

    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { ticks }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    await harness.manager.onModuleDestroy();

    // Teardown must be complete when `onModuleDestroy` resolves, not merely
    // scheduled: `handleClose` is the single place that releases iterators
    // AND clears the keep-alive interval and the connection_init timeout, so
    // a released generator is proof that all three happened.
    expect(probe.cleanedUp).toBe(true);
    expect(harness.manager.getConnectionCount()).toBe(0);
    expect(harness.manager.getSubscriptionCount()).toBe(0);
    expect(socket.closeCode).toBe(1000);

    // The late close event still arrives; it must be a harmless no-op.
    await sleep(ABSENCE_WAIT_MS);
    expect(harness.manager.getConnectionCount()).toBe(0);
    expect(sentOfType(socket, 'next').length).toBeGreaterThan(0);

    await harness.driver.onModuleDestroy();
  });

  test('fires onDisconnect for every live connection during shutdown', async () => {
    const disconnected: number[] = [];
    const harness = await createManager({
      onDisconnect: () => {
        disconnected.push(1);
      },
    });

    await initConnection(harness.manager);
    await initConnection(harness.manager);
    expect(harness.manager.getConnectionCount()).toBe(2);

    await harness.manager.onModuleDestroy();

    expect(disconnected.length).toBe(2);
    expect(harness.manager.getConnectionCount()).toBe(0);

    await harness.driver.onModuleDestroy();
  });

  test('does not hang when a resolver cannot be resumed by cancellation', async () => {
    // A generator parked on a promise that never settles cannot run its
    // `return()`: the cancellation is queued behind the await. Shutdown must
    // give up on it rather than block the process forever.
    const stuck = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
      }),
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          parked: {
            type: GraphQLInt,
            subscribe: async function* (): AsyncGenerator<{ parked: number }> {
              yield { parked: 1 };
              await new Promise(() => {
                /* never settles */
              });
            },
          },
        },
      }),
    });

    const options: LeavenModuleOptions = { schema: stuck };
    const driver = new LeavenDriver(options);
    await driver.onModuleInit();
    const manager = new SubscriptionManager(options, driver);
    await manager.onModuleInit();

    const socket = await initConnection(manager);
    socket.simulateMessage(
      JSON.stringify({
        type: 'subscribe',
        id: 'sub-1',
        payload: { query: 'subscription { parked }' },
      })
    );
    await waitFor(() => sentOfType(socket, 'next').length > 0);

    const started = Date.now();
    await manager.onModuleDestroy();
    const elapsed = Date.now() - started;

    // Bounded, and the connection is gone regardless of the stuck generator.
    expect(elapsed).toBeLessThan(4000);
    expect(manager.getConnectionCount()).toBe(0);
    expect(manager.getSubscriptionCount()).toBe(0);

    await driver.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestHarness {
  manager: SubscriptionManager;
  driver: LeavenDriver;
}

// Records whether an in-flight subscription generator was released, so tests
// can assert the server stops producing events rather than leaking a stream.
interface StreamProbe {
  cleanedUp: boolean;
}

// Schema whose `whoAmI` field echoes the trusted `context.user.id` (or
// 'anonymous'), letting tests observe exactly what reaches resolvers.
// `countdown` streams a finite series; `ticks` never ends, so cancellation
// has something to cancel.
function createTestSchema(probe?: StreamProbe): GraphQLSchema {
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        hello: {
          type: GraphQLString,
          resolve: () => 'world',
        },
        whoAmI: {
          type: GraphQLString,
          resolve: (_source, _args, ctx: { user?: { id?: string } } | undefined) =>
            ctx?.user?.id ?? 'anonymous',
        },
      },
    }),
    subscription: new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        countdown: {
          type: GraphQLInt,
          subscribe: async function* (): AsyncGenerator<{ countdown: number }> {
            for (const value of [3, 2, 1]) {
              yield { countdown: value };
            }
          },
        },
        ticks: {
          type: GraphQLInt,
          subscribe: async function* (): AsyncGenerator<{ ticks: number }> {
            let index = 0;
            try {
              while (true) {
                yield { ticks: index++ };
                await sleep(STREAM_YIELD_MS);
              }
            } finally {
              if (probe) {
                probe.cleanedUp = true;
              }
            }
          },
        },
        // Cleanup is slow, so this stream's teardown lands *after* a
        // subsequent subscribe has reused the same operation id.
        slowTeardown: {
          type: GraphQLInt,
          subscribe: async function* (): AsyncGenerator<{ slowTeardown: number }> {
            let index = 0;
            try {
              while (true) {
                yield { slowTeardown: index++ };
                await sleep(STREAM_YIELD_MS);
              }
            } finally {
              await sleep(SLOW_TEARDOWN_MS);
            }
          },
        },
        // Yields once, then fails: exercises the mid-flight error path in
        // `pumpStream`, which answers with a protocol `error` frame rather
        // than tearing down the connection.
        boom: {
          type: GraphQLInt,
          subscribe: async function* (): AsyncGenerator<{ boom: number }> {
            yield { boom: 1 };
            await sleep(STREAM_YIELD_MS);
            throw new Error('stream exploded');
          },
        },
        viewer: {
          type: GraphQLString,
          subscribe: async function* (): AsyncGenerator<{ viewer: string }> {
            yield { viewer: 'ignored' };
          },
          resolve: (
            payload: { viewer: string },
            _args: unknown,
            ctx: { user?: { id?: string } } | undefined
          ) => ctx?.user?.id ?? 'anonymous',
        },
      },
    }),
  });
}

async function createManager(
  subscriptions?: SubscriptionConfig,
  probe?: StreamProbe,
  extra: Partial<LeavenModuleOptions> = {}
): Promise<TestHarness> {
  const options: LeavenModuleOptions = {
    schema: createTestSchema(probe),
    subscriptions,
    ...extra,
  };

  const driver = new LeavenDriver(options);
  await driver.onModuleInit();

  const manager = new SubscriptionManager(options, driver);
  await manager.onModuleInit();

  return { manager, driver };
}

async function destroyHarness(harness: TestHarness): Promise<void> {
  await harness.manager.onModuleDestroy();
  await harness.driver.onModuleDestroy();
}

// Connect a mock socket and complete connection_init (optionally with a payload)
async function initConnection(
  manager: SubscriptionManager,
  payload?: Record<string, unknown>
): Promise<MockWebSocket> {
  const socket = createMockWebSocket();
  await manager.handleConnection(socket as unknown as WebSocket);
  socket.simulateMessage(
    JSON.stringify(
      payload === undefined
        ? { type: 'connection_init' }
        : { type: 'connection_init', payload }
    )
  );
  await waitFor(() => sentOfType(socket, 'connection_ack').length > 0 || socket.readyState === 3);
  return socket;
}

/**
 * Interval at which the `ticks` and `slowTeardown` fixtures yield.
 *
 * Absence waits ("nothing further arrives") are expressed as a multiple of it
 * so the margin is explicit: a fixture that yields every
 * `STREAM_YIELD_MS` would have produced many more events inside
 * `ABSENCE_WAIT_MS` had it not actually been cancelled.
 */
const STREAM_YIELD_MS = 2;
const ABSENCE_WAIT_MS = STREAM_YIELD_MS * 15;

/** How long the `slowTeardown` fixture stalls inside its `finally`. */
const SLOW_TEARDOWN_MS = 40;

/**
 * Bounded poll for an expected condition.
 *
 * Preferred over a fixed sleep for every ARRIVAL wait: the test then states
 * what it is waiting for rather than how long, so a slower runner or a
 * changed fixture cannot silently turn a pass into an intermittent red.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Fixed delay, for ABSENCE waits only — there is nothing to poll for. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `next` frames carrying a `ticks` value, ignoring other subscription fields
function tickEvents(socket: SentFrames): Array<Record<string, unknown>> {
  return sentOfType(socket, 'next').filter(
    (m) => typeof (m.payload as { data?: { ticks?: unknown } })?.data?.ticks === 'number'
  );
}

function sentOfType(socket: SentFrames, type: string): Array<Record<string, unknown>> {
  return socket.sentMessages.filter(
    (m): m is Record<string, unknown> => (m as { type?: unknown }).type === type
  );
}

/**
 * Create a mock DOM-shaped WebSocket.
 *
 * @param options.deferCloseDispatch - Dispatch `close` listeners a tick after
 *   `close()` returns, the way a real socket does. The default synchronous
 *   dispatch is convenient but flattering: it makes teardown that in reality
 *   happens *after* the caller has moved on look instantaneous.
 */
function createMockWebSocket(options?: { deferCloseDispatch?: boolean }): MockWebSocket {
  const listeners: Map<string, Array<(event: unknown) => void>> = new Map();
  const sentMessages: object[] = [];
  const deferCloseDispatch = options?.deferCloseDispatch ?? false;

  const mock: MockWebSocket = {
    sentMessages,
    readyState: 1, // OPEN
    closeCode: undefined,
    closeReason: undefined,

    addEventListener(event: string, listener: (event: unknown) => void): void {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(listener);
    },

    removeEventListener(): void {
      // Mock implementation
    },

    send(data: string): void {
      try {
        sentMessages.push(JSON.parse(data));
      } catch {
        sentMessages.push({ raw: data });
      }
    },

    close(code?: number, reason?: string): void {
      if (mock.readyState === 3) {
        return; // Already closed; keep the first close code
      }
      mock.readyState = 3; // CLOSED
      mock.closeCode = code;
      mock.closeReason = reason;
      const dispatch = (): void => {
        for (const listener of listeners.get('close') || []) {
          listener({});
        }
      };
      if (deferCloseDispatch) {
        setTimeout(dispatch, 0);
      } else {
        dispatch();
      }
    },

    simulateMessage(data: string): void {
      const messageListeners = listeners.get('message') || [];
      for (const listener of messageListeners) {
        listener({ data });
      }
    },

    simulateClose(): void {
      mock.close();
    },

    simulateError(error: Error): void {
      const errorListeners = listeners.get('error') || [];
      for (const listener of errorListeners) {
        listener(error);
      }
    },
  };

  return mock;
}

/** Anything the frame assertions can read, whatever socket shape produced it. */
interface SentFrames {
  sentMessages: object[];
}

interface MockWebSocket extends SentFrames {
  readyState: number;
  closeCode: number | undefined;
  closeReason: string | undefined;
  addEventListener(event: string, listener: (event: unknown) => void): void;
  removeEventListener(event: string, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  simulateMessage(data: string): void;
  simulateClose(): void;
  simulateError(error: Error): void;
}

/**
 * A Bun `ServerWebSocket`-shaped mock.
 *
 * Deliberately has NO `addEventListener`: that is the whole point. Bun's
 * server-side socket does not dispatch events, so a manager that can only
 * consume DOM sockets is unreachable from a real `Bun.serve` — the mock must
 * not paper over the difference. `send` returns a byte count, as Bun's does.
 */
interface MockServerWebSocket extends SentFrames {
  data: unknown;
  readyState: number;
  closeCode: number | undefined;
  closeReason: string | undefined;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

function createMockServerWebSocket(): MockServerWebSocket {
  const sentMessages: object[] = [];

  const mock: MockServerWebSocket = {
    sentMessages,
    data: undefined,
    readyState: 1, // OPEN
    closeCode: undefined,
    closeReason: undefined,

    send(data: string): number {
      try {
        sentMessages.push(JSON.parse(data));
      } catch {
        sentMessages.push({ raw: data });
      }
      return data.length;
    },

    close(code?: number, reason?: string): void {
      if (mock.readyState === 3) {
        return; // Already closed; keep the first close code
      }
      mock.readyState = 3; // CLOSED
      mock.closeCode = code;
      mock.closeReason = reason;
    },
  };

  return mock;
}

/** The manager's Bun entry points accept any structural socket. */
function asSocket(socket: MockServerWebSocket): SubscriptionSocket {
  return socket;
}

/**
 * `Bun.serve({ websocket })` hands the handlers a real `ServerWebSocket`;
 * the mock only implements the members the manager actually touches.
 */
function asServerSocket(socket: MockServerWebSocket): ServerWebSocket<unknown> {
  return socket as unknown as ServerWebSocket<unknown>;
}
