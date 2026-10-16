/**
 * @leaven-graphql/ws - Subscription manager tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, spyOn } from 'bun:test';
import {
  GraphQLInt,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';
import { LeavenExecutor, type GraphQLResponse } from '@leaven-graphql/core';
import { SubscriptionManager, createSubscriptionManager } from './manager';

/** Records whether an iterator was released via return() */
interface IteratorProbe {
  returned: boolean;
}

/** A test-driven event source backing one `feed` subscription */
interface Feed {
  push(value: number): void;
  iterator: AsyncIterableIterator<unknown>;
}

/**
 * An iterator whose values are pushed by the test, so delivery to a specific
 * subscription can be observed one event at a time.
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
 * An async iterator whose next() never resolves, emulating a subscription
 * that stays open until it is torn down. The probe records the release so
 * tests can assert the resource contract, not just map bookkeeping.
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
        // Like `forever`, but the source stream takes 20ms to set up
        slow: {
          type: GraphQLInt,
          subscribe: async () => {
            const probe: IteratorProbe = { returned: false };
            probes.push(probe);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return neverEndingIterator(probe);
          },
        },
        nested: {
          type: new GraphQLObjectType({
            name: 'Nested',
            fields: { value: { type: GraphQLInt } },
          }),
          subscribe: async function* () {
            yield { nested: { value: 1 } };
          },
        },
      },
    }),
  });
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

describe('SubscriptionManager', () => {
  describe('subscribe', () => {
    test('should deliver results and complete', async () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });
      const results: GraphQLResponse[] = [];
      let completed = false;
      const errors: unknown[] = [];

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { count }' },
        undefined,
        (result) => results.push(result),
        () => {
          completed = true;
        },
        (errs) => errors.push(errs)
      );

      await waitFor(() => completed);

      expect(errors.length).toBe(0);
      expect(results.map((r) => r.data?.count)).toEqual([1, 2, 3]);
      expect(manager.subscriptionCount).toBe(0);
    });

    test('should report validation errors through onError, not a TypeError', async () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });
      let received: readonly { message: string }[] | undefined;
      let nextCalled = false;
      let completeCalled = false;

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { nonexistent }' },
        undefined,
        () => {
          nextCalled = true;
        },
        () => {
          completeCalled = true;
        },
        (errs) => {
          received = errs;
        }
      );

      expect(received).toBeDefined();
      expect(received![0]?.message).toMatch(/Cannot query field/);
      // Must NOT be the "is not async iterable" TypeError from handing a
      // plain error result to for-await
      expect(received![0]?.message).not.toMatch(/async iterable/);
      expect(nextCalled).toBe(false);
      expect(completeCalled).toBe(false);
      expect(manager.subscriptionCount).toBe(0);
      expect(manager.getSubscription('conn-1', 'sub-1')).toBeUndefined();
    });

    test('should report thrown errors through onError', async () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });
      let received: readonly { message: string }[] | undefined;

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription {' },
        undefined,
        () => {},
        () => {},
        (errs) => {
          received = errs;
        }
      );

      expect(received).toBeDefined();
      expect(received!.length).toBeGreaterThan(0);
      expect(manager.subscriptionCount).toBe(0);
    });

    test('should throw when max subscriptions per connection reached', async () => {
      const manager = new SubscriptionManager({
        schema: createTestSchema(),
        maxSubscriptionsPerConnection: 1,
      });

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      await expect(
        manager.subscribe(
          'conn-1',
          'sub-2',
          { query: 'subscription { forever }' },
          undefined,
          () => {},
          () => {},
          () => {}
        )
      ).rejects.toThrow(/Maximum subscriptions per connection reached/);

      manager.clear();
    });

    test('should refuse to overwrite an existing subscription id', async () => {
      const probes: IteratorProbe[] = [];
      const manager = new SubscriptionManager({ schema: createTestSchema(probes) });

      const original = await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      await expect(
        manager.subscribe(
          'conn-1',
          'sub-1',
          { query: 'subscription { forever }' },
          undefined,
          () => {},
          () => {},
          () => {}
        )
      ).rejects.toThrow(/already exists/);

      // The original is untouched and still owns the id
      expect(manager.getSubscription('conn-1', 'sub-1')).toBe(original);
      expect(probes.length).toBe(1);
      expect(probes[0]!.returned).toBe(false);

      manager.clear();
      expect(probes[0]!.returned).toBe(true);
    });

    test('should count pending subscriptions toward the per-connection limit', async () => {
      const manager = new SubscriptionManager({
        schema: createTestSchema(),
        maxSubscriptionsPerConnection: 1,
      });

      const pending = manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { slow }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      await expect(
        manager.subscribe(
          'conn-1',
          'sub-2',
          { query: 'subscription { forever }' },
          undefined,
          () => {},
          () => {},
          () => {}
        )
      ).rejects.toThrow(/Maximum subscriptions per connection reached/);

      await pending;
      manager.clear();
    });

    test('should track subscription status and metadata', async () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      const subscription = manager.getSubscription('conn-1', 'sub-1');
      expect(subscription).toBeDefined();
      expect(subscription!.id).toBe('sub-1');
      expect(subscription!.connectionId).toBe('conn-1');
      expect(subscription!.status).toBe('active');
      expect(manager.subscriptionCount).toBe(1);
      expect(manager.connectionCount).toBe(1);

      manager.clear();
    });
  });

  describe('teardown during setup', () => {
    test('should release the iterator when the connection closed during executor.subscribe', async () => {
      const probes: IteratorProbe[] = [];
      const manager = new SubscriptionManager({ schema: createTestSchema(probes) });
      const calls: string[] = [];

      const subscribing = manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { slow }' },
        undefined,
        () => calls.push('next'),
        () => calls.push('complete'),
        () => calls.push('error')
      );
      await waitFor(() => probes.length === 1);
      manager.unsubscribeConnection('conn-1');

      const subscription = await subscribing;

      await waitFor(() => probes[0]!.returned);
      expect(subscription.status).toBe('completed');
      expect(manager.subscriptionCount).toBe(0);
      expect(manager.connectionCount).toBe(0);
      expect(calls).toEqual([]);
    });
  });

  describe('subscriptionTimeout', () => {
    test('should invoke onComplete when a subscription times out', async () => {
      const manager = new SubscriptionManager({
        schema: createTestSchema(),
        subscriptionTimeout: 20,
      });
      let completed = false;
      let errored = false;

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {
          completed = true;
        },
        () => {
          errored = true;
        }
      );

      expect(manager.subscriptionCount).toBe(1);

      // The client must be told the subscription is over, not dropped silently
      await waitFor(() => completed);

      expect(errored).toBe(false);
      expect(manager.subscriptionCount).toBe(0);
      expect(manager.getSubscription('conn-1', 'sub-1')).toBeUndefined();
    });

    test('should survive an onComplete that throws and still tear down', async () => {
      const probes: IteratorProbe[] = [];
      const manager = new SubscriptionManager({
        schema: createTestSchema(probes),
        subscriptionTimeout: 20,
      });
      let called = false;

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {
          called = true;
          // Runs on the timer stack: an escaping throw would be an uncaught
          // exception that kills the process and skips teardown
          throw new Error('hook exploded');
        },
        () => {}
      );

      await waitFor(() => called);
      await waitFor(() => manager.subscriptionCount === 0);

      expect(manager.getSubscription('conn-1', 'sub-1')).toBeUndefined();
      await waitFor(() => probes[0]!.returned);
      expect(probes[0]!.returned).toBe(true);
    });
  });

  describe('per-connection subscription ids', () => {
    // graphql-ws operation ids are unique per CONNECTION: reference clients
    // use a counter starting at "1", so two clients routinely both use "1".
    test('should keep same-id subscriptions on different connections separate', async () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });

      await manager.subscribe(
        'connA',
        '1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );
      await manager.subscribe(
        'connB',
        '1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      // B's subscribe must not have clobbered A's entry
      expect(manager.subscriptionCount).toBe(2);
      expect(manager.connectionCount).toBe(2);
      expect(manager.getSubscription('connA', '1')?.connectionId).toBe('connA');
      expect(manager.getSubscription('connB', '1')?.connectionId).toBe('connB');

      manager.clear();
    });

    test('should keep delivering to one connection after another with the same id ends', async () => {
      const feeds: Feed[] = [];
      const manager = new SubscriptionManager({ schema: createTestSchema([], feeds) });
      const receivedA: unknown[] = [];
      let completedA = false;
      let erroredA = false;

      await manager.subscribe(
        'connA',
        '1',
        { query: 'subscription { feed }' },
        undefined,
        (result) => receivedA.push(result.data?.feed),
        () => {
          completedA = true;
        },
        () => {
          erroredA = true;
        }
      );
      await manager.subscribe(
        'connB',
        '1',
        { query: 'subscription { feed }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      expect(feeds.length).toBe(2);

      feeds[0]!.push(1);
      await waitFor(() => receivedA.length === 1);

      // B goes away — A's subscription shares only the id, nothing else
      expect(manager.unsubscribe('connB', '1')).toBe(true);

      feeds[0]!.push(2);
      await waitFor(() => receivedA.length === 2);

      expect(receivedA).toEqual([1, 2]);
      // A is neither silently stopped nor told it is finished
      expect(completedA).toBe(false);
      expect(erroredA).toBe(false);
      expect(manager.getSubscription('connA', '1')?.status).toBe('active');

      manager.clear();
    });

    test('should not tear down another connection when unsubscribing by id', async () => {
      const probes: IteratorProbe[] = [];
      const manager = new SubscriptionManager({ schema: createTestSchema(probes) });

      for (const connectionId of ['connA', 'connB']) {
        await manager.subscribe(
          connectionId,
          '1',
          { query: 'subscription { forever }' },
          undefined,
          () => {},
          () => {},
          () => {}
        );
      }

      manager.unsubscribeConnection('connB');

      await waitFor(() => probes[1]!.returned);
      expect(probes[1]!.returned).toBe(true);
      // A's iterator is untouched
      expect(probes[0]!.returned).toBe(false);
      expect(manager.getSubscription('connA', '1')).toBeDefined();
      expect(manager.subscriptionCount).toBe(1);

      manager.clear();
    });
  });

  describe('executor configuration', () => {
    test('should apply configured executor options on the subscription path', async () => {
      const schema = createTestSchema();
      const configured = new SubscriptionManager({
        schema,
        // `subscription { nested { value } }` is two levels deep
        executor: { maxDepth: 1 },
      });
      let received: readonly { message: string }[] | undefined;

      await configured.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { nested { value } }' },
        undefined,
        () => {},
        () => {},
        (errs) => {
          received = errs;
        }
      );

      expect(received?.[0]?.message).toMatch(/exceeds maximum allowed depth/);
      expect(configured.subscriptionCount).toBe(0);

      // Without the option the same document subscribes normally, so the
      // rejection above is the configuration taking effect, not the schema
      const unconfigured = new SubscriptionManager({ schema });
      let unconfiguredError: readonly { message: string }[] | undefined;
      const values: unknown[] = [];

      await unconfigured.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { nested { value } }' },
        undefined,
        (result) => values.push(result.data?.nested),
        () => {},
        (errs) => {
          unconfiguredError = errs;
        }
      );

      await waitFor(() => values.length === 1);
      expect(unconfiguredError).toBeUndefined();

      unconfigured.clear();
    });

    test('should reuse an injected executor instead of building a second one', async () => {
      const schema = createTestSchema();
      const executor = new LeavenExecutor({ schema, maxComplexity: 0 });
      const subscribeSpy = spyOn(executor, 'subscribe');
      const manager = new SubscriptionManager({ schema, executor });

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      expect(subscribeSpy).toHaveBeenCalledTimes(1);

      // The same executor serves single-result operations, so its limits
      // apply there too
      const response = await manager.execute({ query: '{ hello }' });
      expect(response.errors?.[0]?.message).toMatch(/exceeds maximum allowed complexity/);

      subscribeSpy.mockRestore();
      manager.clear();
    });

    test('should execute queries through the managed executor', async () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });

      const response = await manager.execute({ query: '{ hello }' });

      expect(response.errors).toBeUndefined();
      expect(response.data?.hello).toBe('world');
    });
  });

  describe('unsubscribe', () => {
    test('should remove a subscription', async () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      expect(manager.unsubscribe('conn-1', 'sub-1')).toBe(true);
      expect(manager.subscriptionCount).toBe(0);
      expect(manager.connectionCount).toBe(0);
    });

    test('should return false for unknown subscription', () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });
      expect(manager.unsubscribe('conn-1', 'missing')).toBe(false);
    });

    test('should release the underlying iterator', async () => {
      const probes: IteratorProbe[] = [];
      const manager = new SubscriptionManager({ schema: createTestSchema(probes) });

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      expect(probes.length).toBe(1);
      expect(probes[0]!.returned).toBe(false);

      manager.unsubscribe('conn-1', 'sub-1');

      await waitFor(() => probes[0]!.returned);
      expect(probes[0]!.returned).toBe(true);
    });

    test('should clear the subscription timeout so onComplete never fires', async () => {
      const manager = new SubscriptionManager({
        schema: createTestSchema(),
        subscriptionTimeout: 20,
      });
      let completed = false;

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {
          completed = true;
        },
        () => {}
      );

      // The timer must actually be cancelled, not merely rendered harmless by
      // the subscription already being gone from the map
      const clearSpy = spyOn(globalThis, 'clearTimeout');
      try {
        const clearsBefore = clearSpy.mock.calls.length;
        manager.unsubscribe('conn-1', 'sub-1');
        expect(clearSpy.mock.calls.length).toBeGreaterThan(clearsBefore);
      } finally {
        clearSpy.mockRestore();
      }

      // Well past the timeout: a leaked timer would complete a dead subscription
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(completed).toBe(false);
      expect(manager.subscriptionCount).toBe(0);
    });
  });

  describe('unsubscribeConnection', () => {
    test('should remove all subscriptions for a connection', async () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });

      for (const id of ['sub-1', 'sub-2']) {
        await manager.subscribe(
          'conn-1',
          id,
          { query: 'subscription { forever }' },
          undefined,
          () => {},
          () => {},
          () => {}
        );
      }
      await manager.subscribe(
        'conn-2',
        'sub-3',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      expect(manager.unsubscribeConnection('conn-1')).toBe(2);
      expect(manager.subscriptionCount).toBe(1);
      expect(manager.getConnectionSubscriptions('conn-1')).toEqual([]);
      expect(manager.getConnectionSubscriptions('conn-2').length).toBe(1);

      manager.clear();
    });

    test('should return 0 for unknown connection', () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });
      expect(manager.unsubscribeConnection('missing')).toBe(0);
    });

    test('should release every iterator it drops', async () => {
      const probes: IteratorProbe[] = [];
      const manager = new SubscriptionManager({ schema: createTestSchema(probes) });

      for (const id of ['sub-1', 'sub-2']) {
        await manager.subscribe(
          'conn-1',
          id,
          { query: 'subscription { forever }' },
          undefined,
          () => {},
          () => {},
          () => {}
        );
      }
      await manager.subscribe(
        'conn-2',
        'sub-3',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      expect(probes.length).toBe(3);

      manager.unsubscribeConnection('conn-1');

      await waitFor(() => probes[0]!.returned && probes[1]!.returned);
      expect(probes[0]!.returned).toBe(true);
      expect(probes[1]!.returned).toBe(true);
      // conn-2's iterator is untouched
      expect(probes[2]!.returned).toBe(false);

      manager.clear();
    });
  });

  describe('clear', () => {
    test('should remove all subscriptions', async () => {
      const manager = new SubscriptionManager({ schema: createTestSchema() });

      await manager.subscribe(
        'conn-1',
        'sub-1',
        { query: 'subscription { forever }' },
        undefined,
        () => {},
        () => {},
        () => {}
      );

      manager.clear();

      expect(manager.subscriptionCount).toBe(0);
      expect(manager.connectionCount).toBe(0);
    });

    test('should release every iterator', async () => {
      const probes: IteratorProbe[] = [];
      const manager = new SubscriptionManager({ schema: createTestSchema(probes) });

      for (const [connectionId, id] of [
        ['conn-1', 'sub-1'],
        ['conn-1', 'sub-2'],
        ['conn-2', 'sub-3'],
      ] as const) {
        await manager.subscribe(
          connectionId,
          id,
          { query: 'subscription { forever }' },
          undefined,
          () => {},
          () => {},
          () => {}
        );
      }

      expect(probes.length).toBe(3);

      manager.clear();

      await waitFor(() => probes.every((probe) => probe.returned));
      expect(probes.map((probe) => probe.returned)).toEqual([true, true, true]);
    });
  });
});

describe('createSubscriptionManager', () => {
  test('should create a SubscriptionManager instance', () => {
    const manager = createSubscriptionManager({ schema: createTestSchema() });
    expect(manager).toBeInstanceOf(SubscriptionManager);
  });
});
