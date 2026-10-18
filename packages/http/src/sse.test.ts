/**
 * @leaven-graphql/http - GraphQL over SSE integration tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import {
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';
import { createClient, NetworkError, type Client, type ClientOptions } from 'graphql-sse';
import { AuthenticationError, ValidationError } from '@leaven-graphql/errors';
import { createServer, type LeavenServer, type ServerConfig } from './server';

let finished = false;
let chargeCalls = 0;
let guardedCalls = 0;
let recordCalls = 0;
let rejectedCalls = 0;

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      hello: { type: GraphQLString, resolve: () => 'world' },
      echo: {
        type: GraphQLInt,
        args: { n: { type: new GraphQLNonNull(GraphQLInt) } },
        resolve: (_root, args: { n: number }) => args.n,
      },
    },
  }),
  mutation: new GraphQLObjectType({
    name: 'Mutation',
    fields: {
      record: {
        type: GraphQLString,
        resolve: () => {
          recordCalls++;
          return 'recorded';
        },
      },
      charge: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: () => {
          chargeCalls++;
          throw new Error('card declined');
        },
      },
    },
  }),
  subscription: new GraphQLObjectType({
    name: 'Subscription',
    fields: {
      count: {
        type: GraphQLInt,
        subscribe: async function* () {
          for (const n of [1, 2, 3]) {
            yield { count: n };
          }
        },
      },
      ticks: {
        type: GraphQLInt,
        subscribe: async function* () {
          try {
            for (let n = 1; ; n++) {
              yield { ticks: n };
              await Bun.sleep(10);
            }
          } finally {
            finished = true;
          }
        },
      },
      rejected: {
        type: GraphQLInt,
        subscribe: () => {
          rejectedCalls++;
          throw new ValidationError('Filter is invalid');
        },
      },
      guarded: {
        type: GraphQLInt,
        subscribe: () => {
          guardedCalls++;
          throw new AuthenticationError('Sign in to subscribe');
        },
      },
    },
  }),
});

/**
 * Start an SSE-enabled server on an ephemeral port and run a test with a client
 */
async function withClient(
  fn: (client: Client, server: LeavenServer, port: number) => Promise<void>,
  options: Partial<ClientOptions> = { retryAttempts: 0 },
  serverConfig: Partial<ServerConfig> = {}
): Promise<void> {
  const server = createServer({ schema, sse: true, port: 0, ...serverConfig });
  const { port } = server.start();
  const client = createClient({
    url: `http://localhost:${port}/graphql`,
    singleConnection: false,
    ...options,
  });

  try {
    await fn(client, server, port);
  } finally {
    client.dispose();
    server.stop();
  }
}

