/**
 * @leaven-graphql/errors - Type guards
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

/**
 * Check whether a value is a plain object: one whose prototype is
 * `Object.prototype` or `null`. Arrays, `Date`, `Map` and class instances are
 * rejected.
 *
 * @param value - The value to test
 * @returns True when `value` is a plain object
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
