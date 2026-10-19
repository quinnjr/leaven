/**
 * @leaven-graphql/http - Bun HTTP server tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { WebSocketHandler } from '@leaven-graphql/ws';
import { LeavenServer, createServer, type ServerConfig } from './server';

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: {
        type: GraphQLString,
        resolve: () => 'world',
      },
    },
  }),
});

/**
 * Start a server on an ephemeral port and run a test against it
 */
async function withServer(
  config: Partial<ServerConfig>,
  fn: (baseUrl: string, server: LeavenServer) => Promise<void>
): Promise<void> {
  const server = createServer({ schema, ...config, port: 0 });
  const info = server.start();

  try {
    await fn(`http://localhost:${info.port}`, server);
  } finally {
    server.stop();
  }
}

describe('createServer', () => {
  test('should create a server without starting it', () => {
    const server = createServer({ schema, port: 0 });

    expect(server).toBeInstanceOf(LeavenServer);
    expect(server.isRunning()).toBe(false);
    expect(server.getServer()).toBeNull();
  });
});

describe('LeavenServer', () => {
  test('should start and stop', () => {
    const server = createServer({ schema, port: 0 });

    const info = server.start();

    try {
      expect(server.isRunning()).toBe(true);
      expect(server.getServer()).not.toBeNull();
      expect(info.port).toBeGreaterThan(0);
      expect(info.url).toContain('/graphql');
    } finally {
      server.stop();
    }

    expect(server.isRunning()).toBe(false);
    expect(server.getServer()).toBeNull();
  });

  test('should invoke onStart and onStop callbacks', () => {
    let started = false;
    let stopped = false;

    const server = createServer({
      schema,
      port: 0,
      onStart: () => {
        started = true;
      },
      onStop: () => {
        stopped = true;
      },
    });

    server.start();

    try {
      expect(started).toBe(true);
    } finally {
      server.stop();
    }

    expect(stopped).toBe(true);
    expect(server.isRunning()).toBe(false);
    expect(server.getServer()).toBeNull();
  });

  test('should serve the GraphQL endpoint', async () => {
    await withServer({}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ hello }' }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: { hello: string } };
      expect(body.data).toEqual({ hello: 'world' });
    });
  });

  test('should apply CSRF prevention by default', async () => {
    await withServer({}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ query: '{ hello }' }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors[0].message).toMatch(/blocked by CSRF prevention/);
    });
  });

  test('should pass csrfPrevention through to the handler', async () => {
    await withServer({ csrfPrevention: false }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query: '{ hello }' }).toString(),
      });

      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({ hello: 'world' });
    });
  });

  test('should serve a custom GraphQL path', async () => {
    await withServer({ path: '/api' }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ hello }' }),
      });

      expect(response.status).toBe(200);
    });
  });

  test('should serve custom routes', async () => {
    await withServer(
      {
        routes: {
          '/health': () => new Response('ok'),
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/health`);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
      }
    );
  });

  test('should return 404 for unknown paths', async () => {
    await withServer({}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/nope`);

      expect(response.status).toBe(404);
    });
  });

  test('should use the fallback handler for unknown paths', async () => {
    await withServer(
      {
        fallback: () => new Response('fallback', { status: 200 }),
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/anything`);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('fallback');
      }
    );
  });

  test('should invoke onError for a rejecting async route handler', async () => {
    let seenError: Error | null = null;

    await withServer(
      {
        routes: {
          '/boom': async () => {
            throw new Error('async boom');
          },
        },
        onError: (error) => {
          seenError = error;
          return new Response(`handled: ${error.message}`, { status: 500 });
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/boom`);

        expect(response.status).toBe(500);
        expect(await response.text()).toBe('handled: async boom');
        expect(seenError).not.toBeNull();
        expect(seenError!.message).toBe('async boom');
      }
    );
  });

  test('should invoke onError for a rejecting async fallback handler', async () => {
    let onErrorCalled = false;

    await withServer(
      {
        fallback: async () => {
          throw new Error('fallback boom');
        },
        onError: () => {
          onErrorCalled = true;
          return new Response('handled', { status: 500 });
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/anything`);

        expect(response.status).toBe(500);
        expect(onErrorCalled).toBe(true);
      }
    );
  });

  test('should return 500 for a rejecting route handler without onError', async () => {
    await withServer(
      {
        routes: {
          '/boom': async () => {
            throw new Error('async boom');
          },
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/boom`);

        expect(response.status).toBe(500);
        expect(await response.text()).toBe('Internal Server Error');
      }
    );
  });

  describe('websocket', () => {
    test('should upgrade WebSocket connections on the GraphQL path', async () => {
      const wsHandler = new WebSocketHandler({ schema });

      await withServer({ websocket: wsHandler }, async (baseUrl, server) => {
        const info = server.getServer();
        expect(info).not.toBeNull();

        const wsUrl = baseUrl.replace('http://', 'ws://');
        const socket = new WebSocket(`${wsUrl}/graphql`);

        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onerror = () => reject(new Error('WebSocket connection failed'));
        });

        const ack = await new Promise<{ type: string }>((resolve) => {
          socket.onmessage = (event) => {
            resolve(JSON.parse(String(event.data)) as { type: string });
          };
          socket.send(JSON.stringify({ type: 'connection_init' }));
        });

        expect(ack.type).toBe('connection_ack');

        await new Promise<void>((resolve) => {
          socket.onclose = () => resolve();
          socket.close();
        });
      });
    });

    test('should serve a replaced WebSocket handler after reload', async () => {
      // Bun retains a previously installed websocket handler across a reload
      // that omits one, so simply reconnecting proves nothing. Swapping the
      // handler does: only a reload that restates the current config lets the
      // new handler take over.
      let servedBy: string | null = null;

      const original = new WebSocketHandler({
        schema,
        onConnect: () => {
          servedBy = 'original';
          return true;
        },
      });
      const replacement = new WebSocketHandler({
        schema,
        onConnect: () => {
          servedBy = 'replacement';
          return true;
        },
      });

      // `LeavenServer` keeps the config object by reference, so mutating it
      // here is what a dev-mode config reload looks like from the outside.
      const config: ServerConfig = { schema, port: 0, websocket: original };
      const server = createServer(config);
      const info = server.start();

      try {
        config.websocket = replacement;
        server.reload();

        const socket = new WebSocket(`ws://localhost:${info.port}/graphql`);

        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onerror = () => reject(new Error('WebSocket connection failed'));
        });

        const ack = await new Promise<{ type: string }>((resolve) => {
          socket.onmessage = (event) => {
            resolve(JSON.parse(String(event.data)) as { type: string });
          };
          socket.send(JSON.stringify({ type: 'connection_init' }));
        });

        expect(ack.type).toBe('connection_ack');
        expect(servedBy).toBe('replacement');

        await new Promise<void>((resolve) => {
          socket.onclose = () => resolve();
          socket.close();
        });
      } finally {
        server.stop();
      }
    });

    test('should still serve HTTP on the GraphQL path after reload', async () => {
      await withServer({}, async (baseUrl, server) => {
        server.reload();

        const response = await fetch(`${baseUrl}/graphql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ hello }' }),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as { data: { hello: string } };
        expect(body.data).toEqual({ hello: 'world' });
      });
    });

    test('should still serve HTTP on the GraphQL path when websocket is configured', async () => {
      const wsHandler = new WebSocketHandler({ schema });

      await withServer({ websocket: wsHandler }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/graphql`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ hello }' }),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as { data: { hello: string } };
        expect(body.data).toEqual({ hello: 'world' });
      });
    });

    /** Open a socket with extra handshake headers and wait for connection_ack. */
    async function expectAck(url: string, headers: Record<string, string>): Promise<void> {
      // Bun's WebSocket client accepts handshake headers as an extension.
      const socket = new WebSocket(url, { headers } as unknown as string[]);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('WebSocket connection failed'));
      });
      const ack = await new Promise<{ type: string }>((resolve) => {
        socket.onmessage = (event) => {
          resolve(JSON.parse(String(event.data)) as { type: string });
        };
        socket.send(JSON.stringify({ type: 'connection_init' }));
      });
      expect(ack.type).toBe('connection_ack');
      await new Promise<void>((resolve) => {
        socket.onclose = () => resolve();
        socket.close();
      });
    }

    /** A raw WebSocket upgrade request carrying the given Origin. */
    function upgradeRequest(url: string, origin: string): Promise<Response> {
      return fetch(url, {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          origin,
        },
      });
    }

    test('should refuse a cross-origin upgrade with 403', async () => {
      const wsHandler = new WebSocketHandler({ schema });

      await withServer({ websocket: wsHandler }, async (baseUrl) => {
        const res = await upgradeRequest(`${baseUrl}/graphql`, 'https://evil.example');
        expect(res.status).toBe(403);
        expect(await res.text()).toBe('Forbidden');
      });
    });

    test('should upgrade a same-origin request', async () => {
      const wsHandler = new WebSocketHandler({ schema });

      await withServer({ websocket: wsHandler }, async (baseUrl) => {
        const wsUrl = baseUrl.replace('http://', 'ws://');
        await expectAck(`${wsUrl}/graphql`, { Origin: baseUrl });
      });
    });

    test('should upgrade a request with no Origin header', async () => {
      const wsHandler = new WebSocketHandler({ schema });

      await withServer({ websocket: wsHandler }, async (baseUrl) => {
        const wsUrl = baseUrl.replace('http://', 'ws://');
        await expectAck(`${wsUrl}/graphql`, {});
      });
    });

    test('should upgrade a cross-origin request listed in allowedOrigins', async () => {
      const wsHandler = new WebSocketHandler({
        schema,
        allowedOrigins: ['https://app.example'],
      });

      await withServer({ websocket: wsHandler }, async (baseUrl) => {
        const wsUrl = baseUrl.replace('http://', 'ws://');
        await expectAck(`${wsUrl}/graphql`, { Origin: 'https://app.example' });
      });
    });

    test('should connect with the graphql-transport-ws subprotocol', async () => {
      const wsHandler = new WebSocketHandler({ schema });

      await withServer({ websocket: wsHandler }, async (baseUrl) => {
        const wsUrl = baseUrl.replace('http://', 'ws://');
        const socket = new WebSocket(`${wsUrl}/graphql`, 'graphql-transport-ws');

        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onerror = () => reject(new Error('WebSocket connection failed'));
        });

        const ack = await new Promise<{ type: string }>((resolve) => {
          socket.onmessage = (event) => {
            resolve(JSON.parse(String(event.data)) as { type: string });
          };
          socket.send(JSON.stringify({ type: 'connection_init' }));
        });

        expect(ack.type).toBe('connection_ack');

        await new Promise<void>((resolve) => {
          socket.onclose = () => resolve();
          socket.close();
        });
      });
    });
  });

  describe('stop with an open SSE stream', () => {
    const sseSchema = new GraphQLSchema({
      query: schema.getQueryType(),
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          ticks: {
            type: GraphQLString,
            subscribe: async function* () {
              for (;;) {
                yield { ticks: 'tick' };
                await Bun.sleep(10);
              }
            },
          },
        },
      }),
    });

    /** Open an SSE subscription and wait for its first bytes */
    const openStream = async (
      port: number
    ): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
      const response = await fetch(`http://localhost:${port}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ query: 'subscription { ticks }' }),
      });
      const reader = response.body!.getReader();
      await reader.read();
      return reader;
    };

    test('should leave open streams alive by default', async () => {
      const server = createServer({ schema: sseSchema, sse: true, port: 0 });
      const { port } = server.start();
      const reader = await openStream(port);
      // stop() nulls the internal server, so keep a handle for cleanup.
      const handle = server.getServer();

      try {
        server.stop();
        expect(server.isRunning()).toBe(false);

        // Graceful stop: the in-flight stream keeps delivering.
        // No timer race: a hang is caught by the test timeout instead.
        const r = await reader.read();
        expect(r.done ? 'closed' : 'data').toBe('data');
      } finally {
        await reader.cancel();
        handle?.stop(true);
      }
    });

    test('should close open streams when closeActiveConnections is true', async () => {
      const server = createServer({ schema: sseSchema, sse: true, port: 0 });
      const { port } = server.start();
      const reader = await openStream(port);

      server.stop(true);

      const outcome = await (async (): Promise<string> => {
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) {
              return 'closed';
            }
          }
        } catch {
          return 'closed';
        }
      })();
      expect(outcome).toBe('closed');
    });
  });
});
