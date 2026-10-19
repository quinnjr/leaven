/**
 * @leaven-graphql/context - Context store for async local storage
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BaseContext } from './types';

/**
 * Configuration for the context store
 */
export interface ContextStoreConfig {
  /**
   * Enable a periodic cleanup timer.
   *
   * Contexts entered via {@link ContextStore.run} or
   * {@link ContextStore.runAsync} are removed automatically when the function
   * completes (even on error). The timer additionally reaps any run older
   * than 5 minutes (the default `maxAge` of {@link ContextStore.cleanup}; it
   * is not configurable here), checked every `cleanupInterval` (default 60
   * seconds), including runs that are still in flight. A long-running request
   * therefore vanishes from {@link ContextStore.getByRequestId} once it is
   * older than 5 minutes. Call `cleanup(maxAge)` yourself for another age.
   */
  autoCleanup?: boolean;
  /** Cleanup interval in milliseconds */
  cleanupInterval?: number;
}

/**
 * Stored context with metadata
 */
export interface StoredContext<TContext extends BaseContext> {
  /** The context */
  context: TContext;
  /** When the context was stored */
  storedAt: number;
  /** Request ID */
  requestId: string;
}

/**
 * Store for managing request contexts using AsyncLocalStorage
 */
export class ContextStore<TContext extends BaseContext> {
  private readonly storage: AsyncLocalStorage<TContext>;
  /** Stack of in-flight runs per request ID; the last entry is the most recent. */
  private readonly activeContexts: Map<string, StoredContext<TContext>[]>;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: ContextStoreConfig = {}) {
    this.storage = new AsyncLocalStorage<TContext>();
    this.activeContexts = new Map();

    if (config.autoCleanup) {
      const interval = config.cleanupInterval ?? 60000; // Default: 1 minute
      this.cleanupTimer = setInterval(() => this.cleanup(), interval);
      // Don't keep the process alive just for the cleanup timer
      this.cleanupTimer.unref?.();
    }
  }

  private register(context: TContext): StoredContext<TContext> {
    const entry: StoredContext<TContext> = {
      context,
      storedAt: Date.now(),
      requestId: context.requestId,
    };
    const stack = this.activeContexts.get(context.requestId);
    if (stack) {
      stack.push(entry);
    } else {
      this.activeContexts.set(context.requestId, [entry]);
    }
    return entry;
  }

  /**
   * Drop one run's own entry. The request ID falls back to the previous
   * active run, and is removed once no run with that ID is still active.
   */
  private release(entry: StoredContext<TContext>): void {
    const stack = this.activeContexts.get(entry.requestId);
    if (!stack) {
      return;
    }
    const index = stack.lastIndexOf(entry);
    if (index !== -1) {
      stack.splice(index, 1);
    }
    if (stack.length === 0) {
      this.activeContexts.delete(entry.requestId);
    }
  }

  /**
   * Run a function with a context
   */
  public run<T>(context: TContext, fn: () => T): T {
    const entry = this.register(context);

    try {
      return this.storage.run(context, fn) as T;
    } finally {
      this.release(entry);
    }
  }

  /**
   * Run an async function with a context
   */
  public async runAsync<T>(context: TContext, fn: () => Promise<T>): Promise<T> {
    const entry = this.register(context);

    try {
      return (await this.storage.run(context, fn)) as T;
    } finally {
      this.release(entry);
    }
  }

  /**
   * Get the current context
   */
  public getContext(): TContext | undefined {
    return this.storage.getStore();
  }

  /**
   * Get the current context or throw if not available
   */
  public requireContext(): TContext {
    const context = this.storage.getStore();
    if (!context) {
      throw new Error('No context available. Are you running inside a request?');
    }
    return context;
  }

  /**
   * Get a context by request ID
   */
  public getByRequestId(requestId: string): TContext | undefined {
    return this.activeContexts.get(requestId)?.at(-1)?.context;
  }

  /**
   * Get the number of distinct request IDs that have at least one active run
   */
  public get activeCount(): number {
    return this.activeContexts.size;
  }

  /**
   * Get all active request IDs
   */
  public getActiveRequestIds(): string[] {
    return Array.from(this.activeContexts.keys());
  }

  /**
   * Remove individual stored entries whose `storedAt` is older than `maxAge`
   * milliseconds, whether or not their run is still in flight, and drop a
   * request ID once its stack is empty. Returns the number of entries removed.
   *
   * This reaps runs that never settle (for example a hung promise). It is safe
   * because `release` removes a run's own entry by identity: if the entry was
   * already reaped, its later release is a no-op and cannot touch a newer run's
   * entry for the same request ID.
   */
  public cleanup(maxAge: number = 300000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [requestId, stack] of this.activeContexts) {
      const kept = stack.filter((entry) => now - entry.storedAt <= maxAge);
      cleaned += stack.length - kept.length;
      if (kept.length === 0) {
        this.activeContexts.delete(requestId);
      } else if (kept.length !== stack.length) {
        stack.splice(0, stack.length, ...kept);
      }
    }

    return cleaned;
  }

  /**
   * Dispose of the store and cleanup resources
   */
  public dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.activeContexts.clear();
  }
}

/**
 * Create a new context store
 */
export function createContextStore<TContext extends BaseContext>(
  config?: ContextStoreConfig
): ContextStore<TContext> {
  return new ContextStore<TContext>(config);
}
