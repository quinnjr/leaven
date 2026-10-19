/**
 * @leaven-graphql/nestjs - NODE_ENV test helper tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { withNodeEnv } from './env';

describe('withNodeEnv', () => {
  test('should set NODE_ENV for the callback and restore the previous value', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const seen = await withNodeEnv('production', () => process.env.NODE_ENV);
      expect(seen).toBe('production');
      expect(process.env.NODE_ENV).toBe('test');
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  });

  test('should delete an originally unset NODE_ENV and restore on throw', async () => {
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      await expect(
        withNodeEnv('production', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect('NODE_ENV' in process.env).toBe(false);
    } finally {
      if (saved !== undefined) process.env.NODE_ENV = saved;
    }
  });
});
