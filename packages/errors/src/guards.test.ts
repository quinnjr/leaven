/**
 * @leaven-graphql/errors - Type guard tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { isPlainObject } from './guards';

describe('isPlainObject', () => {
  test('should return true for plain object literals', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  test('should accept Object.create(null)', () => {
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  test('should reject Date, Map and class instances', () => {
    class Foo {}
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Foo())).toBe(false);
  });

  test('should return false for null, arrays and primitives', () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(1)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});
