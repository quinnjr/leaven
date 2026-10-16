/**
 * @leaven-graphql/core - Compiled query cache tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { buildSchema, parse } from 'graphql';
import { CompiledQueryCache } from './compiled-cache';
import { compileQuery, type CompiledQuery } from './compiler';
import { AST_BYTES_PER_QUERY_CHAR } from './cache';

const schema = buildSchema('type Query { hello: String }');
const plan: CompiledQuery = compileQuery(schema, parse('{ hello }'));
/** A distinct query string of exactly `length` characters */
const q = (id: number, length: number): string => `${id}:`.padEnd(length, 'x');

describe('CompiledQueryCache', () => {
  test('should store and return plans, refreshing recency on get', () => {
    const cache = new CompiledQueryCache(2, 1_000_000_000);
    cache.set('a', q(1, 10), plan);
    cache.set('b', q(2, 10), plan);
    expect(cache.get('a')).toBe(plan);

    cache.set('c', q(3, 10), plan);
    expect(cache.get('a')).toBe(plan);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  test('should evict LRU entries once the byte budget would be exceeded', () => {
    const cache = new CompiledQueryCache(1000, 100 * AST_BYTES_PER_QUERY_CHAR);
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, q(i, 10), plan);
    expect(cache.bytes).toBe(100 * AST_BYTES_PER_QUERY_CHAR);

    cache.get('k0');
    cache.set('k10', q(10, 10), plan);

    expect(cache.size).toBe(10);
    expect(cache.bytes).toBe(100 * AST_BYTES_PER_QUERY_CHAR);
    expect(cache.get('k0')).toBe(plan);
    expect(cache.get('k1')).toBeUndefined();
  });

  test('should refuse an entry above maxBytes / 10 without evicting anything', () => {
    const cache = new CompiledQueryCache(1000, 100 * AST_BYTES_PER_QUERY_CHAR);
    cache.set('small', q(1, 10), plan);
    cache.set('big', q(2, 11), plan);

    expect(cache.get('big')).toBeUndefined();
    expect(cache.get('small')).toBe(plan);
    expect(cache.size).toBe(1);
  });

  test('should keep the byte count exact through overwrite and clear', () => {
    const cache = new CompiledQueryCache(1000, 1_000_000_000);
    cache.set('a', q(1, 10), plan);
    cache.set('a', q(1, 10), plan);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(10 * AST_BYTES_PER_QUERY_CHAR);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  test('should report its limits', () => {
    const cache = new CompiledQueryCache(7, 1234);
    expect(cache.maxSize).toBe(7);
    expect(cache.maxBytes).toBe(1234);
  });
});
