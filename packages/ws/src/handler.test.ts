/**
 * @leaven-graphql/ws - WebSocket handler tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, spyOn } from 'bun:test';
import {
  GraphQLError,
  GraphQLInt,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';
import type { ServerWebSocket } from 'bun';
import { AuthenticationError, ErrorCode } from '@leaven-graphql/errors';
import {
  WebSocketHandler,
  createWebSocketHandler,
  type WebSocketContext,
  type WebSocketHandlerConfig,
} from './handler';
import type { SubscriptionManager } from './manager';

/** Records whether an iterator was released via return() */
interface IteratorProbe {
  returned: boolean;
}

/**
 * An async iterator whose next() never resolves, emulating a subscription
 * that stays open until it is torn down. The probe records the release so
 * tests can assert that teardown actually happened.
 */
function neverEndingIterator(
  probe: IteratorProbe = { returned: false }
): AsyncIterableIterator<unknown> {
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => new Promise<IteratorResult<unknown>>(() => {}),
    return: () => {
      probe.returned = true;
      return Promise.resolve({ value: undefined, done: true } as IteratorResult<unknown>);
    },
  };
}

/** A test-driven event source backing one `feed` subscription */
interface Feed {
  push(value: number): void;
  iterator: AsyncIterableIterator<unknown>;
}

/**
 * An iterator whose values are pushed by the test, so delivery to a specific
 * socket can be observed one event at a time.
 */
function createFeed(): Feed {
  const buffered: number[] = [];
  const pulls: Array<(result: IteratorResult<unknown>) => void> = [];
  let done = false;

  const finish = (): void => {
    done = true;
    while (pulls.length > 0) {
      pulls.shift()!({ value: undefined, done: true });
    }
  };

  return {
    push(value: number): void {
      if (done) return;
      const pull = pulls.shift();
      if (pull) {
        pull({ value: { feed: value }, done: false });
      } else {
        buffered.push(value);
      }
    },
    iterator: {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<unknown>> {
        if (buffered.length > 0) {
          return Promise.resolve({ value: { feed: buffered.shift()! }, done: false });
        }
        if (done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => pulls.push(resolve));
      },
      return(): Promise<IteratorResult<unknown>> {
        finish();
        return Promise.resolve({ value: undefined, done: true });
      },
    },
  };
}

/**
 * Builds a schema whose `forever` subscription appends one probe to `probes`
 * per subscribe call, and whose `feed` subscription appends one test-driven
 * event source to `feeds` — both in subscription order.
 */
function createTestSchema(
  probes: IteratorProbe[] = [],
  feeds: Feed[] = []
): GraphQLSchema {
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        hello: { type: GraphQLString, resolve: () => 'world' },
        boom: {
          type: GraphQLString,
          resolve: () => {
            throw new Error('resolver exploded');
          },
        },
      },
    }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: {
        echo: {
          type: GraphQLString,
          args: { value: { type: GraphQLString } },
          resolve: (_root, args: { value?: string }) => args.value ?? '',
        },
      },
    }),
    subscription: new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        count: {
          type: GraphQLInt,
          subscribe: async function* () {
            yield { count: 1 };
            yield { count: 2 };
            yield { count: 3 };
          },
        },
        forever: {
          type: GraphQLInt,
          subscribe: () => {
            const probe: IteratorProbe = { returned: false };
            probes.push(probe);
            return neverEndingIterator(probe);
          },
        },
        feed: {
          type: GraphQLInt,
          subscribe: () => {
            const feed = createFeed();
            feeds.push(feed);
            return feed.iterator;
          },
        },
        // Like `forever`, but the source stream takes 20ms to set up, which
        // leaves a window for the socket to close or the id to be completed
        slow: {
          type: GraphQLInt,
          subscribe: async () => {
            const probe: IteratorProbe = { returned: false };
            probes.push(probe);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return neverEndingIterator(probe);
          },
        },
      },
    }),
  });
}

/** Reach the handler's subscription manager for bookkeeping assertions */
function managerOf(handler: WebSocketHandler): SubscriptionManager {
  return (handler as unknown as { subscriptionManager: SubscriptionManager })
    .subscriptionManager;
}

interface Frame {
  type: string;
  id?: string;
  payload?: {
    data?: Record<string, unknown> | null;
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  } & Array<{ message: string; extensions?: Record<string, unknown> }>;
}

type TestSocket = ServerWebSocket<WebSocketContext> & {
  sent: string[];
  closed: { code: number; reason: string } | null;
};

function createFakeSocket(): TestSocket {
  const socket = {
    data: {
      connectionId: '',
      initialized: false,
      subscriptions: new Set<string>(),
    } as WebSocketContext,
    sent: [] as string[],
    closed: null as { code: number; reason: string } | null,
    send(message: string): number {
      socket.sent.push(message);
      return message.length;
    },
    close(code?: number, reason?: string): void {
      socket.closed = { code: code ?? 1000, reason: reason ?? '' };
    },
  };
  return socket as unknown as TestSocket;
}

function frames(socket: TestSocket): Frame[] {
  return socket.sent.map((raw) => JSON.parse(raw) as Frame);
}

function createHandler(
  overrides: Partial<WebSocketHandlerConfig> = {},
  probes: IteratorProbe[] = [],
  feeds: Feed[] = []
): WebSocketHandler {
  return createWebSocketHandler({
    schema: createTestSchema(probes, feeds),
    connectionInitTimeout: 100,
    keepAliveInterval: 0,
    ...overrides,
  });
}

