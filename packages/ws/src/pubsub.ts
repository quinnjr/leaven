/**
 * @leaven-graphql/ws - PubSub implementation
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { WebSocketLogger } from './logger';

/**
 * Subscribe function type
 */
export type SubscribeFn<T = unknown> = (
  topic: string,
  callback: (payload: T) => void
) => () => void;

/**
 * Publish function type
 */
export type PublishFn<T = unknown> = (topic: string, payload: T) => void;

/**
 * PubSub engine interface
 */
export interface PubSubEngine {
  subscribe: SubscribeFn;
  publish: PublishFn;
}

/**
 * PubSub configuration
 */
export interface PubSubConfig {
  /** Maximum subscribers per topic */
  maxSubscribersPerTopic?: number;
  /** Enable topic wildcards */
  wildcards?: boolean;
  /**
   * Maximum number of payloads buffered by an `asyncIterator` while no
   * consumer is pulling. When the buffer is full, the OLDEST payload is
   * dropped to make room for the newest (drop-oldest policy), so a slow
   * consumer sees the most recent events rather than growing the queue
   * without bound. Unlimited by default.
   */
  maxQueueSize?: number;
  /** Where subscriber callback errors are logged. Defaults to `console`. */
  logger?: WebSocketLogger;
}

/**
 * Subscriber entry
 */
interface Subscriber<T = unknown> {
  id: string;
  callback: (payload: T) => void;
}

/**
 * In-memory PubSub implementation
 */
export class PubSub implements PubSubEngine {
  private readonly subscribers: Map<string, Set<Subscriber>>;
  /** Wildcard patterns, pre-split at subscribe time (pattern -> parts) */
  private readonly wildcardPatterns: Map<string, string[]>;
  private readonly maxSubscribersPerTopic: number;
  private readonly wildcards: boolean;
  private readonly maxQueueSize: number;
  private readonly logger: WebSocketLogger;
  private nextId: number;

  constructor(config: PubSubConfig = {}) {
    this.subscribers = new Map();
    this.wildcardPatterns = new Map();
    this.maxSubscribersPerTopic = config.maxSubscribersPerTopic ?? 10000;
    this.wildcards = config.wildcards ?? false;
    this.maxQueueSize = config.maxQueueSize ?? Infinity;
    this.logger = config.logger ?? console;
    this.nextId = 0;
  }

  /**
   * Subscribe to a topic
   */
  public subscribe<T = unknown>(
    topic: string,
    callback: (payload: T) => void
  ): () => void {
    let topicSubscribers = this.subscribers.get(topic);

    if (!topicSubscribers) {
      topicSubscribers = new Set();
      this.subscribers.set(topic, topicSubscribers);

      // Split the pattern once at subscribe time so publishes never re-split
      if (this.wildcards) {
        const parts = topic.split('.');
        if (parts.some((part) => part === '*' || part === '#')) {
          this.wildcardPatterns.set(topic, parts);
        }
      }
    }

    if (topicSubscribers.size >= this.maxSubscribersPerTopic) {
      throw new Error(`Maximum subscribers reached for topic: ${topic}`);
    }

    const subscriber: Subscriber<T> = {
      id: String(this.nextId++),
      callback,
    };

    topicSubscribers.add(subscriber as Subscriber);

    // The Set captured here can stop being the one registered for `topic`:
    // once its last subscriber leaves, the entry is dropped and a later
    // subscriber installs a FRESH Set. A stale or repeated call to this
    // unsubscribe function must not touch that new Set — otherwise it would
    // evict another client's subscription — so verify identity first.
    const registeredSubscribers = topicSubscribers;

    // Return unsubscribe function
    return () => {
      if (this.subscribers.get(topic) !== registeredSubscribers) {
        return;
      }
      registeredSubscribers.delete(subscriber as Subscriber);
      if (registeredSubscribers.size === 0) {
        this.subscribers.delete(topic);
        this.wildcardPatterns.delete(topic);
      }
    };
  }

  /**
   * Publish to a topic
   */
  public publish<T = unknown>(topic: string, payload: T): void {
    const topicSubscribers = this.subscribers.get(topic);

    if (topicSubscribers) {
      for (const subscriber of topicSubscribers) {
        try {
          subscriber.callback(payload);
        } catch (error) {
          this.logger.error('Error in subscriber callback:', error);
        }
      }
    }

    // Handle wildcards if enabled
    if (this.wildcards && this.wildcardPatterns.size > 0) {
      this.publishToWildcards(topic, payload);
    }
  }

