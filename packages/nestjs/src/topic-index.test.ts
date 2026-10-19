/**
 * @leaven-graphql/nestjs - TopicIndex tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { TopicIndex } from './topic-index';

describe('TopicIndex', () => {
  let index: TopicIndex<{ id: number }>;

  beforeEach(() => {
    index = new TopicIndex();
  });

  test('should return undefined subscribers for an unknown topic', () => {
    expect(index.subscribers('news')).toBeUndefined();
  });

  test('should index entries under a topic and expose them via subscribers', () => {
    const a = { id: 1 };
    const b = { id: 2 };
    index.add('news', a);
    index.add('news', b);
    index.add('news', a);

    const subscribers = index.subscribers('news');
    expect(subscribers?.size).toBe(2);
    expect(subscribers?.has(a)).toBe(true);
    expect(subscribers?.has(b)).toBe(true);
  });

  test('should drop the topic once its last subscriber is removed', () => {
    const a = { id: 1 };
    const b = { id: 2 };
    index.add('news', a);
    index.add('news', b);

    index.remove('news', a);
    expect(index.subscribers('news')?.size).toBe(1);

    index.remove('news', b);
    expect(index.subscribers('news')).toBeUndefined();
  });

  test('should return true only when the removed entry was indexed', () => {
    const a = { id: 1 };
    index.add('news', a);

    expect(index.remove('news', { id: 1 })).toBe(false);
    expect(index.remove('other', a)).toBe(false);
    expect(index.remove('news', a)).toBe(true);
    expect(index.remove('news', a)).toBe(false);
  });

  test('should remove every topic and entry on clear', () => {
    index.add('news', { id: 1 });
    index.add('sports', { id: 2 });
    expect(index.subscribers('news')?.size).toBe(1);
    expect(index.subscribers('sports')?.size).toBe(1);

    index.clear();
    expect(index.subscribers('news')).toBeUndefined();
    expect(index.subscribers('sports')).toBeUndefined();
  });
});
