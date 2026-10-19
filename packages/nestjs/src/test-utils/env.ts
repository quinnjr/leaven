/**
 * @leaven-graphql/nestjs - Shared test helpers for NODE_ENV
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

/**
 * Run `fn` with `NODE_ENV` set to `value`, then restore it.
 *
 * Assigning `undefined` to a `process.env` key stores the string
 * "undefined", so a variable that was originally unset is deleted instead.
 *
 * @param value - The `NODE_ENV` to run under
 * @param fn - The (possibly async) body to run
 * @returns Whatever `fn` returns
 */
export async function withNodeEnv<T>(value: string, fn: () => T | Promise<T>): Promise<T> {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = original;
    }
  }
}
