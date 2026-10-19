/**
 * @leaven-graphql/ws - Bounded FIFO queue (internal)
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

/** Dead-prefix length at which {@link BoundedQueue} compacts its storage. */
const COMPACT_THRESHOLD = 1024;

/**
 * FIFO queue with an optional capacity (drop-oldest) and an internal head
 * index, so push/shift are O(1) amortised. Storage is compacted on both push
 * and shift once the dead prefix reaches {@link COMPACT_THRESHOLD} and
 * dominates the array, so a consumer that lags slightly never grows it
 * without bound.
 *
 * @internal
 */
export class BoundedQueue<T> {
  private items: T[] = [];
  private head = 0;

  constructor(private readonly capacity: number = Infinity) {}

  /** Number of live items. */
  public get size(): number {
    return this.items.length - this.head;
  }

  /**
   * Append an item, evicting the oldest when at capacity.
   * @returns whether an item was dropped
   */
  public push(item: T): boolean {
    let dropped = false;
    if (this.size >= this.capacity) {
      this.dropHead();
      dropped = true;
    }
    this.items.push(item);
    this.compact();
    return dropped;
  }

  /** Remove and return the oldest item, or undefined when empty. */
  public shift(): T | undefined {
    if (this.size === 0) return undefined;
    const value = this.dropHead();
    this.compact();
    return value;
  }

  /** Discard all items. */
  public clear(): void {
    this.items = [];
    this.head = 0;
  }

  private dropHead(): T | undefined {
    if (this.size === 0) return undefined;
    const value = this.items[this.head] as T;
    this.items[this.head] = undefined as T;
    this.head++;
    return value;
  }

  private compact(): void {
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head >= COMPACT_THRESHOLD && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
}