describe('GraphQL over SSE', () => {
  test('should deliver subscription events to the graphql-sse client', async () => {
    await withClient(async (client) => {
      const values: unknown[] = [];
      for await (const result of client.iterate({ query: 'subscription { count }' })) {
        values.push((result.data as { count: number }).count);
      }
      expect(values).toEqual([1, 2, 3]);
    });
  });

  test('should deliver a query result to the graphql-sse client', async () => {
    await withClient(async (client) => {
      const results: unknown[] = [];
      for await (const result of client.iterate({ query: '{ hello }' })) {
        results.push(result.data);
      }
      expect(results).toEqual([{ hello: 'world' }]);
    });
  });

  test('should surface a validation error to the client as a 400 rejection', async () => {
    await withClient(async (client) => {
      let caught: unknown;
      try {
        for await (const _result of client.iterate({ query: '{ nope }' })) {
          // unreachable
        }
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(NetworkError);
      expect((caught as NetworkError<Response>).response?.status).toBe(400);
    });
  });

  /** Default retryAttempts (5), with the backoff delay removed */
  const retrying: Partial<ClientOptions> = { retry: async () => {} };

  test('should run a failing mutation exactly once and deliver its error', async () => {
    chargeCalls = 0;
    await withClient(async (client) => {
      const results: Array<{ data?: unknown; errors?: ReadonlyArray<{ message: string }> }> = [];
      for await (const result of client.iterate({ query: 'mutation { charge }' })) {
        results.push(result);
      }
      expect(chargeCalls).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0]!.data).toBeNull();
      expect(results[0]!.errors?.[0]?.message).toBe('card declined');
    }, retrying);
  });

  test('should run a mutation once when an onExecuted hook throws after it ran', async () => {
    recordCalls = 0;
    await withClient(
      async (client) => {
        const results: Array<{ errors?: ReadonlyArray<{ message: string }> }> = [];
        for await (const result of client.iterate({ query: 'mutation { record }' })) {
          results.push(result);
        }
        expect(recordCalls).toBe(1);
        expect(results).toHaveLength(1);
        expect(results[0]!.errors?.[0]?.message).toBe('audit rejected the result');
      },
      retrying,
      {
        executor: {
          hooks: {
            onExecuted: () => {
              throw new ValidationError('audit rejected the result');
            },
          },
        },
      }
    );
  });

  test('should deliver a subscribe-time ValidationError in-stream and subscribe once', async () => {
    rejectedCalls = 0;
    await withClient(async (client) => {
      const results: Array<{
        errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }>;
      }> = [];
      for await (const result of client.iterate({ query: 'subscription { rejected }' })) {
        results.push(result);
      }
      expect(rejectedCalls).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0]!.errors?.[0]?.message).toBe('Filter is invalid');
      expect(results[0]!.errors?.[0]?.extensions?.code).toBe('VALIDATION_ERROR');
    }, retrying);
  });

  test.each([
    ['a parse error', { query: '{ hello' }],
    ['a variable coercion error', { query: 'query ($n: Int!) { echo(n: $n) }', variables: { n: 'x' } }],
  ])('should surface %s to the client as a 400 rejection', async (_label, payload) => {
    await withClient(async (client) => {
      let caught: unknown;
      try {
        for await (const _result of client.iterate(payload)) {
          // unreachable
        }
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(NetworkError);
      expect((caught as NetworkError<Response>).response?.status).toBe(400);
    });
  });

  test('should deliver a subscribe-time AuthenticationError as an event, not a NetworkError', async () => {
    guardedCalls = 0;
    await withClient(async (client) => {
      const results: Array<{
        errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }>;
      }> = [];
      for await (const result of client.iterate({ query: 'subscription { guarded }' })) {
        results.push(result);
      }
      expect(guardedCalls).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0]!.errors?.[0]?.message).toBe('Sign in to subscribe');
      expect(results[0]!.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    }, retrying);
  });

  test('should end the server iterator when the client disposes', async () => {
    finished = false;
    await withClient(async (client) => {
      const first = await new Promise<unknown>((resolve, reject) => {
        const dispose = client.subscribe(
          { query: 'subscription { ticks }' },
          {
            next: (value) => {
              dispose();
              resolve(value.data);
            },
            error: reject,
            complete: () => {},
          }
        );
      });
      expect(first).toEqual({ ticks: 1 });

      const deadline = Date.now() + 1000;
      while (!finished && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(finished).toBe(true);
    });
  });

  /** Record every server.timeout call made while the test runs */
  function recordTimeouts(server: LeavenServer): Array<[Request, number]> {
    const bun = server.getServer()!;
    const original = bun.timeout.bind(bun);
    const calls: Array<[Request, number]> = [];
    bun.timeout = (request: Request, seconds: number): void => {
      calls.push([request, seconds]);
      original(request, seconds);
    };
    return calls;
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;
    while (!predicate() && Date.now() < deadline) {
      await Bun.sleep(5);
    }
  }

  const sseHeaders = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };

  test('should not touch the idle timeout for a JSON request', async () => {
    await withClient(async (_client, server, port) => {
      const calls = recordTimeouts(server);
      const res = await fetch(`http://localhost:${port}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ hello }' }),
      });
      await res.text();
      expect(calls).toHaveLength(0);
    });
  });

  test('should disable the idle timeout for a stream and restore it when it completes', async () => {
    await withClient(async (_client, server, port) => {
      const calls = recordTimeouts(server);
      const res = await fetch(`http://localhost:${port}/graphql`, {
        method: 'POST',
        headers: sseHeaders,
        body: JSON.stringify({ query: 'subscription { count }' }),
      });
      expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(await res.text()).toContain('event: complete');
      await waitFor(() => calls.length >= 2);
      expect(calls.map(([, seconds]) => seconds)).toEqual([0, 10]);
      expect(calls[0]![0]).toBeInstanceOf(Request);
      expect(calls[1]![0]).toBe(calls[0]![0]);
    });
  });

  test('should restore the idle timeout when the client abandons the stream', async () => {
    await withClient(async (_client, server, port) => {
      const calls = recordTimeouts(server);
      const controller = new AbortController();
      const res = await fetch(`http://localhost:${port}/graphql`, {
        method: 'POST',
        headers: sseHeaders,
        body: JSON.stringify({ query: 'subscription { ticks }' }),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => {});
      await waitFor(() => calls.length >= 2);
      expect(calls.map(([, seconds]) => seconds)).toEqual([0, 10]);
    });
  });

  test('should keep the idle timeout for a pre-stream JSON failure', async () => {
    await withClient(async (_client, server, port) => {
      const calls = recordTimeouts(server);
      const res = await fetch(`http://localhost:${port}/graphql`, {
        method: 'POST',
        headers: sseHeaders,
        body: JSON.stringify({ query: '{ nope }' }),
      });
      expect(res.status).toBe(400);
      await res.text();
      expect(calls).toHaveLength(0);
    });
  });

  test('should never disable the idle timeout for a method other than GET or POST', async () => {
    await withClient(async (_client, server, port) => {
      // Answer every method with an event stream, so only the method gate
      // in LeavenServer decides whether the timeout is touched
      (server as unknown as { handler: (request: Request) => Promise<Response> }).handler =
        async () =>
          new Response('event: complete\ndata:\n\n', {
            headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
          });
      const calls = recordTimeouts(server);
      const url = `http://localhost:${port}/graphql`;

      const put = await fetch(url, { method: 'PUT', headers: sseHeaders, body: '{}' });
      expect(put.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      await put.text();
      expect(calls).toHaveLength(0);

      // Control: the same stream answered to a POST does disable it
      const post = await fetch(url, { method: 'POST', headers: sseHeaders, body: '{}' });
      await post.text();
      await waitFor(() => calls.length >= 2);
      expect(calls.map(([, seconds]) => seconds)).toEqual([0, 10]);
    });
  });
});
