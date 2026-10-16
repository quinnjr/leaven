/**
 * @leaven-graphql/ws - Subscription manager
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { DocumentNode, GraphQLSchema } from 'graphql';
import {
  LeavenExecutor,
  escapeLog,
  type ExecutorConfig,
  type GraphQLRequest,
  type GraphQLResponse,
} from '@leaven-graphql/core';

import { logWarning, type WebSocketLogger } from './logger';

/**
 * Subscription status
 */
export type SubscriptionStatus = 'pending' | 'active' | 'completed' | 'error';

/**
 * Active subscription
 */
export interface Subscription {
  /** Unique subscription ID */
  id: string;
  /** Connection ID */
  connectionId: string;
  /** The original request */
  request: GraphQLRequest;
  /** Subscription status */
  status: SubscriptionStatus;
  /** When the subscription was created */
  createdAt: number;
  /** Async iterator */
  iterator?: AsyncIterableIterator<GraphQLResponse>;
  /** Cleanup function */
  cleanup?: () => void;
}

/**
 * Subscription manager configuration
 */
export interface SubscriptionManagerConfig {
  /** GraphQL schema */
  schema: GraphQLSchema;
  /** Maximum subscriptions per connection */
  maxSubscriptionsPerConnection?: number;
  /** Subscription timeout in milliseconds */
  subscriptionTimeout?: number;
  /**
   * How operations are executed.
   *
   * - An existing {@link LeavenExecutor}: reuse it. Preferred when the process
   *   already has one (an HTTP transport, say) — a second executor re-prints
   *   the whole SDL to build its validation fingerprint and keeps its own
   *   document and compiled-query caches, so sharing halves both.
   * - An {@link ExecutorConfig} without `schema`: build an executor with these
   *   options. Without this, subscriptions — the longest-lived transport —
   *   silently run on executor defaults and cannot inherit
   *   `introspection: false`, `maxDepth`, `maxComplexity` or a shared cache.
   *
   * Defaults to a new executor configured with `schema` alone.
   */
  executor?: LeavenExecutor | Omit<ExecutorConfig, 'schema'>;
  /**
   * Where diagnostics (subscription timeouts, failing completion callbacks)
   * are logged. Defaults to `console`.
   */
  logger?: WebSocketLogger;
}

/**
 * Manages GraphQL subscriptions
 */
export class SubscriptionManager {
  private readonly executor: LeavenExecutor;
  /**
   * Subscriptions grouped by connection: `connectionId -> subscriptionId ->
   * Subscription`.
   *
   * The nesting is load-bearing, not a convenience. graphql-ws operation ids
   * are unique only WITHIN a connection — reference clients use a
   * per-connection counter starting at `"1"` — so a flat map keyed on the
   * client-supplied id alone lets one connection's subscribe clobber
   * another's, and one connection's `complete` tear another's down.
   */
  private readonly connections: Map<string, Map<string, Subscription>>;
  private readonly maxSubscriptionsPerConnection: number;
  private readonly subscriptionTimeout: number;
  private readonly logger: WebSocketLogger;

  constructor(config: SubscriptionManagerConfig) {
    this.executor =
      config.executor instanceof LeavenExecutor
        ? config.executor
        : new LeavenExecutor({ ...config.executor, schema: config.schema });
    this.connections = new Map();
    this.maxSubscriptionsPerConnection = config.maxSubscriptionsPerConnection ?? 100;
    this.subscriptionTimeout = config.subscriptionTimeout ?? 0;
    this.logger = config.logger ?? console;
  }

  /**
   * Maximum number of subscriptions (pending or active) one connection may
   * hold.
   */
  public get subscriptionLimit(): number {
    return this.maxSubscriptionsPerConnection;
  }

  /**
   * Parse a query under the managed executor's parser limits.
   * See {@link LeavenExecutor.parse}.
   */
  public parse(query: string): Promise<DocumentNode> {
    return this.executor.parse(query);
  }

  /**
   * Execute a single-result operation (query or mutation) on the same
   * executor that serves subscriptions, so both transports honour the same
   * limits and share the same caches.
   */
  public async execute<TContext = unknown>(
    request: GraphQLRequest,
    context?: TContext
  ): Promise<GraphQLResponse> {
    const { response } = await this.executor.execute(request, context);
    return response;
  }

