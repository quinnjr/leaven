/**
 * @leaven-graphql/http - GraphQL over SSE integration tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import { GraphQLInt, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { createClient, type Client } from 'graphql-sse';
import { createServer, type LeavenServer } from './server';

let finished = false;

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
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
    },
  }),
});

/**
 * Start an SSE-enabled server on an ephemeral port and run a test with a client
 */
async function withClient(
  fn: (client: Client, server: LeavenServer, port: number) => Promise<void>
): Promise<void> {
  const server = createServer({ schema, sse: true, port: 0 });
  const { port } = server.start();
  const client = createClient({
    url: `http://localhost:${port}/graphql`,
    singleConnection: false,
    retryAttempts: 0,
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

  test('should surface a validation error to the client as a rejection', async () => {
    await withClient(async (client) => {
      const run = async (): Promise<void> => {
        for await (const _result of client.iterate({ query: '{ nope }' })) {
          // unreachable
        }
      };
      await expect(run()).rejects.toBeDefined();
    });
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

  test('should disable the idle timeout for SSE requests', async () => {
    await withClient(async (_client, server, port) => {
      const bun = server.getServer()!;
      const original = bun.timeout.bind(bun);
      const calls: Array<[Request, number]> = [];
      bun.timeout = (request: Request, seconds: number): void => {
        calls.push([request, seconds]);
        original(request, seconds);
      };

      const url = `http://localhost:${port}/graphql`;
      const body = JSON.stringify({ query: '{ hello }' });

      const json = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      await json.text();
      expect(calls).toHaveLength(0);

      const sse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body,
      });
      await sse.text();
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBeInstanceOf(Request);
      expect(calls[0]![1]).toBe(0);
    });
  });
});
