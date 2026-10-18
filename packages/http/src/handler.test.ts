/**
 * @leaven-graphql/http - HTTP handler tests
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
import { AuthenticationError, NotFoundError } from '@leaven-graphql/errors';
import { createHandler, createBunHandler } from './handler';

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

/** A schema whose `missing` field always fails with a coded Leaven error */
const partialFailureSchema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      ok: {
        type: GraphQLString,
        resolve: () => 'fine',
      },
      missing: {
        type: GraphQLString,
        resolve: () => {
          throw new NotFoundError('User not found');
        },
      },
    },
  }),
});

function postRequest(
  body: string,
  headers: Record<string, string> = { 'Content-Type': 'application/json' }
): Request {
  return new Request('http://localhost/graphql', {
    method: 'POST',
    headers,
    body,
  });
}

describe('createHandler', () => {
  test('should execute a POST query', async () => {
    const handler = createHandler({ schema });

    const response = await handler(postRequest(JSON.stringify({ query: '{ hello }' })));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ hello: 'world' });
  });

  test('should execute a GET query via query parameters', async () => {
    const handler = createHandler({ schema });

    const response = await handler(
      new Request('http://localhost/graphql?query={ hello }')
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ hello: 'world' });
  });

  test('should return 400 when query is missing', async () => {
    const handler = createHandler({ schema });

    const response = await handler(postRequest(JSON.stringify({})));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.errors[0].message).toBe('Query is required');
  });

  test('should return 405 for disallowed methods', async () => {
    const handler = createHandler({ schema });

    const response = await handler(
      new Request('http://localhost/graphql', { method: 'DELETE' })
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toContain('POST');
  });

  test('should answer CORS preflight when cors is enabled', async () => {
    const handler = createHandler({ schema, cors: true });

    const response = await handler(
      new Request('http://localhost/graphql', { method: 'OPTIONS' })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  test('should include CORS headers on responses when cors is enabled', async () => {
    const handler = createHandler({ schema, cors: true });

    const response = await handler(postRequest(JSON.stringify({ query: '{ hello }' })));

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  describe('playground', () => {
    test('should serve HTML for a browser-style GET when enabled', async () => {
      const handler = createHandler({ schema, playground: true });

      const response = await handler(
        new Request('http://localhost/graphql', {
          headers: { Accept: 'text/html,application/xhtml+xml' },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      const html = await response.text();
      expect(html.toLowerCase()).toContain('graphiql');
    });

    test('should embed the configured endpoint path', async () => {
      const handler = createHandler({ schema, playground: true, path: '/custom' });

      const response = await handler(
        new Request('http://localhost/custom', {
          headers: { Accept: 'text/html' },
        })
      );

      const html = await response.text();
      expect(html).toContain('/custom');
    });

    test('should still execute a GET with a query parameter', async () => {
      const handler = createHandler({ schema, playground: true });

      const response = await handler(
        new Request('http://localhost/graphql?query={ hello }', {
          headers: { Accept: 'text/html' },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      const body = await response.json();
      expect(body.data).toEqual({ hello: 'world' });
    });

    test('should not serve HTML when the request does not accept it', async () => {
      const handler = createHandler({ schema, playground: true });

      const response = await handler(
        new Request('http://localhost/graphql', {
          headers: { Accept: 'application/json' },
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors[0].message).toBe('Query is required');
    });

    test('should return 400 for browser GET when playground is disabled', async () => {
      const handler = createHandler({ schema, playground: false });

      const response = await handler(
        new Request('http://localhost/graphql', {
          headers: { Accept: 'text/html' },
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors[0].message).toBe('Query is required');
    });
  });

  describe('maxBodySize', () => {
    test('should reject a body that exceeds the limit', async () => {
      const handler = createHandler({ schema, maxBodySize: 32 });

      const response = await handler(
        postRequest(JSON.stringify({ query: `{ hello } # ${'x'.repeat(1024)}` }))
      );

      expect(response.status).toBe(413);
      const body = await response.json();
      expect(body.errors[0].extensions.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('should reject an oversized body even with a lying Content-Length', async () => {
      const handler = createHandler({ schema, maxBodySize: 32 });

      const response = await handler(
        postRequest(JSON.stringify({ query: `{ hello } # ${'x'.repeat(1024)}` }), {
          'Content-Type': 'application/json',
          'Content-Length': '10',
        })
      );

      expect(response.status).toBe(413);
    });

    test('should reject an honest oversized Content-Length without reading the body', async () => {
      const handler = createHandler({ schema, maxBodySize: 32 });

      // Reading this stream throws. If the Content-Length fast path is
      // removed, the handler reads the body and this test fails.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('body must not be read'));
        },
      });

      const response = await handler(
        new Request('http://localhost/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '1024',
          },
          body: stream,
        })
      );

      expect(response.status).toBe(413);
      const body = await response.json();
      expect(body.errors[0].extensions.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('should reject an oversized body with no explicit maxBodySize', async () => {
      const handler = createHandler({ schema });

      const response = await handler(
        postRequest(
          JSON.stringify({ query: `{ hello } # ${'x'.repeat(1_100_000)}` })
        )
      );

      expect(response.status).toBe(413);
      const body = await response.json();
      expect(body.errors[0].extensions.code).toBe('PAYLOAD_TOO_LARGE');
    });

    test('should return 400 when the body stream fails mid-read', async () => {
      const handler = createHandler({ schema, maxBodySize: 1024 });

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"query"'));
          controller.error(new Error('client went away'));
        },
      });

      const response = await handler(
        new Request('http://localhost/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: stream,
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors[0].extensions.code).toBe('BAD_REQUEST');
    });

    test('should return 400 when the body read exceeds bodyReadTimeoutMs', async () => {
      const handler = createHandler({
        schema,
        maxBodySize: 1024,
        bodyReadTimeoutMs: 10,
      });

      // A body that never completes: the deadline is the only way out.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
        },
      });

      const response = await handler(
        new Request('http://localhost/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: stream,
        })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors[0].message).toMatch(/Timed out reading request body/);
    });

    test('should cancel the read deadline once the body has been read', async () => {
      // A distinctive delay so the deadline timer is identifiable among any
      // other timers the request happens to schedule.
      const DEADLINE_MS = 424_242;
      const handler = createHandler({ schema, bodyReadTimeoutMs: DEADLINE_MS });

      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;

      let deadlineTimer: unknown = null;
      let cleared = false;

      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
      ) => {
        const id = realSetTimeout(callback, ms, ...args);
        if (ms === DEADLINE_MS) {
          deadlineTimer = id;
        }
        return id;
      }) as unknown as typeof setTimeout;

      globalThis.clearTimeout = ((id?: unknown) => {
        if (deadlineTimer !== null && id === deadlineTimer) {
          cleared = true;
        }
        return realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
      }) as unknown as typeof clearTimeout;

      let response: Response;
      try {
        response = await handler(postRequest(JSON.stringify({ query: '{ hello }' })));
      } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
      }

      expect(response.status).toBe(200);
      // A deadline that is never cancelled pins a timer, an abort listener and
      // a reject closure for its full duration on every completed POST.
      expect(deadlineTimer).not.toBeNull();
      expect(cleared).toBe(true);
    });

    test('should reject an oversized streamed body without Content-Length', async () => {
      const handler = createHandler({ schema, maxBodySize: 32 });

      const chunk = new TextEncoder().encode('x'.repeat(64));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });

      const response = await handler(
        new Request('http://localhost/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: stream,
        })
      );

      expect(response.status).toBe(413);
    });

    test('should accept a body within the limit', async () => {
      const handler = createHandler({ schema, maxBodySize: 1024 });

      const response = await handler(
        postRequest(JSON.stringify({ query: '{ hello }' }))
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toEqual({ hello: 'world' });
    });
  });

  describe('body parse failures', () => {
    test('should return 400 for invalid JSON', async () => {
      const handler = createHandler({ schema });

      const response = await handler(postRequest('not json'));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors[0].message).toMatch(/Invalid JSON/);
      expect(body.errors[0].extensions.code).toBe('BAD_REQUEST');
    });

    test('should return 400 for an unsupported content type', async () => {
      const handler = createHandler({ schema });

      const response = await handler(
        postRequest('not supported', { 'Content-Type': 'text/plain' })
      );

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.errors[0].message).toMatch(/Unsupported content type/);
    });
  });

  describe('request errors', () => {
    for (const errorFormatting of [undefined, { maskErrors: true }]) {
      const label = errorFormatting ? 'with masking' : 'without masking';

      test(`should answer a validation error with 400 VALIDATION_ERROR ${label}`, async () => {
        const handler = createHandler({ schema, errorFormatting });

        const response = await handler(postRequest(JSON.stringify({ query: '{ nope }' })));

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.errors[0].message).toBe('Cannot query field "nope" on type "Query".');
        expect(body.errors[0].extensions.code).toBe('VALIDATION_ERROR');
        expect(body.errors[0].locations).toEqual([{ line: 1, column: 3 }]);
      });

      test(`should answer a syntax error with 400 PARSE_ERROR ${label}`, async () => {
        const handler = createHandler({ schema, errorFormatting });

        const response = await handler(postRequest(JSON.stringify({ query: '{ hello' })));

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.errors[0].message).toMatch(/^Syntax Error/);
        expect(body.errors[0].extensions.code).toBe('PARSE_ERROR');
      });

      test(`should answer a variable coercion error with 400 BAD_REQUEST ${label}`, async () => {
        const handler = createHandler({ schema, errorFormatting });

        const response = await handler(
          postRequest(
            JSON.stringify({
              query: 'query ($n: Boolean!) { hello @include(if: $n) }',
              variables: { n: 'not a boolean' },
            })
          )
        );

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.errors[0].message).toMatch(/Variable "\$n"/);
        expect(body.errors[0].extensions.code).toBe('BAD_REQUEST');
      });
    }
  });

  describe('operation selection errors', () => {
    for (const errorFormatting of [undefined, { maskErrors: true }]) {
      const label = errorFormatting ? 'with masking' : 'without masking';

      test(`should answer an unknown operation name with 400 BAD_REQUEST ${label}`, async () => {
        const handler = createHandler({ schema, errorFormatting });

        const response = await handler(
          postRequest(JSON.stringify({ query: 'query A { hello }', operationName: 'B' }))
        );

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.errors[0].message).toBe('Unknown operation named "B".');
        expect(body.errors[0].extensions.code).toBe('BAD_REQUEST');
      });

      test(`should answer a missing operation name with 400 BAD_REQUEST ${label}`, async () => {
        const handler = createHandler({ schema, errorFormatting });

        const response = await handler(
          postRequest(JSON.stringify({ query: 'query A { hello } query B { hello }' }))
        );

        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.errors[0].message).toBe(
          'Must provide operation name if query contains multiple operations.'
        );
        expect(body.errors[0].extensions.code).toBe('BAD_REQUEST');
      });
    }

    test('should answer an unknown operation name with 400 when the compiler is on', async () => {
      const handler = createHandler({
        schema,
        executor: { maxComplexity: 100 },
        errorFormatting: { maskErrors: true },
      });

      const response = await handler(
        postRequest(JSON.stringify({ query: 'query A { hello }', operationName: 'B' }))
      );

      expect(response.status).toBe(400);
      expect((await response.json()).errors[0].message).toBe('Unknown operation named "B".');
    });
  });

  describe('error mapping', () => {
    test('should use LeavenError statusCode for thrown Leaven errors', async () => {
      const handler = createHandler({
        schema,
        context: () => {
          throw new AuthenticationError('Not authenticated');
        },
      });

      const response = await handler(
        postRequest(JSON.stringify({ query: '{ hello }' }))
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.errors[0].message).toBe('Not authenticated');
      expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    });

    test('should return 500 for non-Leaven errors', async () => {
      const handler = createHandler({
        schema,
        context: () => {
          throw new Error('kaboom');
        },
      });

      const response = await handler(
        postRequest(JSON.stringify({ query: '{ hello }' }))
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.errors[0].extensions.code).toBe('INTERNAL_ERROR');
    });

    test('should mask a context factory failure when masking is enabled', async () => {
      const handler = createHandler({
        schema,
        errorFormatting: { maskErrors: true },
        context: () => {
          throw new Error('connect ECONNREFUSED 10.0.3.14:5432');
        },
      });

      const response = await handler(
        postRequest(JSON.stringify({ query: '{ hello }' }))
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.errors[0].message).not.toContain('ECONNREFUSED');
      expect(body.errors[0].message).toBe('An unexpected error occurred');
      expect(body.errors[0].extensions.code).toBe('INTERNAL_ERROR');
    });

    test('should not destroy an execution error when errorFormatting is set', async () => {
      const handler = createHandler({
        schema: partialFailureSchema,
        errorFormatting: { maskErrors: true },
      });

      const response = await handler(
        postRequest(JSON.stringify({ query: '{ ok missing }' }))
      );

      const body = await response.json();
      expect(body.errors[0].message).toBe('User not found');
      expect(body.errors[0].message).not.toBe('[object Object]');
      expect(body.errors[0].extensions.code).toBe('NOT_FOUND');
      expect(body.errors[0].path).toEqual(['missing']);
      expect(body.errors[0].locations).toBeDefined();
    });

    test('should stay 200 for a partial success from a coded resolver error', async () => {
      const handler = createHandler({
        schema: partialFailureSchema,
        errorFormatting: { maskErrors: true },
      });

      const response = await handler(
        postRequest(JSON.stringify({ query: '{ ok missing }' }))
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toEqual({ ok: 'fine', missing: null });
    });

    test('should still mask an uncoded execution error', async () => {
      const leakySchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            hello: {
              type: GraphQLString,
              resolve: () => {
                throw new Error('connect ECONNREFUSED 10.0.3.14:5432');
              },
            },
          },
        }),
      });

      const handler = createHandler({
        schema: leakySchema,
        errorFormatting: { maskErrors: true },
      });

      const response = await handler(
        postRequest(JSON.stringify({ query: '{ hello }' }))
      );

      const body = await response.json();
      expect(body.errors[0].message).not.toContain('ECONNREFUSED');
      expect(body.errors[0].message).toBe('An unexpected error occurred');
      expect(body.errors[0].extensions.code).toBe('INTERNAL_ERROR');
    });

    test('should not mask a LeavenError when masking is enabled', async () => {
      const handler = createHandler({
        schema,
        errorFormatting: { maskErrors: true },
        context: () => {
          throw new AuthenticationError('Not authenticated');
        },
      });

      const response = await handler(
        postRequest(JSON.stringify({ query: '{ hello }' }))
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.errors[0].message).toBe('Not authenticated');
      expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    });
  });
});

