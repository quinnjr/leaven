/**
 * @leaven-graphql/nestjs - Topic index for topic-keyed subscription delivery
 *
 * Internal to the package: owned by `SubscriptionManager` and not exported
 * from `index.ts`.
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

/**
 * Topic -> subscriber entries, so a publish touches only the subscribers of
 * one topic instead of scanning every connection.
 *
 * Entries are compared by identity: the caller keeps the exact entry it
 * added and hands that same object back to {@link remove}, which makes
 * removal a direct `Set.delete` rather than a scan. A topic's set is dropped
 * once its last subscriber leaves, so the index cannot grow with every topic
 * ever used.
 */
export class TopicIndex<TEntry> {
  private readonly topics = new Map<string, Set<TEntry>>();

  /**
   * Add a subscriber entry under a topic.
   *
   * @param topic - Server-side topic
   * @param entry - The entry to index; keep it to pass to {@link remove}
   */
  public add(topic: string, entry: TEntry): void {
    let subscribers = this.topics.get(topic);
    if (!subscribers) {
      subscribers = new Set();
      this.topics.set(topic, subscribers);
    }
    subscribers.add(entry);
  }

  /**
   * Remove a subscriber entry from a topic, dropping the topic once empty.
   *
   * @param topic - Server-side topic the entry was added under
   * @param entry - The exact entry passed to {@link add}
   * @returns `true` if the entry was indexed and has been removed
   */
  public remove(topic: string, entry: TEntry): boolean {
    const subscribers = this.topics.get(topic);
    if (!subscribers) {
      return false;
    }
    const removed = subscribers.delete(entry);
    if (subscribers.size === 0) {
      this.topics.delete(topic);
    }
    return removed;
  }

  /**
   * The subscribers of a topic.
   *
   * @param topic - Server-side topic
   * @returns The live set of entries, or `undefined` when the topic has none.
   *   Callers that may mutate the index while iterating must snapshot it.
   */
  public subscribers(topic: string): ReadonlySet<TEntry> | undefined {
    return this.topics.get(topic);
  }

  /**
   * Remove every topic and entry.
   */
  public clear(): void {
    this.topics.clear();
  }
}