  /**
   * Create a new subscription
   */
  public async subscribe<TContext = unknown>(
    connectionId: string,
    subscriptionId: string,
    request: GraphQLRequest,
    context: TContext,
    onNext: (result: GraphQLResponse) => void,
    onComplete: () => void,
    onError: (errors: readonly { message: string }[]) => void
  ): Promise<Subscription> {
    // Check subscription limit. Entries are registered synchronously below,
    // before the executor is awaited, so pending subscriptions count too.
    const existing = this.connections.get(connectionId);
    if (existing && existing.size >= this.maxSubscriptionsPerConnection) {
      throw new Error('Maximum subscriptions per connection reached');
    }

    // Never overwrite a registered id: the displaced subscription's iterator
    // would be orphaned, still running with nothing left to return() it
    if (existing?.has(subscriptionId)) {
      throw new Error(`Subscription ${escapeLog(subscriptionId)} already exists`);
    }

    // Create subscription entry
    const subscription: Subscription = {
      id: subscriptionId,
      connectionId,
      request,
      status: 'pending',
      createdAt: Date.now(),
    };

    // Track under this connection only: an identical id on another connection
    // is a different subscription
    let connectionSubs = existing;
    if (!connectionSubs) {
      connectionSubs = new Map();
      this.connections.set(connectionId, connectionSubs);
    }
    connectionSubs.set(subscriptionId, subscription);

    try {
      // Execute the subscription
      const result = await this.executor.subscribe(request, context);

      // The subscription may have been torn down while the executor ran: the
      // client completed the id, or the connection closed. Its entry is then
      // gone (or, after an id reuse, belongs to a newer subscription), so
      // release the source stream and register nothing.
      if (!this.isCurrent(subscription)) {
        subscription.status = 'completed';
        if (Symbol.asyncIterator in Object(result)) {
          void (result as AsyncIterableIterator<GraphQLResponse>)
            .return?.()
            ?.catch(() => {});
        }
        return subscription;
      }

      // Check if it's an error result (a plain response object, not an async iterable)
      if (!(Symbol.asyncIterator in Object(result))) {
        subscription.status = 'error';
        const errors = (result as GraphQLResponse).errors ?? [{ message: 'Subscription failed' }];
        onError(errors);
        this.unsubscribe(connectionId, subscriptionId);
        return subscription;
      }

      // It's an async iterator
      const iterator = result as AsyncIterableIterator<GraphQLResponse>;
      subscription.iterator = iterator;
      subscription.status = 'active';

      // Set up timeout if configured
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (this.subscriptionTimeout > 0) {
        timeoutId = setTimeout(() => {
          // This runs on the timer stack, where there is no caller to catch:
          // an `onComplete` that throws (it sends on the socket and invokes a
          // user-supplied hook) would become an uncaught exception and take
          // down every other connection, and would also skip the teardown
          // below, leaking the subscription.
          try {
            // Notify the client before tearing down so the subscription does
            // not vanish silently: mark it completed and emit a Complete frame.
            const timedOut = this.getSubscription(connectionId, subscriptionId);
            if (timedOut === subscription && timedOut.status === 'active') {
              timedOut.status = 'completed';
              // The client sees a plain `complete` either way, so log here to
              // keep a timeout distinguishable from a natural completion.
              logWarning(
                this.logger,
                `Subscription ${escapeLog(subscriptionId)} timed out after ${this.subscriptionTimeout}ms`
              );
              onComplete();
            }
          } catch (error) {
            this.logger.error(
              `Error completing timed-out subscription ${escapeLog(subscriptionId)}:`,
              error
            );
          } finally {
            if (this.isCurrent(subscription)) {
              this.unsubscribe(connectionId, subscriptionId);
            }
          }
        }, this.subscriptionTimeout);
      }

      subscription.cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };

      // Start consuming the iterator
      this.consumeIterator(
        subscription,
        iterator,
        onNext,
        onComplete,
        onError
      );

      return subscription;
    } catch (error) {
      // A subscription torn down mid-setup has nobody left to report to
      if (!this.isCurrent(subscription)) {
        subscription.status = 'completed';
        return subscription;
      }
      subscription.status = 'error';
      const message = error instanceof Error ? error.message : 'Subscription failed';
      onError([{ message }]);
      this.unsubscribe(connectionId, subscriptionId);
      return subscription;
    }
  }

  /**
   * Whether this exact subscription object is still the one registered under
   * its connection and id. An id lookup alone is not enough: after a
   * teardown the id can be registered again by a NEWER subscription.
   */
  private isCurrent(subscription: Subscription): boolean {
    return this.getSubscription(subscription.connectionId, subscription.id) === subscription;
  }

  /**
   * Consume an async iterator and call callbacks
   */
  private async consumeIterator(
    subscription: Subscription,
    iterator: AsyncIterableIterator<GraphQLResponse>,
    onNext: (result: GraphQLResponse) => void,
    onComplete: () => void,
    onError: (errors: readonly { message: string }[]) => void
  ): Promise<void> {
    const { connectionId, id: subscriptionId } = subscription;
    try {
      for await (const result of iterator) {
        // Identity, not just the id: a reused id belongs to a newer
        // subscription whose client must never see this stream's events
        if (!this.isCurrent(subscription) || subscription.status !== 'active') {
          break;
        }

        onNext(result);
      }

      if (this.isCurrent(subscription)) {
        subscription.status = 'completed';
        onComplete();
        this.unsubscribe(connectionId, subscriptionId);
      }
    } catch (error) {
      if (this.isCurrent(subscription)) {
        subscription.status = 'error';
        const message = error instanceof Error ? error.message : 'Subscription error';
        onError([{ message }]);
        this.unsubscribe(connectionId, subscriptionId);
      }
    }
  }

  /**
   * Unsubscribe from a subscription.
   *
   * Both identifiers are required: a subscription id is only unique within
   * its connection, so a lookup by id alone would tear down whichever
   * connection happened to register that id last.
   */
  public unsubscribe(connectionId: string, subscriptionId: string): boolean {
    const connectionSubs = this.connections.get(connectionId);
    const subscription = connectionSubs?.get(subscriptionId);
    if (!connectionSubs || !subscription) {
      return false;
    }

    // Clean up
    subscription.cleanup?.();

    // Close the iterator
    if (subscription.iterator?.return) {
      subscription.iterator.return().catch(() => {});
    }

    // Remove from maps
    connectionSubs.delete(subscriptionId);
    if (connectionSubs.size === 0) {
      this.connections.delete(connectionId);
    }

    return true;
  }

  /**
   * Unsubscribe all subscriptions for a connection
   */
  public unsubscribeConnection(connectionId: string): number {
    const connectionSubs = this.connections.get(connectionId);
    if (!connectionSubs) {
      return 0;
    }

    let count = 0;
    // Snapshot the ids: unsubscribe mutates the map being iterated
    for (const subscriptionId of [...connectionSubs.keys()]) {
      if (this.unsubscribe(connectionId, subscriptionId)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Get a subscription by connection and subscription ID
   */
  public getSubscription(
    connectionId: string,
    subscriptionId: string
  ): Subscription | undefined {
    return this.connections.get(connectionId)?.get(subscriptionId);
  }

  /**
   * Get all subscriptions for a connection
   */
  public getConnectionSubscriptions(connectionId: string): Subscription[] {
    const connectionSubs = this.connections.get(connectionId);
    return connectionSubs ? [...connectionSubs.values()] : [];
  }

  /**
   * Get the total number of tracked subscriptions (any status:
   * 'pending' | 'active' | 'completed' | 'error')
   */
  public get subscriptionCount(): number {
    let total = 0;
    for (const connectionSubs of this.connections.values()) {
      total += connectionSubs.size;
    }
    return total;
  }

  /**
   * Get the number of active connections
   */
  public get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Clear all subscriptions
   */
  public clear(): void {
    // Snapshot the connection ids: unsubscribeConnection mutates the map
    for (const connectionId of [...this.connections.keys()]) {
      this.unsubscribeConnection(connectionId);
    }
  }
}

/**
 * Create a new subscription manager
 */
export function createSubscriptionManager(
  config: SubscriptionManagerConfig
): SubscriptionManager {
  return new SubscriptionManager(config);
}
