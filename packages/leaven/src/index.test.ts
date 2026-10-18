/**
 * @leaven-graphql/leaven - Meta-package smoke tests
 *
 * Verifies that the re-exported surface of the meta-package resolves and
 * that the `leaven()` quick-start helper works end to end.
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { buildSchema } from 'graphql';
import {
  // Core
  LeavenExecutor,
  createExecutor,
  parseDocument,
  validateDocument,
  // Schema (partial re-export)
  SchemaBuilder,
  createSchemaBuilder,
  // HTTP
  createHandler,
  LeavenServer,
  createServer,
  // WebSocket
  PubSub,
  createPubSub,
  createWebSocketHandler,
  // SSE
  createEventStream,
  createEventStreamResponse,
  acceptsEventStream,
  SSE_CONTENT_TYPE,
  // Context
  createContextBuilder,
  createRequestContext,
  // Errors
  LeavenError,
  ValidationError,
  AuthenticationError,
  formatError,
  // Plugins
  createPlugin,
  createLoggingPlugin,
  createDepthLimitPlugin,
  // Playground
  renderPlayground,
  createPlaygroundHandler,
  // Quick-start helper
  leaven,
} from './index';

describe('meta-package export surface', () => {
  test('re-exports core symbols', () => {
    expect(LeavenExecutor).toBeInstanceOf(Function);
    expect(createExecutor).toBeInstanceOf(Function);
    expect(parseDocument).toBeInstanceOf(Function);
    expect(validateDocument).toBeInstanceOf(Function);
  });

  test('re-exports schema helpers', () => {
    expect(SchemaBuilder).toBeInstanceOf(Function);
    expect(createSchemaBuilder).toBeInstanceOf(Function);
  });

  test('re-exports http symbols', () => {
    expect(createHandler).toBeInstanceOf(Function);
    expect(LeavenServer).toBeInstanceOf(Function);
    expect(createServer).toBeInstanceOf(Function);
  });

  test('re-exports websocket symbols', () => {
    expect(PubSub).toBeInstanceOf(Function);
    expect(createPubSub).toBeInstanceOf(Function);
    expect(createWebSocketHandler).toBeInstanceOf(Function);
  });

  test('re-exports server-sent events symbols', () => {
    expect(createEventStream).toBeInstanceOf(Function);
    expect(createEventStreamResponse).toBeInstanceOf(Function);
    expect(acceptsEventStream).toBeInstanceOf(Function);
    expect(SSE_CONTENT_TYPE).toBe('text/event-stream; charset=utf-8');
  });

  test('re-exports context symbols', () => {
    expect(createContextBuilder).toBeInstanceOf(Function);
    expect(createRequestContext).toBeInstanceOf(Function);
  });

  test('re-exports error classes and formatters', () => {
    expect(LeavenError).toBeInstanceOf(Function);
    expect(ValidationError).toBeInstanceOf(Function);
    expect(AuthenticationError).toBeInstanceOf(Function);
    expect(formatError).toBeInstanceOf(Function);
    expect(Object.getPrototypeOf(ValidationError)).toBe(LeavenError);
  });

  test('re-exports plugin helpers', () => {
    expect(createPlugin).toBeInstanceOf(Function);
    expect(createLoggingPlugin).toBeInstanceOf(Function);
    expect(createDepthLimitPlugin).toBeInstanceOf(Function);
  });

  test('re-exports playground helpers', () => {
    expect(renderPlayground).toBeInstanceOf(Function);
    expect(createPlaygroundHandler).toBeInstanceOf(Function);
  });
});

describe('leaven', () => {
  const schema = buildSchema(`
    type Query {
      hello: String
    }
  `);
  const rootValue = { hello: () => 'world' };

  test('creates a LeavenServer from a minimal schema without throwing', () => {
    const server = leaven({ schema });

    expect(server).toBeInstanceOf(LeavenServer);
  });

  test('returns the server without starting it', () => {
    const server = leaven({ schema });

    expect(server.isRunning()).toBe(false);
    expect(server.getServer()).toBeNull();
  });

  test('serves GraphQL end to end', async () => {
    const server = leaven({ schema, rootValue, port: 0 });
    const info = server.start();

    try {
      expect(server.isRunning()).toBe(true);

      const response = await fetch(`http://localhost:${info.port}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ hello }' }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { hello: string } };
      expect(body.data).toEqual({ hello: 'world' });
    } finally {
      server.stop();
    }

    expect(server.isRunning()).toBe(false);
  });

  test('passes its config through to createServer', async () => {
    const server = leaven({ schema, rootValue, port: 0, path: '/api' });
    const info = server.start();

    try {
      expect(info.url).toContain('/api');

      const response = await fetch(`http://localhost:${info.port}/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ hello }' }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { hello: string } };
      expect(body.data).toEqual({ hello: 'world' });
    } finally {
      server.stop();
    }
  });
});
