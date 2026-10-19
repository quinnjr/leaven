/**
 * @leaven-graphql/plugins - Built-in plugins tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { buildSchema, parse } from 'graphql';
import type { DocumentNode } from 'graphql';
import { ComplexityError, DepthLimitError } from '@leaven-graphql/errors';
import { calculateQueryDepth } from '@leaven-graphql/core';
import {
  createPlugin,
  composePlugins,
  createCachingPlugin,
  createLoggingPlugin,
  createTracingPlugin,
  createDepthLimitPlugin,
  createComplexityPlugin,
} from './builtin';
import { PluginManager } from './manager';

const schema = buildSchema(`
  type Query {
    hello: String
    user(id: ID!): User
    users(first: Int): [User!]!
    node: Node
  }
  type User {
    id: ID!
    name: String
    posts: [Post!]!
  }
  type Post {
    id: ID!
    title: String
  }
  type Node {
    id: ID!
    child: Node
    children(first: Int): [Node!]!
  }
`);

describe('createPlugin', () => {
  test('should create a plugin with metadata and hooks', () => {
    const plugin = createPlugin(
      { name: 'test-plugin', version: '1.0.0' },
      {
        beforeParse: (query) => query,
      }
    );

    expect(plugin.metadata.name).toBe('test-plugin');
    expect(plugin.metadata.version).toBe('1.0.0');
    expect(plugin.beforeParse).toBeDefined();
  });
});

describe('composePlugins', () => {
  test('should compose multiple plugins', async () => {
    const calls: string[] = [];

    const plugin1 = createPlugin(
      { name: 'plugin-1' },
      {
        beforeParse: () => {
          calls.push('plugin-1-beforeParse');
        },
      }
    );

    const plugin2 = createPlugin(
      { name: 'plugin-2' },
      {
        beforeParse: () => {
          calls.push('plugin-2-beforeParse');
        },
      }
    );

    const composed = composePlugins('composed', plugin1, plugin2);

    expect(composed.metadata.name).toBe('composed');

    const manager = new PluginManager({ schema });
    await manager.register(composed);

    const context = manager.createContext({ query: '{ hello }' }, {});
    await manager.beforeParse('{ hello }', context);

    expect(calls).toContain('plugin-1-beforeParse');
    expect(calls).toContain('plugin-2-beforeParse');
  });

  test('should chain beforeParse transformations', async () => {
    const plugin1 = createPlugin(
      { name: 'plugin-1' },
      {
        beforeParse: (query) => query.replace('hello', 'hi'),
      }
    );

    const plugin2 = createPlugin(
      { name: 'plugin-2' },
      {
        beforeParse: (query) => query.replace('hi', 'hey'),
      }
    );

    const composed = composePlugins('composed', plugin1, plugin2);

    const manager = new PluginManager({ schema });
    await manager.register(composed);

    const context = manager.createContext({ query: '{ hello }' }, {});
    const result = await manager.beforeParse('{ hello }', context);

    expect(result).toBe('{ hey }');
  });

  test('should call onRegister and onUnregister hooks', async () => {
    const calls: string[] = [];

    const plugin1 = createPlugin(
      { name: 'plugin-1' },
      {
        onRegister: () => {
          calls.push('plugin-1-onRegister');
        },
        onUnregister: () => {
          calls.push('plugin-1-onUnregister');
        },
      }
    );

    const plugin2 = createPlugin(
      { name: 'plugin-2' },
      {
        onRegister: () => {
          calls.push('plugin-2-onRegister');
        },
        onUnregister: () => {
          calls.push('plugin-2-onUnregister');
        },
      }
    );

    const composed = composePlugins('composed', plugin1, plugin2);

    const manager = new PluginManager({ schema });
    await manager.register(composed);

    expect(calls).toContain('plugin-1-onRegister');
    expect(calls).toContain('plugin-2-onRegister');

    await manager.unregister('composed');

    expect(calls).toContain('plugin-1-onUnregister');
    expect(calls).toContain('plugin-2-onUnregister');
  });

  test('should chain afterParse transformations', async () => {
    const calls: string[] = [];

    const plugin1 = createPlugin(
      { name: 'plugin-1' },
      {
        afterParse: (doc) => {
          calls.push('plugin-1-afterParse');
          return doc;
        },
      }
    );

    const plugin2 = createPlugin(
      { name: 'plugin-2' },
      {
        afterParse: (doc) => {
          calls.push('plugin-2-afterParse');
          return doc;
        },
      }
    );

    const composed = composePlugins('composed', plugin1, plugin2);

    const manager = new PluginManager({ schema });
    await manager.register(composed);

    const context = manager.createContext({ query: '{ hello }' }, {});
    const document = parse('{ hello }');

    await manager.afterParse(document, context);

    expect(calls).toContain('plugin-1-afterParse');
    expect(calls).toContain('plugin-2-afterParse');
  });

  test('should call beforeValidate and afterValidate hooks', async () => {
    const calls: string[] = [];

    const plugin1 = createPlugin(
      { name: 'plugin-1' },
      {
        beforeValidate: () => {
          calls.push('plugin-1-beforeValidate');
        },
        afterValidate: () => {
          calls.push('plugin-1-afterValidate');
        },
      }
    );

    const plugin2 = createPlugin(
      { name: 'plugin-2' },
      {
        beforeValidate: () => {
          calls.push('plugin-2-beforeValidate');
        },
        afterValidate: () => {
          calls.push('plugin-2-afterValidate');
        },
      }
    );

    const composed = composePlugins('composed', plugin1, plugin2);

    const manager = new PluginManager({ schema });
    await manager.register(composed);

    const context = manager.createContext({ query: '{ hello }' }, {});
    const document = parse('{ hello }');

    await manager.beforeValidate(document, context);
    await manager.afterValidate({ valid: true, errors: [] }, context);

    expect(calls).toEqual([
      'plugin-1-beforeValidate',
      'plugin-2-beforeValidate',
      'plugin-1-afterValidate',
      'plugin-2-afterValidate',
    ]);
  });

  test('should propagate a short-circuit response from an inner beforeExecute', async () => {
    const calls: string[] = [];

    const plugin1 = createPlugin(
      { name: 'plugin-1' },
      {
        beforeExecute: () => {
          calls.push('plugin-1-beforeExecute');
          return { data: { hello: 'cached' } };
        },
      }
    );

    const plugin2 = createPlugin(
      { name: 'plugin-2' },
      {
        beforeExecute: () => {
          calls.push('plugin-2-beforeExecute');
        },
      }
    );

    const composed = composePlugins('composed', plugin1, plugin2);

    const manager = new PluginManager({ schema });
    await manager.register(composed);

    const context = manager.createContext({ query: '{ hello }' }, {});
    const result = await manager.beforeExecute(parse('{ hello }'), context);

    expect(result).toEqual({ data: { hello: 'cached' } });
    expect(calls).toEqual(['plugin-1-beforeExecute']);
  });

  test('should call beforeExecute hooks', async () => {
    const calls: string[] = [];

    const plugin1 = createPlugin(
      { name: 'plugin-1' },
      {
        beforeExecute: () => {
          calls.push('plugin-1-beforeExecute');
        },
      }
    );

    const plugin2 = createPlugin(
      { name: 'plugin-2' },
      {
        beforeExecute: () => {
          calls.push('plugin-2-beforeExecute');
        },
      }
    );

    const composed = composePlugins('composed', plugin1, plugin2);

    const manager = new PluginManager({ schema });
    await manager.register(composed);

    const context = manager.createContext({ query: '{ hello }' }, {});
    const document = parse('{ hello }');

    await manager.beforeExecute(document, context);

    expect(calls).toContain('plugin-1-beforeExecute');
    expect(calls).toContain('plugin-2-beforeExecute');
  });

  test('should chain afterExecute hooks in reverse order', async () => {
    const calls: string[] = [];

    const plugin1 = createPlugin(
      { name: 'plugin-1' },
      {
        afterExecute: (res) => {
          calls.push('plugin-1-afterExecute');
          return res;
        },
      }
    );

    const plugin2 = createPlugin(
      { name: 'plugin-2' },
      {
        afterExecute: (res) => {
          calls.push('plugin-2-afterExecute');
          return res;
        },
      }
    );

    const composed = composePlugins('composed', plugin1, plugin2);

    const manager = new PluginManager({ schema });
    await manager.register(composed);

    const context = manager.createContext({ query: '{ hello }' }, {});

    await manager.afterExecute({ data: { hello: 'world' } }, context);

    expect(calls).toContain('plugin-1-afterExecute');
    expect(calls).toContain('plugin-2-afterExecute');
  });

  test('should chain onError hooks', async () => {
    const calls: string[] = [];

    const plugin1 = createPlugin(
      { name: 'plugin-1' },
      {
        onError: (err) => {
          calls.push('plugin-1-onError');
          return err;
        },
      }
    );

    const plugin2 = createPlugin(
      { name: 'plugin-2' },
      {
        onError: (err) => {
          calls.push('plugin-2-onError');
          return err;
        },
      }
    );

    const composed = composePlugins('composed', plugin1, plugin2);

    const manager = new PluginManager({ schema });
    await manager.register(composed);

    const context = manager.createContext({ query: '{ hello }' }, {});

    await manager.onError(new Error('Test error'), context);

    expect(calls).toContain('plugin-1-onError');
    expect(calls).toContain('plugin-2-onError');
  });
});

describe('createCachingPlugin', () => {
  test('should create caching plugin', () => {
    const plugin = createCachingPlugin({ allowSharedCache: true });

    expect(plugin.metadata.name).toBe('caching');
    expect(plugin.beforeExecute).toBeDefined();
    expect(plugin.afterExecute).toBeDefined();
  });

  test('should refuse to construct without an explicit cache-identity decision', () => {
    // A cache hit skips execution (and any field-level authorization), so a
    // key with no caller identity must never be the silent default.
    expect(() => createCachingPlugin()).toThrow(TypeError);
    expect(() => createCachingPlugin()).toThrow(/cache-identity decision/);
    expect(() => createCachingPlugin({ ttl: 60000 })).toThrow(
      /keyFn|allowSharedCache/
    );
    expect(() => createCachingPlugin({ allowSharedCache: false })).toThrow(
      /cache-identity decision/
    );

    // Either explicit choice constructs
    expect(createCachingPlugin({ allowSharedCache: true }).metadata.name).toBe(
      'caching'
    );
    expect(
      createCachingPlugin({ keyFn: (context) => context.request.query }).metadata
        .name
    ).toBe('caching');
  });

  test('should cache responses', async () => {
    const plugin = createCachingPlugin({ ttl: 60000, allowSharedCache: true });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext(
      { query: '{ hello }', variables: {} },
      {}
    );
    const document = parse('{ hello }');

    // First execution - no cache
    await manager.beforeExecute(document, context);
    expect(context.state.get('cacheHit')).toBeFalsy();

    // Store response
    await manager.afterExecute({ data: { hello: 'world' } }, context);

    // Second execution - should hit cache
    const context2 = manager.createContext(
      { query: '{ hello }', variables: {} },
      {}
    );
    await manager.beforeExecute(document, context2);
    expect(context2.state.get('cacheHit')).toBe(true);
  });

  test('should not cache errors', async () => {
    const plugin = createCachingPlugin({ ttl: 60000, allowSharedCache: true });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext(
      { query: '{ hello }', variables: {} },
      {}
    );
    const document = parse('{ hello }');

    await manager.beforeExecute(document, context);

    // Store response with errors
    await manager.afterExecute(
      { data: null, errors: [{ message: 'Error' }] },
      context
    );

    // Second execution - should not hit cache
    const context2 = manager.createContext(
      { query: '{ hello }', variables: {} },
      {}
    );
    await manager.beforeExecute(document, context2);
    expect(context2.state.get('cacheHit')).toBeFalsy();
  });

  test('should return cached response from afterExecute', async () => {
    const plugin = createCachingPlugin({ ttl: 60000, allowSharedCache: true });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext(
      { query: '{ hello }', variables: {} },
      {}
    );
    const document = parse('{ hello }');

    // First execution
    await manager.beforeExecute(document, context);
    await manager.afterExecute({ data: { hello: 'cached' } }, context);

    // Second execution - cache hit
    const context2 = manager.createContext(
      { query: '{ hello }', variables: {} },
      {}
    );
    await manager.beforeExecute(document, context2);
    const response = await manager.afterExecute({ data: { hello: 'new' } }, context2);

    // Should return cached response
    expect(response.data).toEqual({ hello: 'cached' });
  });

  test('should evict old entries when max size reached', async () => {
    const plugin = createCachingPlugin({
      ttl: 60000,
      maxSize: 2,
      allowSharedCache: true,
    });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const document = parse('{ hello }');

    // First query
    const context1 = manager.createContext({ query: '{ hello }', variables: {} }, {});
    await manager.beforeExecute(document, context1);
    await manager.afterExecute({ data: { hello: 'first' } }, context1);

    // Second query
    const context2 = manager.createContext({ query: '{ world }', variables: {} }, {});
    await manager.beforeExecute(document, context2);
    await manager.afterExecute({ data: { world: 'second' } }, context2);

    // Third query - should evict the first one
    const context3 = manager.createContext({ query: '{ foo }', variables: {} }, {});
    await manager.beforeExecute(document, context3);
    await manager.afterExecute({ data: { foo: 'third' } }, context3);

    // First query should miss cache now
    const context4 = manager.createContext({ query: '{ hello }', variables: {} }, {});
    await manager.beforeExecute(document, context4);
    expect(context4.state.get('cacheHit')).toBeFalsy();
  });

  test('should not evict a live entry when overwriting an existing key at capacity', async () => {
    const plugin = createCachingPlugin({
      ttl: 60000,
      maxSize: 2,
      allowSharedCache: true,
    });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const document = parse('{ hello }');

    // Fill the cache to capacity, oldest first: hello, then world
    const hello = manager.createContext({ query: '{ hello }', variables: {} }, {});
    await manager.beforeExecute(document, hello);
    await manager.afterExecute({ data: { hello: 'first' } }, hello);

    const world = manager.createContext({ query: '{ world }', variables: {} }, {});
    await manager.beforeExecute(document, world);
    await manager.afterExecute({ data: { world: 'second' } }, world);

    // A concurrent request for `world` misses in beforeExecute and writes in
    // afterExecute, overwriting an existing key. That does not grow the cache,
    // so it must not evict the unrelated `hello` entry.
    const worldAgain = manager.createContext(
      { query: '{ world }', variables: {} },
      {}
    );
    await manager.afterExecute({ data: { world: 'second again' } }, worldAgain);

    const helloAgain = manager.createContext(
      { query: '{ hello }', variables: {} },
      {}
    );
    await manager.beforeExecute(document, helloAgain);

    expect(helloAgain.state.get('cacheHit')).toBe(true);
  });

  test('should short-circuit execution by returning the cached response from beforeExecute', async () => {
    const plugin = createCachingPlugin({ ttl: 60000, allowSharedCache: true });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const document = parse('{ hello }');

    // Prime the cache
    const context1 = manager.createContext({ query: '{ hello }', variables: {} }, {});
    expect(await manager.beforeExecute(document, context1)).toBeUndefined();
    await manager.afterExecute({ data: { hello: 'cached' } }, context1);

    // Cache hit: the manager surfaces the cached response so the caller can
    // skip execution entirely
    const context2 = manager.createContext({ query: '{ hello }', variables: {} }, {});
    const shortCircuit = await manager.beforeExecute(document, context2);

    expect(shortCircuit).toEqual({ data: { hello: 'cached' } });
  });

  test('should distinguish requests by operationName', async () => {
    const plugin = createCachingPlugin({ ttl: 60000, allowSharedCache: true });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const query = 'query A { hello } query B { hello }';
    const document = parse(query);

    const contextA = manager.createContext(
      { query, operationName: 'A', variables: {} },
      {}
    );
    await manager.beforeExecute(document, contextA);
    await manager.afterExecute({ data: { hello: 'from A' } }, contextA);

    // Same query text, different operation name - must not hit A's entry
    const contextB = manager.createContext(
      { query, operationName: 'B', variables: {} },
      {}
    );
    await manager.beforeExecute(document, contextB);

    expect(contextB.state.get('cacheHit')).toBeFalsy();
  });

  test('should not share cached entries between different keyFn contexts', async () => {
    const plugin = createCachingPlugin({
      ttl: 60000,
      keyFn: (context) =>
        `${(context.context as { userId: string }).userId}:${context.request.query}`,
    });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const document = parse('{ hello }');

    // User A executes and caches
    const contextA = manager.createContext(
      { query: '{ hello }', variables: {} },
      { userId: 'user-a' }
    );
    await manager.beforeExecute(document, contextA);
    await manager.afterExecute({ data: { hello: 'private to A' } }, contextA);

    // User B issues the same query - must NOT be served A's response
    const contextB = manager.createContext(
      { query: '{ hello }', variables: {} },
      { userId: 'user-b' }
    );
    const shortCircuit = await manager.beforeExecute(document, contextB);

    expect(shortCircuit).toBeUndefined();
    expect(contextB.state.get('cacheHit')).toBeFalsy();

    // User A still hits their own entry
    const contextA2 = manager.createContext(
      { query: '{ hello }', variables: {} },
      { userId: 'user-a' }
    );
    await manager.beforeExecute(document, contextA2);
    expect(contextA2.state.get('cacheHit')).toBe(true);
  });

  test('should not serve expired entries', async () => {
    const plugin = createCachingPlugin({ ttl: 1, allowSharedCache: true });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const document = parse('{ hello }');

    const context1 = manager.createContext({ query: '{ hello }', variables: {} }, {});
    await manager.beforeExecute(document, context1);
    await manager.afterExecute({ data: { hello: 'stale' } }, context1);

    // Let the entry expire
    await new Promise((resolve) => setTimeout(resolve, 5));

    const context2 = manager.createContext({ query: '{ hello }', variables: {} }, {});
    const shortCircuit = await manager.beforeExecute(document, context2);

    expect(shortCircuit).toBeUndefined();
    expect(context2.state.get('cacheHit')).toBeFalsy();
  });
});

describe('createLoggingPlugin', () => {
  test('should create logging plugin', () => {
    const plugin = createLoggingPlugin();

    expect(plugin.metadata.name).toBe('logging');
    expect(plugin.beforeExecute).toBeDefined();
    expect(plugin.afterExecute).toBeDefined();
    expect(plugin.onError).toBeDefined();
  });

  test('should log with custom logger', async () => {
    const logs: Array<{ level: string; msg: string }> = [];

    const plugin = createLoggingPlugin({
      level: 'debug',
      logger: {
        debug: (msg) => logs.push({ level: 'debug', msg }),
        info: (msg) => logs.push({ level: 'info', msg }),
        warn: (msg) => logs.push({ level: 'warn', msg }),
        error: (msg) => logs.push({ level: 'error', msg }),
      },
    });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext(
      { query: '{ hello }', operationName: 'TestQuery' },
      {}
    );
    const document = parse('{ hello }');

    await manager.beforeExecute(document, context);
    await manager.afterExecute({ data: { hello: 'world' } }, context);

    expect(logs.length).toBeGreaterThan(0);
  });

  test('should log errors when response has errors', async () => {
    const logs: Array<{ level: string; msg: string }> = [];

    const plugin = createLoggingPlugin({
      level: 'debug',
      logger: {
        debug: (msg) => logs.push({ level: 'debug', msg }),
        info: (msg) => logs.push({ level: 'info', msg }),
        warn: (msg) => logs.push({ level: 'warn', msg }),
        error: (msg) => logs.push({ level: 'error', msg }),
      },
    });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext(
      { query: '{ hello }', operationName: 'TestQuery' },
      {}
    );
    const document = parse('{ hello }');

    await manager.beforeExecute(document, context);
    await manager.afterExecute({ data: null, errors: [{ message: 'Test error' }] }, context);

    expect(logs.some(l => l.level === 'error')).toBe(true);
  });

  test('should log on error handler', async () => {
    const logs: Array<{ level: string; msg: string }> = [];

    const plugin = createLoggingPlugin({
      level: 'debug',
      logger: {
        debug: (msg) => logs.push({ level: 'debug', msg }),
        info: (msg) => logs.push({ level: 'info', msg }),
        warn: (msg) => logs.push({ level: 'warn', msg }),
        error: (msg) => logs.push({ level: 'error', msg }),
      },
    });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext(
      { query: '{ hello }', operationName: 'TestQuery' },
      {}
    );

    await manager.onError(new Error('Execution failed'), context);

    expect(logs.some(l => l.level === 'error')).toBe(true);
  });
});

describe('createTracingPlugin', () => {
  test('should create tracing plugin', () => {
    const plugin = createTracingPlugin();

    expect(plugin.metadata.name).toBe('tracing');
    expect(plugin.beforeExecute).toBeDefined();
    expect(plugin.afterExecute).toBeDefined();
  });

  test('should add tracing to response', async () => {
    const plugin = createTracingPlugin();

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext({ query: '{ hello }' }, {});
    const document = parse('{ hello }');

    await manager.beforeExecute(document, context);

    const response = await manager.afterExecute(
      { data: { hello: 'world' } },
      context
    );

    expect(response.extensions?.tracing).toBeDefined();
    expect((response.extensions?.tracing as { version: number }).version).toBe(1);
    expect((response.extensions?.tracing as { duration: number }).duration).toBeGreaterThan(0);
  });

  test('should measure parsing and validation phases when their hooks run', async () => {
    const plugin = createTracingPlugin();

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext({ query: '{ hello }' }, {});

    await manager.beforeParse('{ hello }', context);
    const document = parse('{ hello }');
    await manager.afterParse(document, context);
    await manager.beforeValidate(document, context);
    await manager.afterValidate({ valid: true, errors: [] }, context);
    await manager.beforeExecute(document, context);

    const response = await manager.afterExecute(
      { data: { hello: 'world' } },
      context
    );

    const tracing = response.extensions?.tracing as {
      duration: number;
      parsing: { startOffset: number; duration: number };
      validation: { startOffset: number; duration: number };
      execution: { startOffset: number; duration: number };
    };

    expect(tracing.parsing).toBeDefined();
    expect(tracing.parsing.startOffset).toBeGreaterThanOrEqual(0);
    expect(tracing.parsing.duration).toBeGreaterThan(0);

    expect(tracing.validation).toBeDefined();
    expect(tracing.validation.startOffset).toBeGreaterThan(tracing.parsing.startOffset);
    expect(tracing.validation.duration).toBeGreaterThan(0);

    expect(tracing.execution).toBeDefined();
    expect(tracing.execution.startOffset).toBeGreaterThan(tracing.validation.startOffset);
    expect(tracing.execution.duration).toBeGreaterThan(0);
    expect(tracing.duration).toBeGreaterThanOrEqual(tracing.execution.duration);
  });

  test('should omit phases that were not measured instead of reporting zero', async () => {
    const plugin = createTracingPlugin();

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext({ query: '{ hello }' }, {});
    const document = parse('{ hello }');

    // Only the execution hooks run in this pipeline
    await manager.beforeExecute(document, context);
    const response = await manager.afterExecute(
      { data: { hello: 'world' } },
      context
    );

    const tracing = response.extensions?.tracing as Record<string, unknown>;

    expect(tracing['parsing']).toBeUndefined();
    expect(tracing['validation']).toBeUndefined();
    expect(tracing['execution']).toBeDefined();
  });
});

/**
 * A document whose fragments chain `levels` deep and spread the NEXT fragment
 * twice per level. Re-expanding every spread would fan out 2^levels times; a
 * walker that measures each fragment once stays linear.
 */