async function openAndInit(
  handler: WebSocketHandler,
  socket: TestSocket
): Promise<void> {
  handler.handleOpen(socket);
  await handler.handleMessage(socket, '{"type":"connection_init"}');
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const SUBSCRIBE_COUNT =
  '{"id":"sub-1","type":"subscribe","payload":{"query":"subscription { count }"}}';
const SUBSCRIBE_FOREVER =
  '{"id":"sub-1","type":"subscribe","payload":{"query":"subscription { forever }"}}';
const SUBSCRIBE_SLOW =
  '{"id":"sub-1","type":"subscribe","payload":{"query":"subscription { slow }"}}';

describe('WebSocketHandler', () => {
  describe('handleOpen', () => {
    test('should initialize socket data with a UUID connection id', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      handler.handleOpen(socket);

      expect(socket.data.connectionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(socket.data.initialized).toBe(false);
      expect(socket.data.subscriptions.size).toBe(0);

      await handler.handleClose(socket);
    });

    test('should close with 4408 when connection_init never arrives', async () => {
      const handler = createHandler({ connectionInitTimeout: 20 });
      const socket = createFakeSocket();

      handler.handleOpen(socket);

      await waitFor(() => socket.closed !== null);

      expect(socket.closed?.code).toBe(4408);
    });

    test('should not close when connection_init arrives before the timeout', async () => {
      const handler = createHandler({ connectionInitTimeout: 20 });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(socket.closed).toBeNull();

      await handler.handleClose(socket);
    });
  });

  describe('connection_init', () => {
    test('should acknowledge and mark the connection initialized', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);

      expect(socket.data.initialized).toBe(true);
      expect(frames(socket)[0]?.type).toBe('connection_ack');

      await handler.handleClose(socket);
    });

    test('should store connection params', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      handler.handleOpen(socket);
      await handler.handleMessage(
        socket,
        '{"type":"connection_init","payload":{"token":"abc"}}'
      );

      expect(socket.data.connectionParams?.token).toBe('abc');

      await handler.handleClose(socket);
    });

    test('should close with 4403 when onConnect rejects the connection', async () => {
      const handler = createHandler({ onConnect: () => false });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);

      expect(socket.closed?.code).toBe(4403);
      expect(socket.data.initialized).toBe(false);
    });

    test('should close with 4429 on repeated connection_init', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(socket, '{"type":"connection_init"}');

      expect(socket.closed?.code).toBe(4429);
      expect(socket.closed?.reason).toMatch(/Too many initialisation requests/);
      // Only the first init is acknowledged
      expect(frames(socket).filter((f) => f.type === 'connection_ack').length).toBe(1);

      await handler.handleClose(socket);
    });
  });

  describe('connection_init races', () => {
    test('should close with 4429 on a second connection_init while onConnect is pending', async () => {
      let connects = 0;
      const handler = createHandler({
        onConnect: async () => {
          connects++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return true;
        },
      });
      const socket = createFakeSocket();
      handler.handleOpen(socket);

      // Bun dispatches back-to-back frames without awaiting the first
      const first = handler.handleMessage(socket, '{"type":"connection_init"}');
      const second = handler.handleMessage(socket, '{"type":"connection_init"}');

      expect(socket.closed?.code).toBe(4429);
      await Promise.all([first, second]);

      // onConnect ran once; the second init never reached it
      expect(connects).toBe(1);

      await handler.handleClose(socket);
    });

    test('should never start more than one keep-alive timer per connection', async () => {
      const intervalSpy = spyOn(globalThis, 'setInterval');
      try {
        const handler = createHandler({
          keepAliveInterval: 1000,
          onConnect: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return true;
          },
        });
        const socket = createFakeSocket();
        handler.handleOpen(socket);

        await Promise.all([
          handler.handleMessage(socket, '{"type":"connection_init"}'),
          handler.handleMessage(socket, '{"type":"connection_init"}'),
        ]);

        expect(intervalSpy.mock.calls.length).toBeLessThanOrEqual(1);

        await handler.handleClose(socket);
      } finally {
        intervalSpy.mockRestore();
      }
    });

    test('should neither ack nor start keep-alive when the socket closed during onConnect', async () => {
      const handler = createHandler({
        keepAliveInterval: 5,
        onConnect: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return true;
        },
      });
      const socket = createFakeSocket();
      handler.handleOpen(socket);

      const init = handler.handleMessage(socket, '{"type":"connection_init"}');
      await handler.handleClose(socket);
      await init;

      // Give a leaked keep-alive interval the chance to fire
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(frames(socket).some((f) => f.type === 'connection_ack')).toBe(false);
      expect(frames(socket).some((f) => f.type === 'ping')).toBe(false);
      expect(socket.data.initialized).toBe(false);
    });
  });

  describe('ping', () => {
    test('should respond to ping with pong', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      handler.handleOpen(socket);
      await handler.handleMessage(socket, '{"type":"ping"}');

      expect(frames(socket).some((f) => f.type === 'pong')).toBe(true);

      await handler.handleClose(socket);
    });
  });

  describe('keep-alive', () => {
    test('should send pings on the configured interval', async () => {
      const handler = createHandler({ keepAliveInterval: 10 });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await waitFor(() => frames(socket).some((f) => f.type === 'ping'));

      expect(frames(socket).filter((f) => f.type === 'ping').length).toBeGreaterThanOrEqual(1);

      await handler.handleClose(socket);
    });
  });

  describe('subscribe', () => {
    test('should close with 4401 when not initialized', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      handler.handleOpen(socket);
      await handler.handleMessage(socket, SUBSCRIBE_COUNT);

      expect(socket.closed?.code).toBe(4401);
    });

    test('should stream next messages and complete', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(socket, SUBSCRIBE_COUNT);
      await waitFor(() => frames(socket).some((f) => f.type === 'complete'));

      const nextFrames = frames(socket).filter((f) => f.type === 'next');
      expect(nextFrames.map((f) => f.payload?.data?.count)).toEqual([1, 2, 3]);
      expect(nextFrames.every((f) => f.id === 'sub-1')).toBe(true);

      const completeFrame = frames(socket).find((f) => f.type === 'complete');
      expect(completeFrame?.id).toBe('sub-1');
      expect(socket.data.subscriptions.size).toBe(0);
      expect(socket.closed).toBeNull();

      await handler.handleClose(socket);
    });

    test('should close with 4409 for concurrent subscribes with the same id', async () => {
      const handler = createHandler({
        onSubscribe: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);

      // Fire both without awaiting the first, as Bun does when the client
      // sends two frames back to back
      const first = handler.handleMessage(socket, SUBSCRIBE_FOREVER);
      const second = handler.handleMessage(socket, SUBSCRIBE_FOREVER);
      await Promise.all([first, second]);

      expect(socket.closed?.code).toBe(4409);
      expect(socket.closed?.reason).toMatch(/already exists/);

      await handler.handleClose(socket);
    });

    test('should send an Error message instead of closing when onSubscribe throws', async () => {
      const handler = createHandler({
        onSubscribe: () => {
          throw new Error('Rejected by hook');
        },
      });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(socket, SUBSCRIBE_FOREVER);

      expect(socket.closed).toBeNull();
      const errorFrame = frames(socket).find((f) => f.type === 'error');
      expect(errorFrame?.id).toBe('sub-1');
      expect(errorFrame?.payload?.[0]?.message).toBe('Rejected by hook');
      expect(socket.data.subscriptions.has('sub-1')).toBe(false);

      await handler.handleClose(socket);
    });

    test('should keep other subscriptions alive when the limit is exceeded', async () => {
      const handler = createHandler({
        subscriptionManager: { maxSubscriptionsPerConnection: 1 },
      });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(socket, SUBSCRIBE_FOREVER);
      await handler.handleMessage(
        socket,
        '{"id":"sub-2","type":"subscribe","payload":{"query":"subscription { forever }"}}'
      );

      // The connection stays open; only the offending id gets an Error message
      expect(socket.closed).toBeNull();
      const errorFrames = frames(socket).filter((f) => f.type === 'error');
      expect(errorFrames.length).toBe(1);
      expect(errorFrames[0]?.id).toBe('sub-2');
      expect(errorFrames[0]?.payload?.[0]?.message).toMatch(
        /Maximum subscriptions per connection reached/
      );
      expect(socket.data.subscriptions.has('sub-1')).toBe(true);
      expect(socket.data.subscriptions.has('sub-2')).toBe(false);

      await handler.handleClose(socket);
    });

    test('should send an Error message for validation failures', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(
        socket,
        '{"id":"sub-1","type":"subscribe","payload":{"query":"subscription { nonexistent }"}}'
      );

      expect(socket.closed).toBeNull();
      const errorFrame = frames(socket).find((f) => f.type === 'error');
      expect(errorFrame?.id).toBe('sub-1');
      expect(errorFrame?.payload?.[0]?.message).toMatch(/Cannot query field/);
      expect(socket.data.subscriptions.size).toBe(0);

      await handler.handleClose(socket);
    });
  });

  describe('subscribe after close', () => {
    test('should register nothing when the socket closed while the context was built', async () => {
      const probes: IteratorProbe[] = [];
      const handler = createHandler(
        {
          context: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {};
          },
        },
        probes
      );
      const socket = createFakeSocket();
      await openAndInit(handler, socket);

      const subscribing = handler.handleMessage(socket, SUBSCRIBE_FOREVER);
      await handler.handleClose(socket);
      const sentAtClose = socket.sent.length;
      await subscribing;

      // Either the source stream was never created or it was released
      expect(probes.every((probe) => probe.returned)).toBe(true);
      expect(managerOf(handler).subscriptionCount).toBe(0);
      expect(managerOf(handler).connectionCount).toBe(0);
      expect(socket.sent.length).toBe(sentAtClose);
    });

    test('should return the iterator when the socket closed during executor.subscribe', async () => {
      const probes: IteratorProbe[] = [];
      const handler = createHandler({}, probes);
      const socket = createFakeSocket();
      await openAndInit(handler, socket);

      const subscribing = handler.handleMessage(socket, SUBSCRIBE_SLOW);
      // Let the subscribe reach the (slow) source stream setup
      await waitFor(() => probes.length === 1);
      await handler.handleClose(socket);
      await subscribing;

      await waitFor(() => probes[0]!.returned);
      expect(probes[0]!.returned).toBe(true);
      expect(managerOf(handler).subscriptionCount).toBe(0);
      expect(managerOf(handler).connectionCount).toBe(0);
    });
  });

  describe('subscription id reuse', () => {
    test('should cancel a pending subscribe completed by the client before reusing its id', async () => {
      const probes: IteratorProbe[] = [];
      let contexts = 0;
      const handler = createHandler(
        {
          // Only the first operation is slow to build its context
          context: async () => {
            if (contexts++ === 0) {
              await new Promise((resolve) => setTimeout(resolve, 30));
            }
            return {};
          },
        },
        probes
      );
      const socket = createFakeSocket();
      await openAndInit(handler, socket);

      const first = handler.handleMessage(socket, SUBSCRIBE_FOREVER);
      await handler.handleMessage(socket, '{"id":"sub-1","type":"complete"}');
      await handler.handleMessage(socket, SUBSCRIBE_FOREVER);
      await first;

      // The cancelled first operation never created a source stream, and did
      // not overwrite the second one's registration
      expect(probes.length).toBe(1);
      expect(probes[0]!.returned).toBe(false);
      expect(managerOf(handler).subscriptionCount).toBe(1);
      expect(socket.data.subscriptions.has('sub-1')).toBe(true);
      expect(socket.closed).toBeNull();
      expect(frames(socket).some((f) => f.type === 'error')).toBe(false);

      // Nothing was orphaned: closing releases the one live stream
      await handler.handleClose(socket);
      await waitFor(() => probes[0]!.returned);
    });

    test('should return the iterator of a pending subscribe completed during executor.subscribe', async () => {
      const probes: IteratorProbe[] = [];
      const handler = createHandler({}, probes);
      const socket = createFakeSocket();
      await openAndInit(handler, socket);

      const first = handler.handleMessage(socket, SUBSCRIBE_SLOW);
      await waitFor(() => probes.length === 1);
      await handler.handleMessage(socket, '{"id":"sub-1","type":"complete"}');
      await handler.handleMessage(socket, SUBSCRIBE_FOREVER);
      await first;

      await waitFor(() => probes[0]!.returned);
      expect(probes.length).toBe(2);
      expect(probes[1]!.returned).toBe(false);
      expect(managerOf(handler).subscriptionCount).toBe(1);
      expect(managerOf(handler).getSubscription(socket.data.connectionId, 'sub-1')?.request.query).toBe(
        'subscription { forever }'
      );

      await handler.handleClose(socket);
    });

    test('should count pending subscriptions against maxSubscriptionsPerConnection', async () => {
      let contexts = 0;
      const handler = createHandler({
        subscriptionManager: { maxSubscriptionsPerConnection: 1 },
        context: async () => {
          contexts++;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {};
        },
      });
      const socket = createFakeSocket();
      await openAndInit(handler, socket);

      await Promise.all([
        handler.handleMessage(socket, SUBSCRIBE_FOREVER),
        handler.handleMessage(
          socket,
          '{"id":"sub-2","type":"subscribe","payload":{"query":"subscription { forever }"}}'
        ),
      ]);

      // The second was refused before any work was done for it
      expect(contexts).toBe(1);
      const errorFrames = frames(socket).filter((f) => f.type === 'error');
      expect(errorFrames.map((f) => f.id)).toEqual(['sub-2']);
      expect(errorFrames[0]?.payload?.[0]?.message).toMatch(
        /Maximum subscriptions per connection reached/
      );
      expect(socket.data.subscriptions.has('sub-1')).toBe(true);
      expect(socket.data.subscriptions.has('sub-2')).toBe(false);

      await handler.handleClose(socket);
    });
  });

  describe('query and mutation operations', () => {
    // graphql-ws carries EVERY operation on a Subscribe frame; a query or
    // mutation gets a single Next followed by Complete
    test('should answer a query with one next then complete', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(
        socket,
        '{"id":"q1","type":"subscribe","payload":{"query":"{ hello }"}}'
      );

      const operationFrames = frames(socket).filter((f) => f.id === 'q1');
      expect(operationFrames.map((f) => f.type)).toEqual(['next', 'complete']);
      expect(operationFrames[0]?.payload?.data?.hello).toBe('world');
      // Never the "Schema is not configured to execute subscription
      // operation." error from routing a query into subscribe()
      expect(frames(socket).some((f) => f.type === 'error')).toBe(false);
      expect(socket.closed).toBeNull();
      expect(socket.data.subscriptions.size).toBe(0);

      await handler.handleClose(socket);
    });

    test('should answer a mutation with one next then complete', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(
        socket,
        '{"id":"m1","type":"subscribe","payload":{"query":"mutation { echo(value: \\"hi\\") }"}}'
      );

      const operationFrames = frames(socket).filter((f) => f.id === 'm1');
      expect(operationFrames.map((f) => f.type)).toEqual(['next', 'complete']);
      expect(operationFrames[0]?.payload?.data?.echo).toBe('hi');

      await handler.handleClose(socket);
    });

    test('should select the operation named by the payload', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(
        socket,
        '{"id":"q1","type":"subscribe","payload":{"operationName":"Greet",' +
          '"query":"subscription Live { count } query Greet { hello }"}}'
      );

      const operationFrames = frames(socket).filter((f) => f.id === 'q1');
      expect(operationFrames.map((f) => f.type)).toEqual(['next', 'complete']);
      expect(operationFrames[0]?.payload?.data?.hello).toBe('world');

      await handler.handleClose(socket);
    });

    test('should report resolver errors inside next, then complete', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(
        socket,
        '{"id":"q1","type":"subscribe","payload":{"query":"{ boom }"}}'
      );

      const operationFrames = frames(socket).filter((f) => f.id === 'q1');
      expect(operationFrames.map((f) => f.type)).toEqual(['next', 'complete']);
      expect(operationFrames[0]?.payload?.errors?.[0]?.message).toBe('resolver exploded');

      await handler.handleClose(socket);
    });

    test('should send an Error message for a query that fails validation', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(
        socket,
        '{"id":"q1","type":"subscribe","payload":{"query":"{ nonexistent }"}}'
      );

      // graphql-ws: pre-execution failures are an Error message, not a Next
      // carrying errors followed by Complete
      const operationFrames = frames(socket).filter((f) => f.id === 'q1');
      expect(operationFrames.map((f) => f.type)).toEqual(['error']);
      expect(operationFrames[0]?.payload?.[0]?.message).toMatch(/Cannot query field/);
      expect(socket.closed).toBeNull();

      await handler.handleClose(socket);
    });

    test('should call onComplete after a query finishes', async () => {
      const completedIds: string[] = [];
      const handler = createHandler({
        onComplete: (_socket, id) => {
          completedIds.push(id);
        },
      });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(
        socket,
        '{"id":"q1","type":"subscribe","payload":{"query":"{ hello }"}}'
      );

      expect(completedIds).toEqual(['q1']);

      await handler.handleClose(socket);
    });
  });

  describe('operation type detection', () => {
    test('should parse with the executor limits, not an unbounded parse', async () => {
      const handler = createHandler({
        subscriptionManager: { executor: { parseOptions: { maxTokens: 5 } } },
      });
      const socket = createFakeSocket();
      await openAndInit(handler, socket);

      // Over the token budget long before the syntax error at the end: an
      // unbounded parse lexes the whole document and reports the syntax error
      await handler.handleMessage(
        socket,
        JSON.stringify({
          id: 'op-1',
          type: 'subscribe',
          payload: { query: `{ ${'hello '.repeat(50)} ) }` },
        })
      );

      const errorFrame = frames(socket).find((f) => f.type === 'error');
      expect(errorFrame?.id).toBe('op-1');
      expect(errorFrame?.payload?.[0]?.message).toMatch(/tokens/i);
      expect(socket.closed).toBeNull();

      await handler.handleClose(socket);
    });

    test('should still route queries through execute', async () => {
      const handler = createHandler({
        subscriptionManager: { executor: { parseOptions: { maxTokens: 50 } } },
      });
      const socket = createFakeSocket();
      await openAndInit(handler, socket);

      await handler.handleMessage(
        socket,
        '{"id":"op-1","type":"subscribe","payload":{"query":"{ hello }"}}'
      );

      const next = frames(socket).find((f) => f.type === 'next');
      expect(next?.payload?.data?.hello).toBe('world');
      expect(frames(socket).some((f) => f.type === 'complete')).toBe(true);

      await handler.handleClose(socket);
    });
  });

  describe('per-connection subscription ids', () => {
    // Reference graphql-ws clients number operations per connection starting
    // at "1", so two independent sockets routinely use the same id
    test('should isolate delivery and teardown for the same id on two sockets', async () => {
      const feeds: Feed[] = [];
      const handler = createHandler({}, [], feeds);
      const socketA = createFakeSocket();
      const socketB = createFakeSocket();
      const subscribeFeed =
        '{"id":"1","type":"subscribe","payload":{"query":"subscription { feed }"}}';

      await openAndInit(handler, socketA);
      await openAndInit(handler, socketB);
      await handler.handleMessage(socketA, subscribeFeed);
      await handler.handleMessage(socketB, subscribeFeed);

      expect(feeds.length).toBe(2);
      expect(socketA.data.connectionId).not.toBe(socketB.data.connectionId);

      // Each socket only sees its own events
      feeds[0]!.push(1);
      await waitFor(() => frames(socketA).some((f) => f.type === 'next'));
      expect(frames(socketB).some((f) => f.type === 'next')).toBe(false);

      // B unsubscribes; A shares only the operation id with it
      await handler.handleMessage(socketB, '{"id":"1","type":"complete"}');

      feeds[0]!.push(2);
      await waitFor(() => frames(socketA).filter((f) => f.type === 'next').length === 2);

      expect(
        frames(socketA)
          .filter((f) => f.type === 'next')
          .map((f) => f.payload?.data?.feed)
      ).toEqual([1, 2]);
      // A is neither completed nor errored by B's teardown
      expect(frames(socketA).some((f) => f.type === 'complete')).toBe(false);
      expect(frames(socketA).some((f) => f.type === 'error')).toBe(false);
      expect(socketA.data.subscriptions.has('1')).toBe(true);

      await handler.handleClose(socketA);
      await handler.handleClose(socketB);
    });

    test('should release only the closing socket iterator on disconnect', async () => {
      const probes: IteratorProbe[] = [];
      const handler = createHandler({}, probes);
      const socketA = createFakeSocket();
      const socketB = createFakeSocket();
      const subscribeForever =
        '{"id":"1","type":"subscribe","payload":{"query":"subscription { forever }"}}';

      await openAndInit(handler, socketA);
      await openAndInit(handler, socketB);
      await handler.handleMessage(socketA, subscribeForever);
      await handler.handleMessage(socketB, subscribeForever);

      expect(probes.length).toBe(2);

      await handler.handleClose(socketB);

      await waitFor(() => probes[1]!.returned);
      expect(probes[1]!.returned).toBe(true);
      expect(probes[0]!.returned).toBe(false);
      expect(socketA.data.subscriptions.has('1')).toBe(true);

      await handler.handleClose(socketA);
    });
  });

  describe('hook failures', () => {
    test('should not leave an unhandled rejection when onDisconnect rejects', async () => {
      const handler = createHandler({
        onDisconnect: async () => {
          throw new Error('onDisconnect boom');
        },
      });
      const socket = createFakeSocket();
      const config = handler.getWebSocketConfig();
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      try {
        config.open(socket);
        // Bun's close slot is `void`: a rejected promise dropped into it is
        // an unhandled rejection that aborts the process
        expect(config.close(socket)).toBeUndefined();
        await waitFor(() =>
          errorSpy.mock.calls.some((call) => String(call[0]).includes('onDisconnect'))
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    test('should not leave an unhandled rejection when onComplete rejects', async () => {
      const handler = createHandler({
        onComplete: async () => {
          throw new Error('onComplete boom');
        },
      });
      const socket = createFakeSocket();
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      try {
        await openAndInit(handler, socket);
        await handler.handleMessage(socket, SUBSCRIBE_FOREVER);
        await handler.handleMessage(socket, '{"id":"sub-1","type":"complete"}');

        await waitFor(() =>
          errorSpy.mock.calls.some((call) => String(call[0]).includes('onComplete'))
        );
        expect(socket.closed).toBeNull();
      } finally {
        errorSpy.mockRestore();
      }

      await handler.handleClose(socket);
    });

    test('should call onComplete when subscription setup fails', async () => {
      const completedIds: string[] = [];
      const handler = createHandler({
        onSubscribe: () => {
          throw new Error('Rejected by hook');
        },
        onComplete: (_socket, id) => {
          completedIds.push(id);
        },
      });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(socket, SUBSCRIBE_FOREVER);

      // The setup-failure path is terminal for the id, like the other three
      expect(frames(socket).some((f) => f.type === 'error')).toBe(true);
      expect(completedIds).toEqual(['sub-1']);

      await handler.handleClose(socket);
    });
  });

  describe('logger', () => {
    function recordingLogger(): {
      errors: unknown[][];
      warns: unknown[][];
      logger: { error(...args: unknown[]): void; warn(...args: unknown[]): void };
    } {
      const errors: unknown[][] = [];
      const warns: unknown[][] = [];
      return {
        errors,
        warns,
        logger: {
          error: (...args: unknown[]) => errors.push(args),
          warn: (...args: unknown[]) => warns.push(args),
        },
      };
    }

    test('should report hook failures through the injected logger, not console', async () => {
      const { errors, logger } = recordingLogger();
      const handler = createHandler({
        logger,
        onComplete: async () => {
          throw new Error('onComplete boom');
        },
      });
      const socket = createFakeSocket();
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      try {
        await openAndInit(handler, socket);
        await handler.handleMessage(socket, SUBSCRIBE_FOREVER);
        await handler.handleMessage(socket, '{"id":"sub-1","type":"complete"}');

        await waitFor(() => errors.some((call) => String(call[0]).includes('onComplete')));
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }

      await handler.handleClose(socket);
    });

    test('should report Bun callback failures through the injected logger', async () => {
      const { errors, logger } = recordingLogger();
      const handler = createHandler({
        logger,
        onDisconnect: async () => {
          throw new Error('onDisconnect boom');
        },
      });
      const socket = createFakeSocket();
      const config = handler.getWebSocketConfig();
      const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

      try {
        config.open(socket);
        config.close(socket);
        await waitFor(() => errors.some((call) => String(call[0]).includes('onDisconnect')));
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    test('should pass its logger to the subscription manager', async () => {
      const { warns, logger } = recordingLogger();
      const handler = createHandler({
        logger,
        subscriptionManager: { subscriptionTimeout: 10 },
      });
      const socket = createFakeSocket();
      const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await openAndInit(handler, socket);
        await handler.handleMessage(socket, SUBSCRIBE_FOREVER);
        await waitFor(() => warns.some((call) => String(call[0]).includes('timed out')));
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }

      await handler.handleClose(socket);
    });
  });

  describe('complete', () => {
    test('should unsubscribe when the client sends complete', async () => {
      const completedIds: string[] = [];
      const handler = createHandler({
        onComplete: (_socket, id) => {
          completedIds.push(id);
        },
      });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(socket, SUBSCRIBE_FOREVER);
      expect(socket.data.subscriptions.has('sub-1')).toBe(true);

      await handler.handleMessage(socket, '{"id":"sub-1","type":"complete"}');

      expect(socket.data.subscriptions.size).toBe(0);
      expect(completedIds).toEqual(['sub-1']);
      expect(socket.closed).toBeNull();

      await handler.handleClose(socket);
    });
  });

  describe('malformed messages', () => {
    test('should close with 4400 for invalid JSON', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      handler.handleOpen(socket);
      await handler.handleMessage(socket, 'not json');

      expect(socket.closed?.code).toBe(4400);
    });

    test('should close with 4400 and a protocol reason for non-object JSON', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      handler.handleOpen(socket);
      await handler.handleMessage(socket, 'null');

      expect(socket.closed?.code).toBe(4400);
      // A protocol message, not a leaked engine TypeError such as
      // "null is not an object (evaluating 'message.type')"
      expect(socket.closed?.reason).toBe('Message must be an object');
    });

    test('should close with 4400 for an unknown message type', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      handler.handleOpen(socket);
      await handler.handleMessage(socket, '{"type":"bogus"}');

      expect(socket.closed?.code).toBe(4400);
    });

    test('should close with 4400 for a subscribe frame without an id', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(
        socket,
        '{"type":"subscribe","payload":{"query":"subscription { count }"}}'
      );

      expect(socket.closed?.code).toBe(4400);
    });

    test.each(['evil\nINFO forged', 'x'.repeat(65), '', 'a b'])(
      'should close with 4400 "Invalid message" for subscribe id %p',
      async (id) => {
        const handler = createHandler();
        const socket = createFakeSocket();

        await openAndInit(handler, socket);
        await handler.handleMessage(
          socket,
          JSON.stringify({ id, type: 'subscribe', payload: { query: 'subscription { count }' } })
        );

        expect(socket.closed?.code).toBe(4400);
        expect(socket.closed?.reason).toBe('Invalid message');
      }
    );

    test('should close with 4400 "Invalid message" for a malformed complete id', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(socket, JSON.stringify({ id: 'a\r\nb', type: 'complete' }));

      expect(socket.closed?.code).toBe(4400);
      expect(socket.closed?.reason).toBe('Invalid message');
    });
  });

  describe('handleClose', () => {
    test('should tear down subscriptions and call onDisconnect', async () => {
      let disconnected = false;
      const probes: IteratorProbe[] = [];
      const handler = createHandler(
        {
          onDisconnect: () => {
            disconnected = true;
          },
        },
        probes
      );
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(socket, SUBSCRIBE_FOREVER);

      expect(socket.data.subscriptions.size).toBe(1);
      expect(probes.length).toBe(1);
      expect(probes[0]!.returned).toBe(false);

      await handler.handleClose(socket);

      expect(disconnected).toBe(true);
      // Teardown, not just the hook: the id is dropped and the underlying
      // iterator is actually released
      expect(socket.data.subscriptions.size).toBe(0);
      await waitFor(() => probes[0]!.returned);
      expect(probes[0]!.returned).toBe(true);
    });
  });

  describe('getWebSocketConfig', () => {
    test('should return open, message, and close handlers', () => {
      const handler = createHandler();
      const config = handler.getWebSocketConfig();

      expect(typeof config.open).toBe('function');
      expect(typeof config.message).toBe('function');
      expect(typeof config.close).toBe('function');
    });

    test('should drive the protocol through the Bun callbacks', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();
      const config = handler.getWebSocketConfig();

      config.open(socket);
      // The slot is `void`, so the ack lands on a later tick
      expect(config.message(socket, '{"type":"connection_init"}')).toBeUndefined();
      await waitFor(() => frames(socket).some((f) => f.type === 'connection_ack'));

      expect(socket.data.initialized).toBe(true);

      config.close(socket);
    });

    test('should not leave an unhandled rejection when message handling throws', async () => {
      const handler = createHandler();
      const socket = createFakeSocket();
      const realClose = socket.close;
      // A socket that cannot be closed makes the parse-failure path itself
      // throw, which is the only way handleMessage rejects
      socket.close = () => {
        throw new Error('socket already gone');
      };
      const config = handler.getWebSocketConfig();
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      try {
        config.open(socket);
        expect(config.message(socket, 'not json')).toBeUndefined();
        await waitFor(() =>
          errorSpy.mock.calls.some((call) =>
            String(call[0]).includes('WebSocket message handling failed')
          )
        );
      } finally {
        socket.close = realClose;
        errorSpy.mockRestore();
      }

      // Drop the pending init timeout, which would otherwise fire later and
      // close this socket from a timer stack
      await handler.handleClose(socket);
    });
  });
});

