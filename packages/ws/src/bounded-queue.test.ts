/**
 * @leaven-graphql/ws - BoundedQueue tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { BoundedQueue } from './bounded-queue';

describe('BoundedQueue', () => {
  test('should preserve FIFO order', () => {
    const q = new BoundedQueue<number>();
    for (let i = 0; i < 5; i++) q.push(i);
    expect([q.shift(), q.shift(), q.shift()]).toEqual([0, 1, 2]);
    expect(q.size).toBe(2);
  });

  test('should drop the oldest item at capacity and report it', () => {
    const q = new BoundedQueue<number>(2);
    expect(q.push(1)).toBe(false);
    expect(q.push(2)).toBe(false);
    expect(q.push(3)).toBe(true);
    expect([q.shift(), q.shift(), q.shift()]).toEqual([2, 3, undefined]);
  });

  test('should keep storage bounded for a consumer that stays one behind', () => {
    const q = new BoundedQueue<number>();
    q.push(0);
    let max = 0;
    for (let i = 1; i <= 10_000; i++) {
      q.push(i);
      expect(q.shift()).toBe(i - 1);
      max = Math.max(max, (q as unknown as { items: unknown[] }).items.length);
    }
    expect(q.size).toBe(1);
    // Compaction runs once the dead prefix reaches 1024 and is at least half
    // the array, so with at most 2 live items the array never exceeds
    // 1024 (dead prefix) + 2 (live).
    expect(max).toBeLessThanOrEqual(1024 + 2);
  });

  test('should hold only the latest item with capacity 1', () => {
    const q = new BoundedQueue<number>(1);
    expect(q.push(1)).toBe(false);
    expect(q.push(2)).toBe(true);
    expect(q.size).toBe(1);
    expect(q.shift()).toBe(2);
  });

  test('should empty on clear', () => {
    const q = new BoundedQueue<number>();
    q.push(1);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.shift()).toBeUndefined();
  });
});