const buildDoublySpreadFragmentChain = (levels: number): string => {
  const parts = ['{ node { ...F0 } }'];
  for (let i = 0; i < levels - 1; i++) {
    parts.push(`fragment F${i} on Node { child { ...F${i + 1} ...F${i + 1} } }`);
  }
  parts.push(`fragment F${levels - 1} on Node { id }`);
  return parts.join('\n');
};

/** A document with more AST nodes than the walkers' visit budget allows. */
const buildOversizedDocument = (): DocumentNode => {
  const fields: string[] = [];
  for (let i = 0; i < 100_001; i++) {
    fields.push(`f${i}`);
  }
  return parse(`{ node { ${fields.join(' ')} } }`);
};

describe('createDepthLimitPlugin', () => {
  /**
   * Exact depth the plugin computes for a query, using a limit of 0 (which
   * every query with at least one field exceeds) as the oracle.
   */
  const measureDepth = async (query: string): Promise<number> => {
    const manager = new PluginManager({ schema });
    await manager.register(createDepthLimitPlugin(0));

    const error = await manager
      .afterParse(parse(query), manager.createContext({ query }, {}))
      .then(
        () => null,
        (e: unknown) => e as DepthLimitError
      );

    if (!error) {
      throw new Error(`expected a depth-limit rejection for ${query}`);
    }
    return error.depth;
  };

  test('should create depth limit plugin', () => {
    const plugin = createDepthLimitPlugin(5);

    expect(plugin.metadata.name).toBe('depth-limit');
    expect(plugin.afterParse).toBeDefined();
  });

  test('should accept the options-object call form', () => {
    const plugin = createDepthLimitPlugin({ maxDepth: 5 });

    expect(plugin.metadata.name).toBe('depth-limit');
    expect(plugin.metadata.description).toBe('Limits query depth to 5');
  });

  test('should throw for non-finite or missing maxDepth', () => {
    expect(() => createDepthLimitPlugin(NaN)).toThrow(
      /finite numeric maxDepth/
    );
    expect(() =>
      createDepthLimitPlugin({} as unknown as { maxDepth: number })
    ).toThrow(/finite numeric maxDepth/);
    expect(() =>
      createDepthLimitPlugin(undefined as unknown as number)
    ).toThrow(/finite numeric maxDepth/);
  });

  test('should allow queries within depth limit', async () => {
    const plugin = createDepthLimitPlugin(5);

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext({ query: '{ hello }' }, {});
    const document = parse('{ hello }');

    // Should not throw
    await manager.afterParse(document, context);
  });

  test('should reject queries exceeding depth limit with a DepthLimitError', async () => {
    const plugin = createDepthLimitPlugin(2);

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext(
      { query: '{ user(id: "1") { posts { title } } }' },
      {}
    );
    const document = parse('{ user(id: "1") { posts { title } } }');

    const error = await manager
      .afterParse(document, context)
      .then(() => null, (e: unknown) => e as DepthLimitError);

    expect(error).toBeInstanceOf(DepthLimitError);
    expect(error!.extensions['code']).toBe('DEPTH_LIMIT');
    expect(error!.statusCode).toBe(400);
    expect(error!.message).toMatch(/exceeds maximum allowed depth/);
  });

  test('should reject queries exceeding depth limit via the options-object form', async () => {
    const plugin = createDepthLimitPlugin({ maxDepth: 2 });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const query = '{ user(id: "1") { posts { title } } }';
    const context = manager.createContext({ query }, {});

    const error = await manager
      .afterParse(parse(query), context)
      .then(() => null, (e: unknown) => e as DepthLimitError);

    expect(error).toBeInstanceOf(DepthLimitError);
  });

  test('should measure depth through fragment spreads', async () => {
    const plugin = createDepthLimitPlugin(2);

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    // user -> posts -> title is depth 3, hidden behind a fragment
    const query = `
      { user(id: "1") { ...UserFields } }
      fragment UserFields on User { posts { title } }
    `;
    const context = manager.createContext({ query }, {});

    const error = await manager
      .afterParse(parse(query), context)
      .then(() => null, (e: unknown) => e as DepthLimitError);

    expect(error).toBeInstanceOf(DepthLimitError);
    expect(error!.message).toMatch(/depth of 3/);
  });

  test('should count nesting only, never sibling breadth', async () => {
    // Siblings are all measured from the same starting depth: four fields side
    // by side are depth 1, not depth 4.
    expect(await measureDepth('{ a b c d }')).toBe(1);
    expect(await measureDepth('{ a { b { c } } d }')).toBe(3);
    expect(await measureDepth('{ x { y } z { w } }')).toBe(2);
    expect(await measureDepth('{ hello }')).toBe(1);
    expect(await measureDepth('{ user(id: "1") { posts { title } } }')).toBe(3);
  });

  test('should agree with calculateQueryDepth from core', async () => {
    const queries = [
      '{ a b c d }',
      '{ a { b { c } } d }',
      '{ x { y } z { w } }',
      '{ hello }',
      '{ user(id: "1") { id name posts { id title } } }',
      '{ user(id: "1") { ... on User { posts { title } } } }',
      `{ user(id: "1") { ...UserFields } }
       fragment UserFields on User { posts { title } }`,
    ];

    for (const query of queries) {
      expect(await measureDepth(query)).toBe(calculateQueryDepth(parse(query)));
    }
  });

  test('should terminate on recursive fragments at the depth of one unrolling', async () => {
    const query = `
      { user(id: "1") { ...F } }
      fragment F on User { posts { ...F } }
    `;

    const runAtDepth = async (maxDepth: number): Promise<DocumentNode> => {
      const manager = new PluginManager({ schema });
      await manager.register(createDepthLimitPlugin(maxDepth));
      return manager.afterParse(
        parse(query),
        manager.createContext({ query }, {})
      );
    };

    // The limit is the oracle: user -> posts is depth 2, so the query is
    // allowed at 2 and rejected at 1. Both calls returning at all also proves
    // the walk terminates instead of unrolling the cycle forever.
    await expect(runAtDepth(2)).resolves.toBeDefined();
    await expect(runAtDepth(1)).rejects.toThrow(DepthLimitError);
    expect(await measureDepth(query)).toBe(2);
  });

  test('should measure repeatedly spread fragments without exponential fan-out', async () => {
    // 20 chained fragments, each spread twice: 2^20 expansions if the walker
    // re-expands every spread, 20 if it measures each fragment once.
    const query = buildDoublySpreadFragmentChain(20);
    const document = parse(query);

    const runAtDepth = async (maxDepth: number): Promise<DocumentNode> => {
      const manager = new PluginManager({ schema });
      await manager.register(createDepthLimitPlugin(maxDepth));
      return manager.afterParse(
        document,
        manager.createContext({ query }, {})
      );
    };

    const startedAt = performance.now();

    // node + one `child` per fragment level = 21
    await expect(runAtDepth(21)).resolves.toBeDefined();
    await expect(runAtDepth(20)).rejects.toThrow(DepthLimitError);

    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  test('should reject a document that exceeds the analysis budget', async () => {
    const document = buildOversizedDocument();

    const manager = new PluginManager({ schema });
    await manager.register(createDepthLimitPlugin(5));

    const error = await manager
      .afterParse(document, manager.createContext({ query: '' }, {}))
      .then(
        () => null,
        (e: unknown) => e as DepthLimitError
      );

    expect(error).toBeInstanceOf(DepthLimitError);
    expect(error!.extensions['reason']).toBe('ANALYSIS_BUDGET_EXCEEDED');
    expect(error!.extensions['maxNodesVisited']).toBe(100_000);
  });
});

describe('createComplexityPlugin', () => {
  /**
   * Exact complexity the plugin computes for a query, scored under a limit no
   * query in these tests can exceed so the score itself is observable.
   */
  const scoreComplexity = async (
    query: string,
    options: Partial<Parameters<typeof createComplexityPlugin>[0]> = {},
    variables?: Record<string, unknown>
  ): Promise<number> => {
    const manager = new PluginManager({ schema });
    await manager.register(
      createComplexityPlugin({
        maxComplexity: Number.MAX_SAFE_INTEGER,
        ...options,
      })
    );

    const context = manager.createContext({ query, variables }, {});
    await manager.afterParse(parse(query), context);

    return context.state.get('complexity') as number;
  };

  test('should create complexity plugin', () => {
    const plugin = createComplexityPlugin({ maxComplexity: 100 });

    expect(plugin.metadata.name).toBe('complexity');
    expect(plugin.afterParse).toBeDefined();
  });

  test('should allow queries within complexity limit', async () => {
    const plugin = createComplexityPlugin({ maxComplexity: 100 });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext({ query: '{ hello }' }, {});
    const document = parse('{ hello }');

    // Should not throw
    await manager.afterParse(document, context);
  });

  test('should reject queries exceeding complexity limit with a ComplexityError', async () => {
    const plugin = createComplexityPlugin({ maxComplexity: 2 });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext(
      { query: '{ user(id: "1") { id name posts { id title } } }' },
      {}
    );
    const document = parse('{ user(id: "1") { id name posts { id title } } }');

    const error = await manager
      .afterParse(document, context)
      .then(() => null, (e: unknown) => e as ComplexityError);

    expect(error).toBeInstanceOf(ComplexityError);
    expect(error!.extensions['code']).toBe('COMPLEXITY_LIMIT');
    expect(error!.statusCode).toBe(400);
    expect(error!.message).toMatch(/exceeds maximum allowed complexity/);
  });

  test('should consider list arguments as multipliers', async () => {
    const plugin = createComplexityPlugin({
      maxComplexity: 20,
      defaultComplexity: 1,
    });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext(
      { query: '{ users(first: 100) { id } }' },
      {}
    );
    const document = parse('{ users(first: 100) { id } }');

    await expect(manager.afterParse(document, context)).rejects.toThrow(
      /exceeds maximum allowed complexity/
    );
  });

  test('should compound the multiplier over nested selections', async () => {
    // A page of 10 users also fetches each user's whole selection set 10 times
    expect(await scoreComplexity('{ users(first: 10) { posts { id title } } }')).toBe(
      40
    );
  });

  test('should ignore a negative page size instead of cancelling the score', async () => {
    // Complexity runs before schema validation, so nothing has type-checked
    // `first` yet: a negative literal must not drive the score below zero.
    const query = '{ users(first: -1000000) { id name posts { id title } } }';

    expect(await scoreComplexity(query)).toBe(6);

    const manager = new PluginManager({ schema });
    await manager.register(createComplexityPlugin({ maxComplexity: 5 }));

    await expect(
      manager.afterParse(parse(query), manager.createContext({ query }, {}))
    ).rejects.toThrow(ComplexityError);
  });

  test('should resolve a variable page size from the request variables', async () => {
    const query = 'query Paged($n: Int) { users(first: $n) { id } }';

    expect(await scoreComplexity(query, {}, { n: 100 })).toBe(200);
    expect(await scoreComplexity(query, {}, { n: 2 })).toBe(4);

    // ...and the resolved size still drives rejection
    const manager = new PluginManager({ schema });
    await manager.register(createComplexityPlugin({ maxComplexity: 20 }));

    await expect(
      manager.afterParse(
        parse(query),
        manager.createContext({ query, variables: { n: 100 } }, {})
      )
    ).rejects.toThrow(ComplexityError);
  });

  test('should fall back to the declared default for an unsupplied variable', async () => {
    const query = 'query Paged($n: Int = 50) { users(first: $n) { id } }';

    expect(await scoreComplexity(query)).toBe(100);
    // A supplied value still wins over the declared default
    expect(await scoreComplexity(query, {}, { n: 3 })).toBe(6);

    // Defaults of other variables are ignored, and a non-positive default is
    // no more usable than none at all
    expect(
      await scoreComplexity(
        'query Paged($term: String = "x", $n: Int = 25) { users(first: $n) { id } }'
      )
    ).toBe(50);
    expect(
      await scoreComplexity('query Paged($n: Int = -5) { users(first: $n) { id } }', {
        unknownMultiplier: 7,
      })
    ).toBe(14);
  });

  test('should assume the configured worst case for an unresolvable variable', async () => {
    const query = 'query Paged($n: Int) { users(first: $n) { id } }';

    // No value, no declared default: never score it as a small page
    expect(await scoreComplexity(query)).toBe(200);
    expect(await scoreComplexity(query, { unknownMultiplier: 1000 })).toBe(2000);
    expect(await scoreComplexity(query, { unknownMultiplier: 1 })).toBe(2);

    // A non-numeric or non-positive supplied value is equally unusable
    expect(await scoreComplexity(query, {}, { n: 'lots' })).toBe(200);
    expect(await scoreComplexity(query, {}, { n: -5 })).toBe(200);
  });

  test('should ignore arguments that carry no usable page size', async () => {
    expect(await scoreComplexity('{ users(first: null) { id } }')).toBe(2);
    expect(await scoreComplexity('{ user(id: "1") { id } }')).toBe(2);
  });

  test('should use a custom calculator when provided', async () => {
    // Every field costs a flat 10 plus its children, so { hello } scores 10
    const plugin = createComplexityPlugin({
      maxComplexity: 5,
      calculator: (_node, childComplexity) => 10 + childComplexity,
    });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const context = manager.createContext({ query: '{ hello }' }, {});

    const error = await manager
      .afterParse(parse('{ hello }'), context)
      .then(() => null, (e: unknown) => e as ComplexityError);

    expect(error).toBeInstanceOf(ComplexityError);
    expect(context.state.get('complexity')).toBe(10);

    // A zero-cost calculator lets an otherwise too-complex query through
    const permissive = createComplexityPlugin({
      maxComplexity: 1,
      calculator: () => 0,
    });

    const manager2 = new PluginManager({ schema });
    await manager2.register(permissive);

    const query = '{ user(id: "1") { id name posts { id title } } }';
    const context2 = manager2.createContext({ query }, {});
    await manager2.afterParse(parse(query), context2);

    expect(context2.state.get('complexity')).toBe(0);
  });

  test('should measure complexity through fragment spreads', async () => {
    const plugin = createComplexityPlugin({ maxComplexity: 2 });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    // user + id + name + posts + id + title = 6, hidden behind a fragment
    const query = `
      { user(id: "1") { ...UserFields } }
      fragment UserFields on User { id name posts { id title } }
    `;
    const context = manager.createContext({ query }, {});

    const error = await manager
      .afterParse(parse(query), context)
      .then(() => null, (e: unknown) => e as ComplexityError);

    expect(error).toBeInstanceOf(ComplexityError);
    expect(error!.message).toMatch(/complexity of 6/);
  });

  test('should terminate on recursive fragments', async () => {
    const plugin = createComplexityPlugin({ maxComplexity: 100 });

    const manager = new PluginManager({ schema });
    await manager.register(plugin);

    const query = `
      { user(id: "1") { ...F } }
      fragment F on User { posts { ...F } }
    `;
    const context = manager.createContext({ query }, {});

    // Must not hang or overflow
    await manager.afterParse(parse(query), context);
    expect(context.state.get('complexity')).toBe(2);
  });

  test('should score repeatedly spread fragments without exponential fan-out', async () => {
    // 20 chained fragments, each spread twice: the document really does expand
    // to 2^20 fields, but scoring it must take linear work, not 2^20 visits.
    const query = buildDoublySpreadFragmentChain(20);

    const startedAt = performance.now();
    const score = await scoreComplexity(query);
    const elapsed = performance.now() - startedAt;

    expect(score).toBe(1_048_576);
    expect(elapsed).toBeLessThan(1000);
  });

  test('should reject a document that exceeds the analysis budget', async () => {
    const document = buildOversizedDocument();

    const manager = new PluginManager({ schema });
    await manager.register(createComplexityPlugin({ maxComplexity: 10 }));

    const error = await manager
      .afterParse(document, manager.createContext({ query: '' }, {}))
      .then(
        () => null,
        (e: unknown) => e as ComplexityError
      );

    expect(error).toBeInstanceOf(ComplexityError);
    expect(error!.extensions['reason']).toBe('ANALYSIS_BUDGET_EXCEEDED');
    expect(error!.extensions['maxNodesVisited']).toBe(100_000);
  });
});

describe('operation-aware caching, complexity and logging', () => {
  test('should not cache or replay mutations in the caching plugin', async () => {
    const manager = new PluginManager({ schema });
    await manager.register(createCachingPlugin({ allowSharedCache: true }));
    const query = 'mutation M { hello }';
    const document = parse(query);

    for (let i = 0; i < 3; i++) {
      const context = manager.createContext(
        { query, operationName: 'M' },
        {}
      );
      const short = await manager.beforeExecute(document, context);
      expect(short).toBeUndefined();
      expect(context.state.get('cacheSkip')).toBe(true);
      expect(context.state.get('cacheHit')).toBeUndefined();
      const response = await manager.afterExecute(
        { data: { hello: `x${i}` } },
        context
      );
      // The fresh response passes through; nothing is replayed from a cache
      expect(response).toEqual({ data: { hello: `x${i}` } });
    }
  });

  test('should not store a response when an earlier plugin short-circuited the caching plugin', async () => {
    const manager = new PluginManager({ schema });
    await manager.register({
      metadata: { name: 'mutation-short-circuit' },
      beforeExecute: (document) =>
        document.definitions.some(
          (d) => d.kind === 'OperationDefinition' && d.operation === 'mutation'
        )
          ? { data: { hello: 'short' } }
          : undefined,
    });
    await manager.register(createCachingPlugin({ allowSharedCache: true, maxSize: 1 }));

    const query = 'query Q { hello }';
    const queryDoc = parse(query);
    const first = manager.createContext({ query }, {});
    await manager.beforeExecute(queryDoc, first);
    await manager.afterExecute({ data: { hello: 'Q' } }, first);

    const mutation = 'mutation M { hello }';
    const mutationContext = manager.createContext({ query: mutation }, {});
    const short = await manager.beforeExecute(parse(mutation), mutationContext);
    expect(short).toEqual({ data: { hello: 'short' } });
    await manager.afterExecute(short!, mutationContext);

    // The query entry survived: the mutation never took the only slot
    const second = manager.createContext({ query }, {});
    expect(await manager.beforeExecute(queryDoc, second)).toEqual({ data: { hello: 'Q' } });
  });

  test('should not cache a subscription in the caching plugin', async () => {
    const manager = new PluginManager({ schema });
    await manager.register(createCachingPlugin({ allowSharedCache: true }));
    const query = 'subscription S { hello }';
    const document = parse(query);

    for (let i = 0; i < 2; i++) {
      const context = manager.createContext(
        { query, operationName: 'S' },
        {}
      );
      expect(await manager.beforeExecute(document, context)).toBeUndefined();
      expect(context.state.get('cacheSkip')).toBe(true);
      await manager.afterExecute({ data: { hello: 'x' } }, context);
    }
  });

  test('should cache a single anonymous query without operationName in the caching plugin', async () => {
    const manager = new PluginManager({ schema });
    await manager.register(createCachingPlugin({ allowSharedCache: true }));
    const query = '{ hello }';
    const document = parse(query);

    const first = manager.createContext({ query }, {});
    expect(await manager.beforeExecute(document, first)).toBeUndefined();
    expect(first.state.get('cacheSkip')).toBeUndefined();
    await manager.afterExecute({ data: { hello: 'x' } }, first);

    const second = manager.createContext({ query }, {});
    expect(await manager.beforeExecute(document, second)).toEqual({
      data: { hello: 'x' },
    });
  });

  test('should still cache the selected query in a mixed document in the caching plugin', async () => {
    const manager = new PluginManager({ schema });
    await manager.register(createCachingPlugin({ allowSharedCache: true }));
    const query = 'query Q { hello } mutation M { hello }';
    const document = parse(query);

    const first = manager.createContext({ query, operationName: 'Q' }, {});
    await manager.beforeExecute(document, first);
    await manager.afterExecute({ data: { hello: 'x' } }, first);

    const second = manager.createContext({ query, operationName: 'Q' }, {});
    expect(await manager.beforeExecute(document, second)).toEqual({
      data: { hello: 'x' },
    });
  });

  test('should score only the selected operation in the complexity plugin', async () => {
    const manager = new PluginManager({ schema });
    await manager.register(createComplexityPlugin({ maxComplexity: 3 }));
    const query = 'query Small { hello } query Big { users(first: 50) { id name } }';
    const document = parse(query);

    const ok = manager.createContext({ query, operationName: 'Small' }, {});
    await manager.afterParse(document, ok);
    expect(ok.state.get('complexity')).toBe(1);

    const big = manager.createContext({ query, operationName: 'Big' }, {});
    await expect(manager.afterParse(document, big)).rejects.toThrow(
      ComplexityError
    );

    // No selection: falls back to the max across operations
    const none = manager.createContext({ query }, {});
    await expect(manager.afterParse(document, none)).rejects.toThrow(
      ComplexityError
    );
  });

  test('should take the max, not the sum, across unselected operations in the complexity plugin', async () => {
    const manager = new PluginManager({ schema });
    await manager.register(createComplexityPlugin({ maxComplexity: 3 }));
    const query = 'query A { a: hello b: hello } query B { c: hello d: hello }';
    const document = parse(query);

    const context = manager.createContext({ query }, {});
    await manager.afterParse(document, context);
    expect(context.state.get('complexity')).toBe(2);
  });

  test.each([
    'query A { c: hello } query A { a: hello b: hello }',
    'query A { a: hello b: hello } query A { c: hello }',
  ])('should fall back to the max when operationName matches several operations in the complexity plugin (%s)', async (query) => {
    const manager = new PluginManager({ schema });
    await manager.register(createComplexityPlugin({ maxComplexity: 3 }));
    const document = parse(query);

    const context = manager.createContext({ query, operationName: 'A' }, {});
    await manager.afterParse(document, context);
    expect(context.state.get('complexity')).toBe(2);
  });

  test('should report unknown duration in the logging plugin when beforeExecute did not run', async () => {
    const logs: Array<{ msg: string; data?: unknown }> = [];
    const log = (msg: string, data?: unknown): number =>
      logs.push({ msg, data });
    const manager = new PluginManager({ schema });
    await manager.register(
      createLoggingPlugin({
        logger: { debug: log, info: log, warn: log, error: log },
      })
    );
    const context = manager.createContext({ query: '{ hello }' }, {});
    await manager.afterExecute({ data: { hello: 'x' } }, context);

    const text = JSON.stringify(logs);
    expect(text).not.toContain('NaN');
    expect(text).toContain('unknown');
  });
});
