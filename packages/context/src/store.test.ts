/**
 * @leaven-graphql/context - Store tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { ContextStore, createContextStore } from './store';
import type { BaseContext } from './types';

interface TestContext extends BaseContext {
  userId?: string;
}

describe('ContextStore', () => {
  let store: ContextStore<TestContext>;

  beforeEach(() => {
    store = new ContextStore<TestContext>();
  });

  afterEach(() => {
    store.dispose();
  });

  describe('constructor', () => {
    test('should create store with default options', () => {
      expect(store).toBeDefined();
      expect(store.activeCount).toBe(0);
    });

    test('should create store with auto cleanup', () => {
      const cleanupStore = new ContextStore<TestContext>({
        autoCleanup: true,
        cleanupInterval: 1000,
      });
      expect(cleanupStore).toBeDefined();
      cleanupStore.dispose();
    });
  });

  describe('run', () => {
    test('should run function with context', () => {
      const context: TestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
        userId: 'user-1',
      };

      const result = store.run(context, () => {
        const ctx = store.getContext();
        return ctx?.userId;
      });

      expect(result).toBe('user-1');
    });

    test('should clean up after function completes', () => {
      const context: TestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
      };

      store.run(context, () => {
        expect(store.activeCount).toBe(1);
      });

      expect(store.activeCount).toBe(0);
    });

    test('should clean up on error', () => {
      const context: TestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
      };

      try {
        store.run(context, () => {
          throw new Error('Test error');
        });
      } catch {
        // Expected
      }

      expect(store.activeCount).toBe(0);
    });
  });

  describe('runAsync', () => {
    test('should run async function with context', async () => {
      const context: TestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
        userId: 'user-1',
      };

      const result = await store.runAsync(context, async () => {
        await new Promise((r) => setTimeout(r, 10));
        const ctx = store.getContext();
        return ctx?.userId;
      });

      expect(result).toBe('user-1');
    });

    test('should clean up after async function completes', async () => {
      const context: TestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
      };

      await store.runAsync(context, async () => {
        expect(store.activeCount).toBe(1);
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(store.activeCount).toBe(0);
    });
  });

  describe('getContext', () => {
    test('should return undefined outside of run', () => {
      expect(store.getContext()).toBeUndefined();
    });

    test('should return context inside run', () => {
      const context: TestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
      };

      store.run(context, () => {
        expect(store.getContext()).toBeDefined();
        expect(store.getContext()?.requestId).toBe('test-123');
      });
    });
  });

  describe('requireContext', () => {
    test('should throw outside of run', () => {
      expect(() => store.requireContext()).toThrow(/No context available/);
    });

    test('should return context inside run', () => {
      const context: TestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
      };

      store.run(context, () => {
        const ctx = store.requireContext();
        expect(ctx.requestId).toBe('test-123');
      });
    });
  });

  describe('getByRequestId', () => {
    test('should get context by request ID', () => {
      const context: TestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
        userId: 'user-1',
      };

      store.run(context, () => {
        const retrieved = store.getByRequestId('test-123');
        expect(retrieved?.userId).toBe('user-1');
      });
    });

    test('should return undefined for unknown request ID', () => {
      expect(store.getByRequestId('unknown')).toBeUndefined();
    });
  });

  describe('activeCount', () => {
    test('should track active contexts', async () => {
      expect(store.activeCount).toBe(0);

      const context1: TestContext = {
        requestId: 'test-1',
        startTime: Date.now(),
      };
      const context2: TestContext = {
        requestId: 'test-2',
        startTime: Date.now(),
      };

      // Run concurrently
      const p1 = store.runAsync(context1, async () => {
        expect(store.activeCount).toBeGreaterThanOrEqual(1);
        await new Promise((r) => setTimeout(r, 50));
      });

      const p2 = store.runAsync(context2, async () => {
        expect(store.activeCount).toBeGreaterThanOrEqual(1);
        await new Promise((r) => setTimeout(r, 50));
      });

      await Promise.all([p1, p2]);
      expect(store.activeCount).toBe(0);
    });
  });

  describe('getActiveRequestIds', () => {
    test('should return active request IDs', () => {
      const context: TestContext = {
        requestId: 'test-123',
        startTime: Date.now(),
      };

      store.run(context, () => {
        const ids = store.getActiveRequestIds();
        expect(ids).toContain('test-123');
      });
    });
  });

  describe('cleanup', () => {
    test('should find nothing to clean under normal usage', () => {
      // cleanup() is documented as a safety net only: run/runAsync always
      // delete their entry on completion, so contexts created through the
      // public API never linger and cleanup has nothing to do.
      const cleaned = store.cleanup(0);
      expect(cleaned).toBe(0);
    });
  });

  describe('dispose', () => {
    test('should clear all contexts and stop the cleanup timer', async () => {
      const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
      const cleanupStore = new ContextStore<TestContext>({
        autoCleanup: true,
        cleanupInterval: 100,
      });
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const run = cleanupStore.runAsync(
        { requestId: 'hung', startTime: Date.now() } as TestContext,
        () => gate
      );
      expect(cleanupStore.activeCount).toBe(1);

      try {
        cleanupStore.dispose();
        expect(cleanupStore.activeCount).toBe(0);
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      } finally {
        clearIntervalSpy.mockRestore();
        finish();
        await run;
      }
    });
  });
});

describe('ContextStore duplicate request IDs', () => {
  test('should keep the outer entry after a nested run with the same ID', () => {
    const store = new ContextStore<TestContext>();
    const ctx = (): TestContext => ({ requestId: 'dup', startTime: Date.now() }) as TestContext;
    const outerCtx = ctx();
    store.run(outerCtx, () => {
      store.run(ctx(), () => {});
      expect(store.getByRequestId('dup')).toBe(outerCtx);
    });
    expect(store.getByRequestId('dup')).toBeUndefined();
    store.dispose();
  });
});

describe('ContextStore overlapping runs with the same requestId', () => {
  test('should fall back to the still-active run when a later run finishes first', async () => {
    const store = new ContextStore<TestContext>();
    const ctxA = { requestId: 'dup', startTime: 1 } as TestContext;
    const ctxB = { requestId: 'dup', startTime: 2 } as TestContext;
    let finishA!: () => void;
    const gateA = new Promise<void>((r) => {
      finishA = r;
    });
    const runA = store.runAsync(ctxA, () => gateA);
    await store.runAsync(ctxB, async () => {
      expect(store.getByRequestId('dup')).toBe(ctxB);
    });
    expect(store.getByRequestId('dup')).toBe(ctxA);
    expect(store.activeCount).toBe(1);
    finishA();
    await runA;
    expect(store.getByRequestId('dup')).toBeUndefined();
    expect(store.activeCount).toBe(0);
    store.dispose();
  });
});

describe('ContextStore cleanup of hung runs', () => {
  const ctx = (): TestContext => ({ requestId: 'dup', startTime: Date.now() }) as TestContext;

  test('should reap a hung run entry after maxAge and make its later release a no-op', async () => {
    const store = new ContextStore<TestContext>();
    let finishA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      finishA = resolve;
    });
    const runA = store.runAsync(ctx(), () => gateA);
    expect(store.cleanup(300000)).toBe(0);
    expect(store.cleanup(-1)).toBe(1);
    expect(store.getByRequestId('dup')).toBeUndefined();
    expect(store.activeCount).toBe(0);

    finishA();
    await runA;
    expect(store.activeCount).toBe(0);
    store.dispose();
  });

  test('should not let a reaped run release a later run entry', async () => {
    const store = new ContextStore<TestContext>();
    let finishA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      finishA = resolve;
    });
    let finishB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      finishB = resolve;
    });
    const runA = store.runAsync(ctx(), () => gateA);
    expect(store.cleanup(-1)).toBe(1);

    const ctxB = ctx();
    const runB = store.runAsync(ctxB, () => gateB);
    finishA();
    await runA;
    expect(store.getByRequestId('dup')).toBe(ctxB);

    finishB();
    await runB;
    expect(store.getByRequestId('dup')).toBeUndefined();
    store.dispose();
  });

  test('should reap only the older entry when a request ID has overlapping runs of different ages', async () => {
    const store = new ContextStore<TestContext>();
    let finishA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      finishA = resolve;
    });
    let finishB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      finishB = resolve;
    });
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const runA = store.runAsync(ctx(), () => gateA);
      now += 30;
      const ctxB = ctx();
      const runB = store.runAsync(ctxB, () => gateB);

      expect(store.cleanup(15)).toBe(1);
      expect(store.getByRequestId('dup')).toBe(ctxB);
      expect(store.activeCount).toBe(1);

      finishA();
      await runA;
      finishB();
      await runB;
      expect(store.activeCount).toBe(0);
      expect(store.getByRequestId('dup')).toBeUndefined();
    } finally {
      Date.now = realNow;
      store.dispose();
    }
  });

  test('should reap a hung run through the autoCleanup timer', async () => {
    const store = new ContextStore<TestContext>({ autoCleanup: true, cleanupInterval: 5 });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = store.runAsync(ctx(), () => gate);
    expect(store.activeCount).toBe(1);

    // The timer reaps entries older than the default 5 minute maxAge, so age
    // the entry by moving the clock forward instead of waiting.
    const realNow = Date.now;
    Date.now = () => realNow() + 301000;
    try {
      const deadline = realNow() + 1000;
      while (store.activeCount > 0 && realNow() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(store.activeCount).toBe(0);
    } finally {
      Date.now = realNow;
      store.dispose();
    }

    finish();
    await run;
    expect(store.activeCount).toBe(0);
  });
});

describe('createContextStore', () => {
  test('should create a ContextStore', () => {
    const store = createContextStore<TestContext>();
    expect(store).toBeInstanceOf(ContextStore);
    store.dispose();
  });

  test('should accept config options', () => {
    const store = createContextStore<TestContext>({
      autoCleanup: true,
      cleanupInterval: 5000,
    });
    expect(store).toBeInstanceOf(ContextStore);
    store.dispose();
  });
});
