/**
 * @leaven-graphql/core - Executor cache failure and validation-cache hook tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { buildSchema } from 'graphql';
import { DocumentCache } from './cache';
import { LeavenExecutor, isRequestRejection } from './executor';

const schema = buildSchema(`type Query { hello: String }`);
const rootValue = { hello: () => 'world' };

class FailingReadCache extends DocumentCache {
  public override get(): never {
    throw new Error('redis down');
  }
  public override getWithValidation(): never {
    throw new Error('redis down');
  }
}

describe('cache read failures', () => {
  test('should treat a throwing getWithValidation as a miss and report it via onCacheError', async () => {
    const errors: Error[] = [];
    const executor = new LeavenExecutor({
      schema,
      rootValue,
      cache: new FailingReadCache(),
      hooks: { onCacheError: (e) => void errors.push(e) },
    });

    const result = await executor.execute({ query: '{ hello }' });

    expect(result.response.errors).toBeUndefined();
    expect(result.response.data).toEqual({ hello: 'world' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toBe('redis down');
  });

  test('should treat a rejecting async getWithValidation as a miss', async () => {
    const errors: Error[] = [];
    class AsyncFailing extends DocumentCache {
      public override getWithValidation(): never {
        return Promise.reject(new Error('timeout')) as never;
      }
    }
    const executor = new LeavenExecutor({
      schema,
      rootValue,
      cache: new AsyncFailing(),
      hooks: { onCacheError: (e) => void errors.push(e) },
    });

    const result = await executor.execute({ query: '{ hello }' });

    expect(result.response.data).toEqual({ hello: 'world' });
    expect(errors.map((e) => e.message)).toContain('timeout');
  });

  test('should still tag genuine parse errors as rejections when the cache fails', async () => {
    const executor = new LeavenExecutor({ schema, rootValue, cache: new FailingReadCache() });
    const result = await executor.execute({ query: '{ hello' });
    expect(result.response.errors).toBeDefined();
    expect(isRequestRejection(result.response)).toBe(true);
  });

  test('should not tag a cache failure as a rejection', async () => {
    const executor = new LeavenExecutor({ schema, rootValue, cache: new FailingReadCache() });
    const result = await executor.execute({ query: '{ hello }' });
    expect(isRequestRejection(result.response)).toBe(false);
  });

  test('should fall back to parsing in parse() when the cache read throws', async () => {
    const errors: Error[] = [];
    const executor = new LeavenExecutor({
      schema,
      cache: new FailingReadCache(),
      hooks: { onCacheError: (e) => void errors.push(e) },
    });

    const document = await executor.parse('{ hello }');

    expect(document.kind).toBe('Document');
    expect(errors).toHaveLength(1);
  });
});

describe('onValidate on a validation cache hit', () => {
  test('should skip onValidate but still fire onValidated', async () => {
    const calls: string[] = [];
    // Records when the fire-and-forget validation write lands
    let validationStored = false;
    class RecordingCache extends DocumentCache {
      public override setWithValidation(
        ...args: Parameters<DocumentCache['setWithValidation']>
      ): void {
        super.setWithValidation(...args);
        validationStored = true;
      }
      public override setValidation(
        ...args: Parameters<DocumentCache['setValidation']>
      ): void {
        super.setValidation(...args);
        validationStored = true;
      }
    }
    const cache = new RecordingCache();
    const executor = new LeavenExecutor({
      schema,
      rootValue,
      cache,
      hooks: {
        onValidate: () => void calls.push('onValidate'),
        onValidated: () => void calls.push('onValidated'),
      },
    });

    await executor.execute({ query: '{ hello }' });
    expect(calls).toEqual(['onValidate', 'onValidated']);

    calls.length = 0;
    // The validation verdict is cached by a fire-and-forget write: poll
    // (bounded) until the cache reports it instead of sleeping a fixed time.
    const deadline = Date.now() + 1000;
    while (!validationStored && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(validationStored).toBe(true);
    const second = await executor.execute({ query: '{ hello }' });
    expect(second.response.data).toEqual({ hello: 'world' });
    expect(calls).toEqual(['onValidated']);
  });
});
