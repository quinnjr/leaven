/**
 * @leaven-graphql/ws - PubSub tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { PubSub, createPubSub } from './pubsub';

describe('PubSub', () => {
  let pubsub: PubSub;

  beforeEach(() => {
    pubsub = new PubSub();
  });

  describe('subscribe', () => {
    test('should subscribe to a topic', () => {
      const messages: string[] = [];
      const unsubscribe = pubsub.subscribe<string>('test', (msg) => {
        messages.push(msg);
      });

      expect(typeof unsubscribe).toBe('function');
      expect(pubsub.getSubscriberCount('test')).toBe(1);
    });

    test('should receive published messages', () => {
      const messages: string[] = [];
      pubsub.subscribe<string>('test', (msg) => {
        messages.push(msg);
      });

      pubsub.publish('test', 'Hello');
      pubsub.publish('test', 'World');

      expect(messages).toEqual(['Hello', 'World']);
    });

    test('should unsubscribe correctly', () => {
      const messages: string[] = [];
      const unsubscribe = pubsub.subscribe<string>('test', (msg) => {
        messages.push(msg);
      });

      pubsub.publish('test', 'Before');
      unsubscribe();
      pubsub.publish('test', 'After');

      expect(messages).toEqual(['Before']);
      expect(pubsub.getSubscriberCount('test')).toBe(0);
    });

    test('should support multiple subscribers', () => {
      const messages1: string[] = [];
      const messages2: string[] = [];

      pubsub.subscribe<string>('test', (msg) => messages1.push(msg));
      pubsub.subscribe<string>('test', (msg) => messages2.push(msg));

      pubsub.publish('test', 'Hello');

      expect(messages1).toEqual(['Hello']);
      expect(messages2).toEqual(['Hello']);
      expect(pubsub.getSubscriberCount('test')).toBe(2);
    });

    test('should throw when max subscribers reached', () => {
      const limitedPubsub = new PubSub({ maxSubscribersPerTopic: 2 });

      limitedPubsub.subscribe('test', () => {});
      limitedPubsub.subscribe('test', () => {});

      expect(() => limitedPubsub.subscribe('test', () => {})).toThrow(
        /Maximum subscribers reached/
      );
    });

    test('should escape the topic in the max-subscribers error', () => {
      const limitedPubsub = new PubSub({ maxSubscribersPerTopic: 1 });
      const topic = 'chat\r\nERROR forged';

      limitedPubsub.subscribe(topic, () => {});

      expect(() => limitedPubsub.subscribe(topic, () => {})).toThrow(
        'Maximum subscribers reached for topic: chat\\r\\nERROR forged'
      );
    });
  });

  describe('publish', () => {
    test('should publish to all subscribers', () => {
      const received: number[] = [];

      pubsub.subscribe('counter', (n: number) => received.push(n));
      pubsub.subscribe('counter', (n: number) => received.push(n * 2));

      pubsub.publish('counter', 5);

      expect(received).toEqual([5, 10]);
    });

    test('should handle no subscribers', () => {
      // Should not throw
      pubsub.publish('empty', 'message');
    });

    test('should continue on subscriber error', () => {
      const received: string[] = [];

      pubsub.subscribe('test', () => {
        throw new Error('Subscriber error');
      });
      pubsub.subscribe('test', (msg: string) => received.push(msg));

      pubsub.publish('test', 'Hello');

      expect(received).toEqual(['Hello']);
    });
  });

  describe('wildcards', () => {
    test('should match wildcard patterns when enabled', () => {
      const wildcardPubsub = new PubSub({ wildcards: true });
      const received: string[] = [];

      wildcardPubsub.subscribe('events.*', (msg: string) => received.push(msg));

      wildcardPubsub.publish('events.user', 'User event');
      wildcardPubsub.publish('events.system', 'System event');

      expect(received).toContain('User event');
    });

    test('should match # for multiple levels', () => {
      const wildcardPubsub = new PubSub({ wildcards: true });
      const received: string[] = [];

      wildcardPubsub.subscribe('#', (msg: string) => received.push(msg));

      wildcardPubsub.publish('any.topic.here', 'Message');

      expect(received).toContain('Message');
    });

    test('should deliver exactly once to exact-topic subscribers when wildcards are enabled', () => {
      const wildcardPubsub = new PubSub({ wildcards: true });
      const received: string[] = [];

      wildcardPubsub.subscribe('USER_CREATED', (msg: string) => received.push(msg));

      wildcardPubsub.publish('USER_CREATED', 'User event');

      expect(received).toEqual(['User event']);
    });

    test('should deliver exactly once each to exact and wildcard subscribers', () => {
      const wildcardPubsub = new PubSub({ wildcards: true });
      const exactReceived: string[] = [];
      const wildcardReceived: string[] = [];

      wildcardPubsub.subscribe('events.user', (msg: string) => exactReceived.push(msg));
      wildcardPubsub.subscribe('events.*', (msg: string) => wildcardReceived.push(msg));

      wildcardPubsub.publish('events.user', 'User event');

      expect(exactReceived).toEqual(['User event']);
      expect(wildcardReceived).toEqual(['User event']);
    });

    test('should not double-deliver when publishing directly to a wildcard pattern topic', () => {
      const wildcardPubsub = new PubSub({ wildcards: true });
      const received: string[] = [];

      wildcardPubsub.subscribe('events.*', (msg: string) => received.push(msg));

      wildcardPubsub.publish('events.*', 'Direct publish');

      expect(received).toEqual(['Direct publish']);
    });
  });

  describe('asyncIterator', () => {
    test('should create async iterator for topic', async () => {
      const iterator = pubsub.asyncIterator<string>('test');

      // Publish a message
      setTimeout(() => {
        pubsub.publish('test', 'Hello');
      }, 10);

      const result = await iterator.next();

      expect(result.value).toBe('Hello');
      expect(result.done).toBe(false);

      // Clean up
      await iterator.return?.();
    });

    test('should support multiple topics', async () => {
      const iterator = pubsub.asyncIterator<string>(['topic1', 'topic2']);

      setTimeout(() => {
        pubsub.publish('topic2', 'From topic2');
      }, 10);

      const result = await iterator.next();

      expect(result.value).toBe('From topic2');

      await iterator.return?.();
    });

    test('should handle return', async () => {
      const iterator = pubsub.asyncIterator<string>('test');

      const returnResult = await iterator.return?.();

      expect(returnResult?.done).toBe(true);
    });

    test('should handle throw', async () => {
      const iterator = pubsub.asyncIterator<string>('test');

      await expect(iterator.throw?.(new Error('Test'))).rejects.toThrow('Test');
    });

    test('should settle pending next() promises on throw', async () => {
      const iterator = pubsub.asyncIterator<string>('test');

      // Suspend a consumer on an empty queue
      const pending = iterator.next();

      await expect(iterator.throw?.(new Error('Test'))).rejects.toThrow('Test');

      // The suspended pull must be settled, not silently discarded: otherwise
      // a `for await` loop never terminates and its `finally` never runs
      const settled = await Promise.race([
        pending,
        new Promise<'never-settled'>((resolve) =>
          setTimeout(() => resolve('never-settled'), 100)
        ),
      ]);

      expect(settled).not.toBe('never-settled');
      expect((settled as IteratorResult<string>).done).toBe(true);
      expect((settled as IteratorResult<string>).value).toBeUndefined();
    });

    test('should not evict a later subscription when return() is called twice', async () => {
      // Reproduces the stale-unsubscribe bug: A's second return() must not
      // delete the topic entry that now belongs to B
      const iteratorA = pubsub.asyncIterator<string>('shared');
      expect(pubsub.getSubscriberCount('shared')).toBe(1);

      // First close: `for await` completing the source
      await iteratorA.return?.();
      expect(pubsub.getSubscriberCount('shared')).toBe(0);

      // A new client claims the topic in the window before A's second close
      const iteratorB = pubsub.asyncIterator<string>('shared');
      expect(pubsub.getSubscriberCount('shared')).toBe(1);

      // Second close: a caller's `finally` calling return() again. It must not
      // take B's subscription down with it.
      await iteratorA.return?.();
      expect(pubsub.getSubscriberCount('shared')).toBe(1);

      const pending = iteratorB.next();
      pubsub.publish('shared', 'for B');

      const result = await pending;
      expect(result.done).toBe(false);
      expect(result.value).toBe('for B');
      expect(pubsub.getSubscriberCount('shared')).toBe(1);

      await iteratorB.return?.();
    });

    test('should ignore a stale unsubscribe from a replaced topic Set', () => {
      const receivedA: string[] = [];
      const receivedB: string[] = [];

      const unsubscribeA = pubsub.subscribe<string>('topic', (msg) =>
        receivedA.push(msg)
      );
      unsubscribeA();
      expect(pubsub.getSubscriberCount('topic')).toBe(0);

      pubsub.subscribe<string>('topic', (msg) => receivedB.push(msg));

      // Stale repeat of A's unsubscribe, now targeting a Set it no longer owns
      unsubscribeA();

      pubsub.publish('topic', 'Hello');

      expect(receivedA).toEqual([]);
      expect(receivedB).toEqual(['Hello']);
      expect(pubsub.getSubscriberCount('topic')).toBe(1);
    });

    test('should drop oldest payloads when maxQueueSize is reached', async () => {
      const boundedPubsub = new PubSub({ maxQueueSize: 2 });
      const iterator = boundedPubsub.asyncIterator<string>('test');

      // No consumer pulling yet: buffer fills, oldest is evicted
      boundedPubsub.publish('test', 'first');
      boundedPubsub.publish('test', 'second');
      boundedPubsub.publish('test', 'third');

      const result1 = await iterator.next();
      const result2 = await iterator.next();

      expect(result1.value).toBe('second');
      expect(result2.value).toBe('third');

      await iterator.return?.();
    });

    test('should discard buffered payloads on return', async () => {
      const iterator = pubsub.asyncIterator<string>('test');

      pubsub.publish('test', 'buffered');

      await iterator.return?.();

      const result = await iterator.next();
      expect(result.done).toBe(true);
      expect(result.value).toBeUndefined();
    });
  });

  describe('getSubscriberCount', () => {
    test('should return correct subscriber count', () => {
      expect(pubsub.getSubscriberCount('test')).toBe(0);

      pubsub.subscribe('test', () => {});
      expect(pubsub.getSubscriberCount('test')).toBe(1);

      pubsub.subscribe('test', () => {});
      expect(pubsub.getSubscriberCount('test')).toBe(2);
    });
  });

  describe('getTopics', () => {
    test('should return all topics with subscribers', () => {
      pubsub.subscribe('topic1', () => {});
      pubsub.subscribe('topic2', () => {});
      pubsub.subscribe('topic3', () => {});

      const topics = pubsub.getTopics();

      expect(topics).toContain('topic1');
      expect(topics).toContain('topic2');
      expect(topics).toContain('topic3');
    });
  });

  describe('clear', () => {
    test('should clear all subscriptions', () => {
      pubsub.subscribe('topic1', () => {});
      pubsub.subscribe('topic2', () => {});

      pubsub.clear();

      expect(pubsub.getTopics().length).toBe(0);
    });
  });
});

describe('createPubSub', () => {
  test('should create a PubSub instance', () => {
    const pubsub = createPubSub();
    expect(pubsub).toBeInstanceOf(PubSub);
  });

  test('should accept config', () => {
    const pubsub = createPubSub({ maxSubscribersPerTopic: 5 });
    expect(pubsub).toBeInstanceOf(PubSub);
  });
});

describe('PubSub logger', () => {
  test('should report subscriber errors through the injected logger', () => {
    const errors: unknown[][] = [];
    const pubsub = new PubSub({
      wildcards: true,
      logger: { error: (...args: unknown[]) => errors.push(args) },
    });
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      pubsub.subscribe('a.b', () => {
        throw new Error('exact boom');
      });
      pubsub.subscribe('a.*', () => {
        throw new Error('wildcard boom');
      });
      pubsub.publish('a.b', 1);

      expect(errors.length).toBe(2);
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('PubSub wildcard matching and iterator cleanup', () => {
  test("'*' should match exactly one segment", () => {
    const ps = new PubSub({ wildcards: true });
    const hits: string[] = [];
    ps.subscribe('*', (p) => hits.push(p as string));
    ps.publish('a', 'one');
    ps.publish('a.b', 'two');
    expect(hits).toEqual(['one']);
  });

  test("'events.*' should not match a deeper topic", () => {
    const ps = new PubSub({ wildcards: true });
    const hits: string[] = [];
    ps.subscribe('events.*', (p) => hits.push(p as string));
    ps.publish('events.a', 'one');
    ps.publish('events.a.b', 'two');
    expect(hits).toEqual(['one']);
  });

  test("'#' should still match every topic", () => {
    const ps = new PubSub({ wildcards: true });
    const hits: string[] = [];
    ps.subscribe('#', (p) => hits.push(p as string));
    ps.publish('a', 'one');
    ps.publish('a.b.c', 'two');
    expect(hits).toEqual(['one', 'two']);
  });

  test('asyncIterator should unsubscribe earlier topics when a later one throws', () => {
    const ps = new PubSub({ maxSubscribersPerTopic: 1 });
    ps.subscribe('full', () => {});
    expect(() => ps.asyncIterator(['free', 'full'])).toThrow();
    expect(ps.getSubscriberCount('free')).toBe(0);
  });

  test('drop-oldest should keep the newest payloads in order', async () => {
    const ps = new PubSub({ maxQueueSize: 3 });
    const it = ps.asyncIterator<number>('t');
    for (let i = 1; i <= 5000; i++) ps.publish('t', i);
    expect((await it.next()).value).toBe(4998);
    expect((await it.next()).value).toBe(4999);
    expect((await it.next()).value).toBe(5000);
    await it.return?.();
  });
});

describe('PubSub maxQueueSize validation', () => {
  test.each([0, -1, 1.5, NaN])('should throw TypeError for %p', (value) => {
    expect(() => new PubSub({ maxQueueSize: value })).toThrow(TypeError);
  });

  test('should accept Infinity and positive integers', () => {
    expect(() => new PubSub({ maxQueueSize: Infinity })).not.toThrow();
    expect(() => new PubSub({ maxQueueSize: 1 })).not.toThrow();
  });
});

describe('PubSub asyncIterator lagging consumer', () => {
  test('should deliver every payload in order when the consumer lags by one', async () => {
    const ps = new PubSub();
    const it = ps.asyncIterator<number>('t');
    ps.publish('t', 0);
    for (let i = 1; i <= 10_000; i++) {
      ps.publish('t', i);
      const r = await it.next();
      expect(r.value).toBe(i - 1);
    }
    await it.return?.();
  });
});