describe('GET mutations', () => {
  const mutationSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
    }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: { noop: { type: GraphQLString, resolve: () => 'done' } },
    }),
  });
  const getUrl = (query: string, extra = ''): string =>
    'http://x/graphql?query=' + encodeURIComponent(query) + extra;

  test('should reject a mutation sent over GET with 405 and Allow: POST', async () => {
    const handler = createHandler({ schema: mutationSchema });
    const res = await handler(new Request(getUrl('mutation { noop }')));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const body = await res.json();
    expect(body.errors[0].message).toBe('Mutations can only be sent with POST');
  });

  test('should keep CORS headers on the 405 response', async () => {
    const handler = createHandler({ schema: mutationSchema, cors: true });
    const res = await handler(
      new Request(getUrl('mutation { noop }'), { headers: { Origin: 'http://example.com' } })
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('access-control-allow-origin')).not.toBeNull();
    expect(res.headers.get('allow')).toBe('POST');
    const body = await res.json();
    expect(body.errors[0].extensions.code).toBe('BAD_REQUEST');
  });

  test('should select the named operation when deciding', async () => {
    const handler = createHandler({ schema: mutationSchema });
    const doc = 'query Q { hello } mutation M { noop }';
    const q = await handler(new Request(getUrl(doc, '&operationName=Q')));
    expect(q.status).toBe(200);
    const m = await handler(new Request(getUrl(doc, '&operationName=M')));
    expect(m.status).toBe(405);
  });

  test('should not run the mutation for an ambiguous multi-operation GET', async () => {
    let ran = 0;
    const ambiguousSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
      }),
      mutation: new GraphQLObjectType({
        name: 'Mutation',
        fields: {
          noop: {
            type: GraphQLString,
            resolve: () => {
              ran++;
              return 'done';
            },
          },
        },
      }),
    });
    const handler = createHandler({ schema: ambiguousSchema });
    const res = await handler(new Request(getUrl('query Q { hello } mutation M { noop }')));
    expect(res.status).not.toBe(405);
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(ran).toBe(0);
  });

  test('should not run the context factory for a rejected GET mutation', async () => {
    let calls = 0;
    const handler = createHandler({
      schema: mutationSchema,
      context: () => {
        calls++;
        return {};
      },
    });
    const res = await handler(new Request(getUrl('mutation { noop }')));
    expect(res.status).toBe(405);
    expect(calls).toBe(0);
  });

  test('should still execute a mutation sent with POST', async () => {
    const handler = createHandler({ schema: mutationSchema });
    const res = await handler(postRequest(JSON.stringify({ query: 'mutation { noop }' })));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ noop: 'done' });
  });

  test('should let a GET query with a syntax error reach execution and report it', async () => {
    const handler = createHandler({ schema: mutationSchema });
    const res = await handler(new Request(getUrl('{ hello')));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].message).toContain('Syntax Error');
    expect(body.errors[0].extensions.code).toBe('PARSE_ERROR');
  });
});