/**
 * A schema whose subscription sources fail in the ways the error-formatting
 * tests need: a source stream throwing a coded GraphQLError, one throwing a
 * raw Error, and an event whose resolver throws (an execution error inside a
 * `next` payload).
 */
function createFailingSchema(): GraphQLSchema {
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        hello: { type: GraphQLString, resolve: () => 'world' },
        boom: {
          type: GraphQLString,
          resolve: () => {
            throw new Error('redis://admin:hunter2@cache:6379 unreachable');
          },
        },
      },
    }),
    subscription: new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        forbidden: {
          type: GraphQLInt,
          subscribe: async function* () {
            yield { forbidden: 1 };
            throw new GraphQLError('Not allowed to watch this', {
              extensions: { code: ErrorCode.FORBIDDEN },
            });
          },
        },
        crashing: {
          type: GraphQLInt,
          subscribe: async function* () {
            yield { crashing: 1 };
            throw new Error('postgres://u:p@h/db stream reset');
          },
        },
        poisoned: {
          type: GraphQLInt,
          subscribe: async function* () {
            yield { poisoned: 1 };
          },
          resolve: () => {
            throw new Error('decrypt failed with key sk_live_123');
          },
        },
      },
    }),
  });
}

function subscribeFrame(id: string, query: string): string {
  return JSON.stringify({ id, type: 'subscribe', payload: { query } });
}