  /**
   * Publish to wildcard subscribers
   */
  private publishToWildcards<T>(topic: string, payload: T): void {
    const topicParts = topic.split('.');

    for (const [pattern, patternParts] of this.wildcardPatterns) {
      // Skip patterns identical to the published topic: those subscribers
      // were already served by the exact-match pass in publish()
      if (pattern === topic) {
        continue;
      }

      if (this.matchesWildcard(patternParts, topicParts)) {
        const subscribers = this.subscribers.get(pattern);
        if (!subscribers) {
          continue;
        }

        for (const subscriber of subscribers) {
          try {
            subscriber.callback(payload);
          } catch (error) {
            this.logger.error('Error in wildcard subscriber callback:', error);
          }
        }
      }
    }
  }

  /**
   * Check if a pre-split topic pattern matches
   */
  private matchesWildcard(patternParts: string[], topicParts: string[]): boolean {
    if (patternParts.length === 1 && (patternParts[0] === '*' || patternParts[0] === '#')) {
      return true;
    }

    for (let i = 0; i < patternParts.length; i++) {
      const part = patternParts[i];

      if (part === '#') {
        return true;
      }

      if (part === '*') {
        continue;
      }

      if (topicParts[i] !== part) {
        return false;
      }
    }

    return patternParts.length === topicParts.length;
  }

  /**
   * Create an async iterator for a topic
   */
  public asyncIterator<T = unknown>(
    topic: string | string[]
  ): AsyncIterableIterator<T> {
    const topics = Array.isArray(topic) ? topic : [topic];
    const pullQueue: Array<(value: IteratorResult<T>) => void> = [];
    const pushQueue: T[] = [];
    let done = false;

    const unsubscribes: Array<() => void> = [];
    const maxQueueSize = this.maxQueueSize;

    const pushValue = (payload: T): void => {
      if (done) return;

      if (pullQueue.length > 0) {
        const resolve = pullQueue.shift()!;
        resolve({ value: payload, done: false });
      } else {
        // Drop-oldest policy: when the buffer is full, evict the oldest
        // payload so the queue cannot grow without bound
        if (pushQueue.length >= maxQueueSize) {
          pushQueue.shift();
        }
        pushQueue.push(payload);
      }
    };

    // Subscribe to all topics
    for (const t of topics) {
      unsubscribes.push(this.subscribe(t, pushValue));
    }

    return {
      [Symbol.asyncIterator]() {
        return this;
      },

      async next(): Promise<IteratorResult<T>> {
        if (done) {
          return { value: undefined, done: true };
        }

        if (pushQueue.length > 0) {
          return { value: pushQueue.shift()!, done: false };
        }

        return new Promise((resolve) => {
          pullQueue.push(resolve);
        });
      },

      async return(): Promise<IteratorResult<T>> {
        // Idempotent: consumers (and `for await` plus an explicit `return()`
        // in a caller's `finally`) can close the same iterator twice, and the
        // second teardown must not run the unsubscribes again.
        if (done) {
          return { value: undefined, done: true };
        }
        done = true;
        for (const unsubscribe of unsubscribes) {
          unsubscribe();
        }
        pullQueue.forEach((resolve) => resolve({ value: undefined, done: true }));
        pullQueue.length = 0;
        pushQueue.length = 0;
        return { value: undefined, done: true };
      },

      async throw(error: unknown): Promise<IteratorResult<T>> {
        done = true;
        for (const unsubscribe of unsubscribes) {
          unsubscribe();
        }
        // Settle pending pulls BEFORE dropping them: a consumer suspended in
        // `await next()` would otherwise wait on a promise that can never
        // resolve, so its `for await` loop (and any `finally` cleanup) would
        // never run.
        pullQueue.forEach((resolve) => resolve({ value: undefined, done: true }));
        pullQueue.length = 0;
        pushQueue.length = 0;
        throw error;
      },
    };
  }

  /**
   * Get the number of subscribers for a topic
   */
  public getSubscriberCount(topic: string): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }

  /**
   * Get all topics with subscribers
   */
  public getTopics(): string[] {
    return Array.from(this.subscribers.keys());
  }

  /**
   * Clear all subscriptions
   */
  public clear(): void {
    this.subscribers.clear();
    this.wildcardPatterns.clear();
  }
}

/**
 * Create a new PubSub instance
 */
export function createPubSub(config?: PubSubConfig): PubSub {
  return new PubSub(config);
}