describe('SSE', () => {
  /** An iterator that never yields until it is returned */
  function pendingIterator(): AsyncIterableIterator<unknown> {
    let release: (() => void) | undefined;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<unknown>> {
        return new Promise((resolve) => {
          release = () => resolve({ value: undefined, done: true });
        });
      },
      return(): Promise<IteratorResult<unknown>> {
        release?.();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  const sseSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: { hello: { type: GraphQLString, resolve: () => 'world' } },
    }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: {
        noop: { type: GraphQLString, resolve: () => 'done' },
        fail: {
          type: new GraphQLNonNull(GraphQLString),
          resolve: () => {
            throw new Error('declined');
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
        boom: {
          type: GraphQLInt,
          subscribe: async function* () {
            throw new Error('secret');
          },
        },
        pending: {
          type: GraphQLInt,
          subscribe: () => pendingIterator(),
        },
        guarded: {
          type: GraphQLInt,
          subscribe: () => {
            throw new AuthenticationError('Sign in first');
          },
        },
      },
    }),
  });

  function post(
    payload: unknown,
    headers: Record<string, string> = {}
  ): Request {
    return new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
  }

  const COMPLETE = 'event: complete\ndata:\n\n';

  test('should stream a query as one next then complete', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(post({ query: '{ hello }' }, { accept: 'text/event-stream' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await res.text()).toBe(
      'event: next\ndata: {"data":{"hello":"world"}}\n\n' + COMPLETE
    );
  });

  test('should stream each subscription event', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(
      post({ query: 'subscription { count }' }, { accept: 'text/event-stream' })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      'event: next\ndata: {"data":{"count":1}}\n\n' +
        'event: next\ndata: {"data":{"count":2}}\n\n' +
        'event: next\ndata: {"data":{"count":3}}\n\n' +
        COMPLETE
    );
  });

  test('should accept a GET subscription with query params', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(
      new Request(
        'http://localhost/graphql?query=' + encodeURIComponent('subscription { count }'),
        { headers: { accept: 'text/event-stream' } }
      )
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('{"data":{"count":3}}');
    expect(text.endsWith(COMPLETE)).toBe(true);
  });

  test('should reject a GET mutation with 405 on the SSE path', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(
      new Request(
        'http://localhost/graphql?query=' + encodeURIComponent('mutation { noop }'),
        { headers: { accept: 'text/event-stream' } }
      )
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('should mask a thrown subscription error with errorFormatting', async () => {
    const handler = createHandler({
      schema: sseSchema,
      sse: true,
      errorFormatting: { maskErrors: true },
    });
    const res = await handler(
      post({ query: 'subscription { boom }' }, { accept: 'text/event-stream' })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: next');
    expect(text).not.toContain('secret');
    expect(text.endsWith(COMPLETE)).toBe(true);
  });

  test('should stream an execution failure with data null as 200 next then complete', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(post({ query: 'mutation { fail }' }, { accept: 'text/event-stream' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('"data":null');
    expect(text).toContain('declined');
    expect(text.endsWith(COMPLETE)).toBe(true);
  });

  test('should stream a subscribe-time error that carries a path', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(
      post({ query: 'subscription { guarded }' }, { accept: 'text/event-stream' })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"path":["guarded"]');
    expect(text).toContain('UNAUTHENTICATED');
    expect(text.endsWith(COMPLETE)).toBe(true);
  });

  test('should answer a variable coercion error as JSON 400', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(
      post(
        { query: 'query ($n: Int!) { hello }', variables: { n: 'x' } },
        { accept: 'text/event-stream' }
      )
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('should return a JSON error response for a validation failure', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(post({ query: '{ nope }' }, { accept: 'text/event-stream' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  test('should return a JSON error response for a subscription validation failure', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(
      post({ query: 'subscription { nope }' }, { accept: 'text/event-stream' })
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('should return a JSON error response when the context factory throws', async () => {
    const handler = createHandler({
      schema: sseSchema,
      sse: true,
      errorFormatting: { maskErrors: true },
      context: () => {
        throw new Error('connect ECONNREFUSED 10.0.3.14:5432');
      },
    });
    const res = await handler(post({ query: '{ hello }' }, { accept: 'text/event-stream' }));
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.errors[0].message).toBe('An unexpected error occurred');
  });

  test('should return 413 JSON for an oversize body', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true, maxBodySize: 10 });
    const res = await handler(post({ query: '{ hello }' }, { accept: 'text/event-stream' }));
    expect(res.status).toBe(413);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('should include CORS headers on the stream', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true, cors: true });
    const res = await handler(
      post(
        { query: '{ hello }' },
        { accept: 'text/event-stream', Origin: 'http://example.com' }
      )
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).not.toBeNull();
    await res.text();
  });

  test('should keep the SSE content type and cache headers over config.response.headers', async () => {
    const handler = createHandler({
      schema: sseSchema,
      sse: true,
      response: { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public', 'X-App': '1' } },
    });
    const res = await handler(post({ query: '{ hello }' }, { accept: 'text/event-stream' }));
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-app')).toBe('1');
    await res.text();
  });

  test('should answer JSON when sse is not enabled', async () => {
    const handler = createHandler({ schema: sseSchema });
    const res = await handler(post({ query: '{ hello }' }, { accept: 'text/event-stream' }));
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).data).toEqual({ hello: 'world' });
  });

  test('should answer JSON for Accept */* even with sse enabled', async () => {
    const handler = createHandler({ schema: sseSchema, sse: true });
    const res = await handler(post({ query: '{ hello }' }, { accept: '*/*' }));
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).data).toEqual({ hello: 'world' });
  });

  test('should pass the configured keepAliveInterval through', async () => {
    const handler = createHandler({
      schema: sseSchema,
      sse: { keepAliveInterval: 20 },
    });
    const res = await handler(
      post({ query: 'subscription { pending }' }, { accept: 'text/event-stream' })
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 70;
    while (Date.now() < deadline && !text.includes(':\n\n')) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
      ]);
      if (chunk === null || chunk.done) {
        break;
      }
      text += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(text).toContain(':\n\n');
  });
});

describe('createBunHandler', () => {
  test('should behave like createHandler', async () => {
    const handler = createBunHandler({ schema });

    const response = await handler(postRequest(JSON.stringify({ query: '{ hello }' })));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ hello: 'world' });
  });
});