describe('error formatting', () => {
  const MASKED = 'An unexpected error occurred';

  test('should mask a context factory failure when maskErrors is on', async () => {
    const handler = createHandler({
      errorFormatting: { maskErrors: true },
      context: () => {
        throw new Error('postgres://u:p@h/db refused');
      },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, SUBSCRIBE_FOREVER);

    const errorFrame = frames(socket).find((f) => f.type === 'error');
    expect(errorFrame?.id).toBe('sub-1');
    expect(errorFrame?.payload?.[0]?.message).toBe(MASKED);
    expect(errorFrame?.payload?.[0]?.extensions?.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(socket.sent.join('')).not.toContain('postgres://');
    expect(socket.closed).toBeNull();

    await handler.handleClose(socket);
  });

  test('should send a context factory failure with INTERNAL_ERROR when not masking', async () => {
    const handler = createHandler({
      context: () => {
        throw new Error('postgres://u:p@h/db refused');
      },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, SUBSCRIBE_FOREVER);

    const errorFrame = frames(socket).find((f) => f.type === 'error');
    expect(errorFrame?.payload?.[0]?.message).toBe('postgres://u:p@h/db refused');
    expect(errorFrame?.payload?.[0]?.extensions?.code).toBe(ErrorCode.INTERNAL_ERROR);

    await handler.handleClose(socket);
  });

  test('should mask an onSubscribe failure when maskErrors is on', async () => {
    const handler = createHandler({
      errorFormatting: { maskErrors: true },
      onSubscribe: () => {
        throw new Error('ldap bind failed for cn=admin');
      },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, SUBSCRIBE_FOREVER);

    const errorFrame = frames(socket).find((f) => f.type === 'error');
    expect(errorFrame?.payload?.[0]?.message).toBe(MASKED);

    await handler.handleClose(socket);
  });

  test('should keep a LeavenError message and code under masking', async () => {
    const handler = createHandler({
      errorFormatting: { maskErrors: true },
      context: () => {
        throw new AuthenticationError('Token expired');
      },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, SUBSCRIBE_FOREVER);

    const errorFrame = frames(socket).find((f) => f.type === 'error');
    expect(errorFrame?.payload?.[0]?.message).toBe('Token expired');
    expect(errorFrame?.payload?.[0]?.extensions?.code).toBe(ErrorCode.UNAUTHENTICATED);

    await handler.handleClose(socket);
  });

  test('should keep the code of a GraphQLError thrown by the source stream', async () => {
    const handler = createHandler({
      schema: createFailingSchema(),
      errorFormatting: { maskErrors: true },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, subscribeFrame('s1', 'subscription { forbidden }'));
    await waitFor(() => frames(socket).some((f) => f.type === 'error'));

    const errorFrame = frames(socket).find((f) => f.type === 'error');
    expect(errorFrame?.id).toBe('s1');
    expect(errorFrame?.payload?.[0]?.message).toBe('Not allowed to watch this');
    expect(errorFrame?.payload?.[0]?.extensions?.code).toBe(ErrorCode.FORBIDDEN);

    await handler.handleClose(socket);
  });

  test('should keep the code of a source stream GraphQLError without masking', async () => {
    const handler = createHandler({ schema: createFailingSchema() });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, subscribeFrame('s1', 'subscription { forbidden }'));
    await waitFor(() => frames(socket).some((f) => f.type === 'error'));

    const errorFrame = frames(socket).find((f) => f.type === 'error');
    expect(errorFrame?.payload?.[0]?.extensions?.code).toBe(ErrorCode.FORBIDDEN);

    await handler.handleClose(socket);
  });

  test('should mask a raw Error thrown by the source stream', async () => {
    const handler = createHandler({
      schema: createFailingSchema(),
      errorFormatting: { maskErrors: true },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, subscribeFrame('s1', 'subscription { crashing }'));
    await waitFor(() => frames(socket).some((f) => f.type === 'error'));

    const errorFrame = frames(socket).find((f) => f.type === 'error');
    expect(errorFrame?.payload?.[0]?.message).toBe(MASKED);
    expect(socket.sent.join('')).not.toContain('postgres://');

    await handler.handleClose(socket);
  });

  test('should mask execution errors inside a subscription next payload', async () => {
    const handler = createHandler({
      schema: createFailingSchema(),
      errorFormatting: { maskErrors: true },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, subscribeFrame('s1', 'subscription { poisoned }'));
    await waitFor(() => frames(socket).some((f) => f.type === 'complete'));

    const next = frames(socket).find((f) => f.type === 'next');
    expect(next?.payload?.errors?.[0]?.message).toBe(MASKED);
    expect(next?.payload?.errors?.[0]?.extensions?.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(socket.sent.join('')).not.toContain('sk_live_123');

    await handler.handleClose(socket);
  });

  test('should mask execution errors inside a query next payload', async () => {
    const handler = createHandler({
      schema: createFailingSchema(),
      errorFormatting: { maskErrors: true },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, subscribeFrame('q1', '{ boom }'));

    const next = frames(socket).find((f) => f.type === 'next');
    expect(next?.payload?.errors?.[0]?.message).toBe(MASKED);
    expect(next?.payload?.errors?.[0]?.extensions?.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(socket.sent.join('')).not.toContain('hunter2');

    await handler.handleClose(socket);
  });

  test('should leave executor errors as formatted when errorFormatting is unset', async () => {
    const handler = createHandler({ schema: createFailingSchema() });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, subscribeFrame('q1', '{ boom }'));

    const next = frames(socket).find((f) => f.type === 'next');
    expect(next?.payload?.errors?.[0]?.message).toBe(
      'redis://admin:hunter2@cache:6379 unreachable'
    );
    expect(next?.payload?.errors?.[0]?.extensions).toBeUndefined();

    await handler.handleClose(socket);
  });

  test('should apply a custom formatter to every error the transport sends', async () => {
    const seen: string[] = [];
    const handler = createHandler({
      schema: createFailingSchema(),
      errorFormatting: {
        formatter: (error) => {
          seen.push(error.message);
          return { message: 'formatted', extensions: { code: 'CUSTOM' } };
        },
      },
      context: (_socket, request) => {
        if (request.query.includes('crashing')) {
          throw new Error('context failed');
        }
        return {};
      },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, subscribeFrame('q1', '{ boom }'));
    await handler.handleMessage(socket, subscribeFrame('s1', 'subscription { crashing }'));

    expect(seen).toEqual(['redis://admin:hunter2@cache:6379 unreachable', 'context failed']);
    for (const frame of frames(socket)) {
      const errors = frame.type === 'error' ? frame.payload : frame.payload?.errors;
      for (const error of errors ?? []) {
        expect(error.message).toBe('formatted');
      }
    }

    await handler.handleClose(socket);
  });

  test('should keep the per-connection limit message visible under masking', async () => {
    const handler = createHandler({
      errorFormatting: { maskErrors: true },
      subscriptionManager: { maxSubscriptionsPerConnection: 1 },
    });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, SUBSCRIBE_FOREVER);
    await handler.handleMessage(socket, subscribeFrame('sub-2', 'subscription { forever }'));

    const errorFrame = frames(socket).find((f) => f.type === 'error');
    expect(errorFrame?.payload?.[0]?.message).toBe('Maximum subscriptions per connection reached');
    expect(errorFrame?.payload?.[0]?.extensions?.code).toBe(ErrorCode.BAD_REQUEST);

    await handler.handleClose(socket);
  });

  for (const [label, query] of [
    ['query', 'query A { hello }'],
    ['subscription', 'subscription A { count }'],
  ] as const) {
    test(`should send an unknown ${label} operation name as a BAD_REQUEST error frame`, async () => {
      const handler = createHandler({ errorFormatting: { maskErrors: true } });
      const socket = createFakeSocket();

      await openAndInit(handler, socket);
      await handler.handleMessage(
        socket,
        JSON.stringify({ id: 'op', type: 'subscribe', payload: { query, operationName: 'B' } })
      );
      await waitFor(() => frames(socket).some((f) => f.type === 'error'));

      const errorFrame = frames(socket).find((f) => f.type === 'error');
      expect(errorFrame?.id).toBe('op');
      expect(errorFrame?.payload?.[0]?.message).toBe('Unknown operation named "B".');
      expect(errorFrame?.payload?.[0]?.extensions?.code).toBe(ErrorCode.BAD_REQUEST);
      expect(socket.closed).toBeNull();

      await handler.handleClose(socket);
    });
  }

  test('should keep a validation error visible under masking', async () => {
    const handler = createHandler({ errorFormatting: { maskErrors: true } });
    const socket = createFakeSocket();

    await openAndInit(handler, socket);
    await handler.handleMessage(socket, subscribeFrame('s1', 'subscription { nonexistent }'));
    await handler.handleMessage(socket, subscribeFrame('q1', '{ nonexistent }'));

    const errorFrames = frames(socket).filter((f) => f.type === 'error');
    expect(errorFrames.map((f) => f.id)).toEqual(['s1', 'q1']);
    for (const frame of errorFrames) {
      expect(frame.payload?.[0]?.message).toMatch(/Cannot query field "nonexistent"/);
      expect(frame.payload?.[0]?.extensions?.code).toBe(ErrorCode.VALIDATION_ERROR);
    }

    await handler.handleClose(socket);
  });

  test('should pass errorFormatting to the subscription manager', async () => {
    const handler = createHandler({ errorFormatting: { maskErrors: true } });
    const manager = managerOf(handler) as unknown as {
      errorFormatting?: { maskErrors?: boolean };
    };
    expect(manager.errorFormatting?.maskErrors).toBe(true);
  });
});

describe('createWebSocketHandler', () => {
  test('should create a WebSocketHandler instance', () => {
    const handler = createWebSocketHandler({ schema: createTestSchema() });
    expect(handler).toBeInstanceOf(WebSocketHandler);
  });
});
