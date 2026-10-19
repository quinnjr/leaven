/**
 * @leaven-graphql/nestjs - Middleware tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { GraphQLSchema, GraphQLObjectType, GraphQLString, GraphQLError } from 'graphql';
import { AuthenticationError } from '@leaven-graphql/errors';
import { GraphQLMiddleware, createGraphQLMiddleware } from './middleware';
import { LeavenDriver } from './driver';
import type { LeavenModuleOptions } from './types';
import { withNodeEnv } from './test-utils/env';
// Express types for testing
interface Request {
  method: string;
  path: string;
  originalUrl?: string;
  url?: string;
  secure?: boolean;
  body?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

interface Response {
  status(code: number): Response;
  json(body: unknown): Response;
  send(body: unknown): Response;
  setHeader(name: string, value: string): Response;
  end(): Response;
}

describe('GraphQLMiddleware', () => {
  let middleware: GraphQLMiddleware;
  let driver: LeavenDriver;
  let schema: GraphQLSchema;
  let options: LeavenModuleOptions;

  beforeEach(async () => {
    schema = new GraphQLSchema({
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

    options = {
      schema,
      path: '/graphql',
      playground: true,
    };

    driver = new LeavenDriver(options);
    await driver.onModuleInit();

    middleware = new GraphQLMiddleware(driver, options);
  });

  function createMockRequest(overrides: Partial<Request> = {}): Request {
    return {
      method: 'POST',
      path: '/graphql',
      body: { query: '{ hello }' },
      headers: {
        'content-type': 'application/json',
      },
      ...overrides,
    } as unknown as Request;
  }

  function createMockResponse(): Response & {
    _status: number;
    _body: unknown;
    _headers: Record<string, string>
  } {
    const res = {
      _status: 200,
      _body: null as unknown,
      _headers: {} as Record<string, string>,
      status: function(code: number) {
        this._status = code;
        return this;
      },
      json: function(body: unknown) {
        this._body = body;
        return this;
      },
      send: function(body: unknown) {
        this._body = body;
        return this;
      },
      setHeader: function(name: string, value: string) {
        this._headers[name] = value;
        return this;
      },
      end: function() {
        return this;
      },
    };
    return res as Response & { _status: number; _body: unknown; _headers: Record<string, string> };
  }

  describe('use', () => {
    test('should pass through non-GraphQL requests', async () => {
      const req = createMockRequest({ path: '/api/health' });
      const res = createMockResponse();
      const next = mock(() => {});

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('should handle GraphQL POST requests', async () => {
      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await middleware.use(req, res, next);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ data: { hello: 'world' } });
      expect(next).not.toHaveBeenCalled();
    });

    test('should handle GET requests for playground', async () => {
      const req = createMockRequest({
        method: 'GET',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await middleware.use(req, res, next);

      expect(res._headers['Content-Type']).toBe('text/html');
      expect(res._body).toContain('<!DOCTYPE html>');
      expect(res._body).toContain('GraphiQL');
      expect(next).not.toHaveBeenCalled();
    });

    test('should skip playground when disabled', async () => {
      const noPlaygroundOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        playground: false,
      };
      const noPlaygroundDriver = new LeavenDriver(noPlaygroundOptions);
      await noPlaygroundDriver.onModuleInit();
      const noPlaygroundMiddleware = new GraphQLMiddleware(noPlaygroundDriver, noPlaygroundOptions);

      const req = createMockRequest({
        method: 'GET',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await noPlaygroundMiddleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('should handle OPTIONS for CORS preflight', async () => {
      const corsOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: {
          origin: 'https://example.com',
          methods: ['GET', 'POST'],
          allowedHeaders: ['Content-Type', 'Authorization'],
          credentials: true,
          maxAge: 86400,
        },
      };
      const corsDriver = new LeavenDriver(corsOptions);
      await corsDriver.onModuleInit();
      const corsMiddleware = new GraphQLMiddleware(corsDriver, corsOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await corsMiddleware.use(req, res, next);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('https://example.com');
      expect(res._headers['Access-Control-Allow-Methods']).toBe('GET, POST');
      expect(res._headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
      expect(res._headers['Access-Control-Allow-Credentials']).toBe('true');
      expect(res._headers['Access-Control-Max-Age']).toBe('86400');
      expect(next).not.toHaveBeenCalled();
    });

    test('should read a capitalised Origin header when matching an allowlisted origin', async () => {
      const corsOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: { origin: ['https://app.example.com'] },
      };
      const corsDriver = new LeavenDriver(corsOptions);
      await corsDriver.onModuleInit();
      const corsMiddleware = new GraphQLMiddleware(corsDriver, corsOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
        headers: { Origin: 'https://app.example.com' },
      } as unknown as Partial<Request>);
      const res = createMockResponse();
      const next = mock(() => {});

      await corsMiddleware.use(req, res, next);

      expect(res._headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    });

    test('should delegate OPTIONS to next() when CORS is disabled', async () => {
      const noCorsOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: false,
      };
      const noCorsDriver = new LeavenDriver(noCorsOptions);
      await noCorsDriver.onModuleInit();
      const noCorsMiddleware = new GraphQLMiddleware(noCorsDriver, noCorsOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await noCorsMiddleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    test('should not set CORS headers on POST responses when CORS is disabled', async () => {
      const noCorsOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: false,
      };
      const noCorsDriver = new LeavenDriver(noCorsOptions);
      await noCorsDriver.onModuleInit();
      const noCorsMiddleware = new GraphQLMiddleware(noCorsDriver, noCorsOptions);

      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await noCorsMiddleware.use(req, res, next);

      expect(res._status).toBe(200);
      expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    test('should emit no CORS headers on POST when cors is left unset', async () => {
      // CORS is opt-in. A stock module must not answer every GraphQL POST
      // with a wildcard origin.
      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.test',
        },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await middleware.use(req, res, next);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ data: { hello: 'world' } });
      expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(res._headers['Access-Control-Allow-Methods']).toBeUndefined();
      expect(res._headers['Access-Control-Allow-Headers']).toBeUndefined();
    });

    test('should delegate OPTIONS to next() when cors is left unset', async () => {
      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
        headers: { origin: 'https://evil.test' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    test('should handle OPTIONS with default CORS (true)', async () => {
      const defaultCorsOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: true,
      };
      const defaultCorsDriver = new LeavenDriver(defaultCorsOptions);
      await defaultCorsDriver.onModuleInit();
      const defaultCorsMiddleware = new GraphQLMiddleware(defaultCorsDriver, defaultCorsOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await defaultCorsMiddleware.use(req, res, next);

      expect(res._status).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      // The CSRF headers are allowed by default so a cross-origin client can
      // send the one CSRF prevention asks for.
      expect(res._headers['Access-Control-Allow-Headers']).toBe(
        'Content-Type, Authorization, x-graphql-csrf, apollo-require-preflight, x-apollo-operation-name'
      );
    });

    test('should allow the configured CSRF headers, or none when CSRF prevention is off', async () => {
      const allowHeaders = async (
        csrfPrevention: LeavenModuleOptions['csrfPrevention']
      ): Promise<string | undefined> => {
        const opts: LeavenModuleOptions = { schema, path: '/graphql', cors: true, csrfPrevention };
        const res = createMockResponse();
        await new GraphQLMiddleware(new LeavenDriver(opts), opts).use(
          createMockRequest({ method: 'OPTIONS' }),
          res,
          mock(() => {})
        );
        return res._headers['Access-Control-Allow-Headers'];
      };

      expect(await allowHeaders({ requestHeaders: [' X-My-CSRF '] })).toBe(
        'Content-Type, Authorization, x-my-csrf'
      );
      expect(await allowHeaders(false)).toBe('Content-Type, Authorization');
    });

    test('should include CORS headers on POST responses', async () => {
      const corsOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: {
          origin: 'https://example.com',
          credentials: true,
          exposedHeaders: ['X-Request-Id', 'X-Trace-Id'],
        },
      };
      const corsDriver = new LeavenDriver(corsOptions);
      await corsDriver.onModuleInit();
      const corsMiddleware = new GraphQLMiddleware(corsDriver, corsOptions);

      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await corsMiddleware.use(req, res, next);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ data: { hello: 'world' } });
      expect(res._headers['Access-Control-Allow-Origin']).toBe('https://example.com');
      expect(res._headers['Access-Control-Allow-Credentials']).toBe('true');
      expect(res._headers['Access-Control-Expose-Headers']).toBe('X-Request-Id, X-Trace-Id');
    });

    test('should return 400 for missing query', async () => {
      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: {},
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await middleware.use(req, res, next);

      expect(res._status).toBe(400);
      const body = res._body as { errors: Array<{ message: string; extensions?: { code?: string } }> };
      expect(body.errors[0]?.message).toBe('Query is required');
      expect(body.errors[0]?.extensions?.code).toBe('VALIDATION_ERROR');
    });

    test.each([[''], [123], [null], [{ a: 1 }]])(
      'should return a coded 400 for an empty or non-string query (%p)',
      async (query) => {
        const req = createMockRequest({ method: 'POST', path: '/graphql', body: { query } });
        const res = createMockResponse();

        await middleware.use(req, res, mock(() => {}));

        expect(res._status).toBe(400);
        const body = res._body as { errors: Array<{ extensions?: { code?: string } }> };
        expect(body.errors[0]?.extensions?.code).toBe('VALIDATION_ERROR');
      }
    );

    test.each([
      ['variables as a string', { query: '{ hello }', variables: '{"a":1}' }, '"variables" must be a JSON object'],
      ['variables as an array', { query: '{ hello }', variables: [1] }, '"variables" must be a JSON object'],
      ['operationName as a number', { query: '{ hello }', operationName: 5 }, '"operationName" must be a string'],
    ])('should return a 400 for %s', async (_label, body, message) => {
      const req = createMockRequest({ method: 'POST', path: '/graphql', body });
      const res = createMockResponse();

      await middleware.use(req, res, mock(() => {}));

      expect(res._status).toBe(400);
      const out = res._body as { errors: Array<{ message: string; extensions?: { code?: string } }> };
      expect(out.errors[0]?.message).toBe(message);
      expect(out.errors[0]?.extensions?.code).toBe('VALIDATION_ERROR');
    });

    test('should return a 400 for a non-object body', async () => {
      const req = createMockRequest({ method: 'POST', path: '/graphql', body: null });
      const res = createMockResponse();

      await middleware.use(req, res, mock(() => {}));

      expect(res._status).toBe(400);
      const out = res._body as { errors: Array<{ message: string; extensions?: { code?: string } }> };
      expect(out.errors[0]?.message).toBe('Request body must be a JSON object');
      expect(out.errors[0]?.extensions?.code).toBe('VALIDATION_ERROR');
    });

    test('should handle execution errors', async () => {
      const errorSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            error: {
              type: GraphQLString,
              resolve: () => {
                throw new Error('Test error');
              },
            },
          },
        }),
      });

      const errorDriver = new LeavenDriver({ schema: errorSchema });
      await errorDriver.onModuleInit();
      const errorMiddleware = new GraphQLMiddleware(errorDriver, { schema: errorSchema });

      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ error }' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await errorMiddleware.use(req, res, next);

      // `error` is nullable, so `data` survives: a partial success stays 200
      expect(res._status).toBe(200);
      expect((res._body as { data?: unknown }).data).toEqual({ error: null });
      expect((res._body as { errors?: unknown[] }).errors).toBeDefined();
    });

    test('should derive a total failure status from the error code', async () => {
      const req = createMockRequest({ body: { query: '{ nope }' } });
      const res = createMockResponse();
      res._status = 0;

      await middleware.use(req, res, mock(() => {}));

      const body = res._body as {
        data?: unknown;
        errors?: { extensions?: Record<string, unknown> }[];
      };
      expect(body.data ?? null).toBeNull();
      expect(body.errors?.[0]?.extensions?.code).toBe('VALIDATION_ERROR');
      expect(res._status).toBe(400);
    });

    test('should answer 200 for a successful response', async () => {
      const res = createMockResponse();
      res._status = 0;

      await middleware.use(createMockRequest(), res, mock(() => {}));

      expect(res._status).toBe(200);
    });

    test('should not serialize the body for a context factory that never reads it', async () => {
      let serialized = 0;
      const body = {
        query: '{ hello }',
        toJSON(): Record<string, unknown> {
          serialized += 1;
          return { query: '{ hello }' };
        },
      };
      let seenHeader: string | null = null;
      const lazyMiddleware = new GraphQLMiddleware(driver, {
        ...options,
        context: async (request) => {
          seenHeader = request.headers.get('content-type');
          return {};
        },
      });
      const res = createMockResponse();

      await lazyMiddleware.use(createMockRequest({ body }), res, mock(() => {}));

      expect(seenHeader).toBe('application/json');
      expect(serialized).toBe(0);
      expect(res._body).toEqual({ data: { hello: 'world' } });
    });

    test.each([
      ['text', 'application/json', (r: globalThis.Request) => r.text()],
      ['arrayBuffer', 'application/json', (r: globalThis.Request) => r.arrayBuffer()],
      ['blob', 'application/json', (r: globalThis.Request) => r.blob()],
      ['clone', 'application/json', (r: globalThis.Request) => r.clone().text()],
      [
        'formData',
        'application/x-www-form-urlencoded',
        (r: globalThis.Request) => r.formData(),
      ],
      ['json', 'application/json', (r: globalThis.Request) => r.json()],
      ...(typeof (Request.prototype as { bytes?: unknown }).bytes === 'function'
        ? ([
            [
              'bytes',
              'application/json',
              (r: globalThis.Request) =>
                (r as unknown as { bytes(): Promise<Uint8Array> }).bytes(),
            ],
          ] as const)
        : []),
    ] as const)(
      'should serialize the body exactly once when a context factory reads %s',
      async (_member, contentType, read) => {
        let serialized = 0;
        const body = {
          query: '{ hello }',
          toJSON(): Record<string, unknown> {
            serialized += 1;
            return { query: '{ hello }' };
          },
        };
        let isRequest = false;
        let beforeRead = -1;
        const lazyMiddleware = new GraphQLMiddleware(driver, {
          ...options,
          context: async (request) => {
            isRequest = request instanceof Request;
            // Metadata never triggers serialization
            void request.url;
            void request.method;
            request.headers.get('content-type');
            beforeRead = serialized;
            await read(request);
            // Reading another member afterwards reuses the same serialization
            await request.clone().text();
            return {};
          },
        });

        await lazyMiddleware.use(
          // `x-graphql-csrf` lets the form-urlencoded case past CSRF prevention
          createMockRequest({
            body,
            headers: { 'content-type': contentType, 'x-graphql-csrf': '1' },
          }),
          createMockResponse(),
          mock(() => {})
        );

        expect(isRequest).toBe(true);
        expect(beforeRead).toBe(0);
        expect(serialized).toBe(1);
      }
    );

    test('should keep the method and body when a context factory copies the request with new headers', async () => {
      let serialized = 0;
      const body = {
        query: '{ hello }',
        toJSON(): Record<string, unknown> {
          serialized += 1;
          return { query: '{ hello }' };
        },
      };
      let beforeCopy = -1;
      let copied: { method: string; body: unknown; header: string | null } | undefined;
      const lazyMiddleware = new GraphQLMiddleware(driver, {
        ...options,
        context: async (request) => {
          beforeCopy = serialized;
          const copy = new Request(request, { headers: { 'x-tenant': 'acme' } });
          copied = {
            method: copy.method,
            body: await copy.json(),
            header: copy.headers.get('x-tenant'),
          };
          return {};
        },
      });

      await lazyMiddleware.use(createMockRequest({ body }), createMockResponse(), mock(() => {}));

      expect(beforeCopy).toBe(0);
      expect(serialized).toBe(1);
      expect(copied).toEqual({ method: 'POST', body: { query: '{ hello }' }, header: 'acme' });
    });

    test('should include variables and operationName', async () => {
      const variableSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            echo: {
              type: GraphQLString,
              args: {
                message: { type: GraphQLString },
              },
              resolve: (_, args) => args.message,
            },
          },
        }),
      });

      const variableDriver = new LeavenDriver({ schema: variableSchema });
      await variableDriver.onModuleInit();
      const variableMiddleware = new GraphQLMiddleware(variableDriver, { schema: variableSchema });

      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: {
          query: 'query Echo($msg: String) { echo(message: $msg) }',
          variables: { msg: 'Hello!' },
          operationName: 'Echo',
        },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await variableMiddleware.use(req, res, next);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ data: { echo: 'Hello!' } });
    });

    test('should use custom context factory', async () => {
      const contextOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        context: async (_req, _res) => ({
          customValue: 'test',
        }),
      };
      const contextDriver = new LeavenDriver(contextOptions);
      await contextDriver.onModuleInit();
      const contextMiddleware = new GraphQLMiddleware(contextDriver, contextOptions);

      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await contextMiddleware.use(req, res, next);

      expect(res._status).toBe(200);
    });

    test('should pass a Fetch API Request to the context factory', async () => {
      let authHeader: string | null = null;
      let requestUrl = '';
      let requestMethod = '';
      let parsedBody: unknown = null;

      const contextOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        context: async (request) => {
          authHeader = request.headers.get('authorization');
          requestUrl = request.url;
          requestMethod = request.method;
          parsedBody = await request.json();
          return { auth: authHeader };
        },
      };
      const contextDriver = new LeavenDriver(contextOptions);
      await contextDriver.onModuleInit();
      const contextMiddleware = new GraphQLMiddleware(contextDriver, contextOptions);

      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-token',
          host: 'api.example.com',
        },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await contextMiddleware.use(req, res, next);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ data: { hello: 'world' } });
      expect(authHeader).toBe('Bearer test-token');
      expect(requestUrl).toBe('http://api.example.com/graphql');
      expect(requestMethod).toBe('POST');
      expect(parsedBody).toEqual({ query: '{ hello }' });
    });

    /**
     * Build a middleware whose context factory records the synthesized
     * `Request.url`, run one POST through it, and return that URL.
     */
    async function captureContextRequestUrl(
      req: Request,
      extraOptions: Partial<LeavenModuleOptions> = {}
    ): Promise<string> {
      let requestUrl = '';
      const captureOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        ...extraOptions,
        context: async (request) => {
          requestUrl = request.url;
          return {};
        },
      };
      const captureDriver = new LeavenDriver(captureOptions);
      await captureDriver.onModuleInit();
      const captureMiddleware = new GraphQLMiddleware(captureDriver, captureOptions);

      await captureMiddleware.use(req, createMockResponse(), mock(() => {}));
      await captureDriver.onModuleDestroy();

      return requestUrl;
    }

    test('should preserve the query string in the synthesized request URL', async () => {
      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        originalUrl: '/graphql?trace=abc123',
        body: { query: '{ hello }' },
      });

      const requestUrl = await captureContextRequestUrl(req);

      expect(requestUrl).toBe('http://localhost/graphql?trace=abc123');
    });

    test('should read a capitalised Host header when synthesizing the request URL', async () => {
      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
        headers: {
          'content-type': 'application/json',
          Host: 'api.example.com',
        },
      });

      const requestUrl = await captureContextRequestUrl(req);

      expect(requestUrl).toBe('http://api.example.com/graphql');
    });

    test('should ignore a malformed capitalised Host header', async () => {
      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
        headers: {
          'content-type': 'application/json',
          Host: 'attacker.test/evil',
        },
      });

      const requestUrl = await captureContextRequestUrl(req);

      expect(requestUrl).toBe('http://localhost/graphql');
    });

    test('should ignore a malformed Host header instead of trusting it', async () => {
      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
        headers: {
          'content-type': 'application/json',
          host: 'attacker.test/evil?x=1',
        },
      });

      const requestUrl = await captureContextRequestUrl(req);

      expect(requestUrl).toBe('http://localhost/graphql');
    });

    test('should not 500 on a Host header that cannot form a URL', async () => {
      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
        headers: {
          'content-type': 'application/json',
          host: 'user@[not-an-authority]:99999',
        },
      });
      const res = createMockResponse();

      const contextOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        context: async () => ({}),
      };
      const contextDriver = new LeavenDriver(contextOptions);
      await contextDriver.onModuleInit();
      const contextMiddleware = new GraphQLMiddleware(contextDriver, contextOptions);

      await contextMiddleware.use(req, res, mock(() => {}));

      expect(res._status).toBe(200);
      await contextDriver.onModuleDestroy();
    });

    test('should prefer the configured publicUrl over the Host header', async () => {
      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
        headers: {
          'content-type': 'application/json',
          host: 'attacker.test',
        },
      });

      const requestUrl = await captureContextRequestUrl(req, {
        publicUrl: 'https://api.example.com',
      });

      expect(requestUrl).toBe('https://api.example.com/graphql');
    });

    test('should reflect an allowlisted origin and vary on Origin', async () => {
      const arrayOriginOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: {
          origin: ['https://a.com', 'https://b.com'],
        },
      };
      const arrayOriginDriver = new LeavenDriver(arrayOriginOptions);
      await arrayOriginDriver.onModuleInit();
      const arrayOriginMiddleware = new GraphQLMiddleware(arrayOriginDriver, arrayOriginOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
        headers: { origin: 'https://b.com' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await arrayOriginMiddleware.use(req, res, next);

      // Never the invalid `a, b` join, and never the wildcard
      expect(res._headers['Access-Control-Allow-Origin']).toBe('https://b.com');
      expect(res._headers['Vary']).toBe('Origin');
    });

    test('should emit no origin header for an origin outside the allowlist', async () => {
      const arrayOriginOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: {
          origin: ['https://a.com', 'https://b.com'],
        },
      };
      const arrayOriginDriver = new LeavenDriver(arrayOriginOptions);
      await arrayOriginDriver.onModuleInit();
      const arrayOriginMiddleware = new GraphQLMiddleware(arrayOriginDriver, arrayOriginOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
        headers: { origin: 'https://evil.test' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await arrayOriginMiddleware.use(req, res, next);

      expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(res._headers['Vary']).toBe('Origin');
    });

    test('should emit no origin header when origin is false', async () => {
      const denyOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: { origin: false },
      };
      const denyDriver = new LeavenDriver(denyOptions);
      await denyDriver.onModuleInit();
      const denyMiddleware = new GraphQLMiddleware(denyDriver, denyOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
        headers: { origin: 'https://evil.test' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await denyMiddleware.use(req, res, next);

      expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    test('should echo the request origin when origin is true', async () => {
      const trueOriginOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: { origin: true },
      };
      const trueOriginDriver = new LeavenDriver(trueOriginOptions);
      await trueOriginDriver.onModuleInit();
      const trueOriginMiddleware = new GraphQLMiddleware(trueOriginDriver, trueOriginOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
        headers: { origin: 'https://app.example.com' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await trueOriginMiddleware.use(req, res, next);

      expect(res._headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
      expect(res._headers['Vary']).toBe('Origin');
    });

    async function corsPreflight(
      cors: LeavenModuleOptions['cors'],
      origin = 'https://app.example.com'
    ): Promise<Record<string, string>> {
      const corsOptions: LeavenModuleOptions = { schema, path: '/graphql', cors };
      const corsDriver = new LeavenDriver(corsOptions);
      await corsDriver.onModuleInit();
      const corsMiddleware = new GraphQLMiddleware(corsDriver, corsOptions);
      const res = createMockResponse();
      await corsMiddleware.use(
        createMockRequest({ method: 'OPTIONS', path: '/graphql', headers: { origin } }),
        res,
        mock(() => {})
      );
      await corsDriver.onModuleDestroy();
      return res._headers;
    }

    test.each([
      ['an omitted origin', { credentials: true }],
      ["origin '*'", { origin: '*', credentials: true }],
      ['origin true', { origin: true, credentials: true }],
    ] as const)(
      'should emit neither origin nor credentials for %s with credentials',
      async (_label, cors) => {
        const headers = await corsPreflight(cors);

        expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
        expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
        expect(headers['Vary']).toBe('Origin');
      }
    );

    test('should pair credentials with an explicitly allowlisted origin', async () => {
      const headers = await corsPreflight({
        origin: ['https://app.example.com'],
        credentials: true,
      });

      expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
      expect(headers['Access-Control-Allow-Credentials']).toBe('true');
      expect(headers['Vary']).toBe('Origin');
    });

    test('should not send credentials for an origin outside the allowlist', async () => {
      const headers = await corsPreflight(
        { origin: ['https://app.example.com'], credentials: true },
        'https://evil.test'
      );

      expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
    });

    test('should pair credentials with an explicit string origin', async () => {
      const headers = await corsPreflight({
        origin: 'https://app.example.com',
        credentials: true,
      });

      expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
      expect(headers['Access-Control-Allow-Credentials']).toBe('true');
      expect(headers['Vary']).toBe('Origin');
    });

    test('should send the wildcard without Vary when credentials are off', async () => {
      const headers = await corsPreflight({ origin: '*' });

      expect(headers['Access-Control-Allow-Origin']).toBe('*');
      expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
      expect(headers['Vary']).toBeUndefined();
    });

    test('should handle CORS with array methods', async () => {
      const arrayMethodsOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: {
          methods: ['GET', 'POST', 'PUT'],
        },
      };
      const arrayMethodsDriver = new LeavenDriver(arrayMethodsOptions);
      await arrayMethodsDriver.onModuleInit();
      const arrayMethodsMiddleware = new GraphQLMiddleware(arrayMethodsDriver, arrayMethodsOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await arrayMethodsMiddleware.use(req, res, next);

      expect(res._headers['Access-Control-Allow-Methods']).toBe('GET, POST, PUT');
    });

    test('should handle CORS with array allowed headers', async () => {
      const arrayHeadersOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        cors: {
          allowedHeaders: ['X-Custom-Header', 'Authorization'],
        },
      };
      const arrayHeadersDriver = new LeavenDriver(arrayHeadersOptions);
      await arrayHeadersDriver.onModuleInit();
      const arrayHeadersMiddleware = new GraphQLMiddleware(arrayHeadersDriver, arrayHeadersOptions);

      const req = createMockRequest({
        method: 'OPTIONS',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await arrayHeadersMiddleware.use(req, res, next);

      expect(res._headers['Access-Control-Allow-Headers']).toBe('X-Custom-Header, Authorization');
    });

    test('should call next for non-POST/GET/OPTIONS methods', async () => {
      const req = createMockRequest({
        method: 'PUT',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await middleware.use(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('should handle internal server error', async () => {
      // Create a driver that throws on execute
      const brokenDriver = new LeavenDriver({ schema });
      await brokenDriver.onModuleInit();

      // Forcefully break the driver
      (brokenDriver as unknown as { executor: null }).executor = null;

      const brokenMiddleware = new GraphQLMiddleware(brokenDriver, { schema });

      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await brokenMiddleware.use(req, res, next);

      expect(res._status).toBe(500);
      const errors = (res._body as { errors: Array<{ message: string }> }).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('Executor not initialized. Set schema first.');
    });

    test('should preserve the status and code of a Leaven error from the context factory', async () => {
      const authOptions: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        context: async () => {
          throw new AuthenticationError('Token expired');
        },
      };
      const authDriver = new LeavenDriver(authOptions);
      await authDriver.onModuleInit();
      const authMiddleware = new GraphQLMiddleware(authDriver, authOptions);

      const req = createMockRequest({
        method: 'POST',
        path: '/graphql',
        body: { query: '{ hello }' },
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await authMiddleware.use(req, res, next);

      expect(res._status).toBe(401);
      const errors = (res._body as {
        errors: Array<{ message: string; extensions?: Record<string, unknown> }>;
      }).errors;
      expect(errors[0]?.message).toBe('Token expired');
      expect(errors[0]?.extensions?.code).toBe('UNAUTHENTICATED');

      await authDriver.onModuleDestroy();
    });

    test.each([
      ['an UnauthorizedException', () => new UnauthorizedException('bad token'), 401, 'UNAUTHENTICATED', 'bad token'],
      ['a 5xx HttpException', () => new InternalServerErrorException('db down'), 500, 'INTERNAL_ERROR', 'An unexpected error occurred'],
    ] as const)(
      'should map %s from the context factory in production',
      async (_label, make, status, code, message) => {
        await withNodeEnv('production', async () => {
          const nestOptions: LeavenModuleOptions = {
            schema,
            path: '/graphql',
            context: async () => {
              throw make();
            },
          };
          const nestDriver = new LeavenDriver(nestOptions);
          await nestDriver.onModuleInit();
          const nestMiddleware = new GraphQLMiddleware(nestDriver, nestOptions);

          const req = createMockRequest({
            method: 'POST',
            path: '/graphql',
            body: { query: '{ hello }' },
          });
          const res = createMockResponse();

          await nestMiddleware.use(req, res, mock(() => {}));

          expect(res._status).toBe(status);
          const errors = (res._body as {
            errors: Array<{ message: string; extensions?: Record<string, unknown> }>;
          }).errors;
          expect(errors[0]?.message).toBe(message);
          expect(errors[0]?.extensions?.code).toBe(code);

          await nestDriver.onModuleDestroy();
        });
      }
    );

    test('should mask an unexpected context-factory error in production', async () => {
      await withNodeEnv('production', async () => {
        const leakyOptions: LeavenModuleOptions = {
          schema,
          path: '/graphql',
          context: async () => {
            throw new Error('postgres://user:password@db.internal');
          },
        };
        const leakyDriver = new LeavenDriver(leakyOptions);
        await leakyDriver.onModuleInit();
        const leakyMiddleware = new GraphQLMiddleware(leakyDriver, leakyOptions);

        const req = createMockRequest({
          method: 'POST',
          path: '/graphql',
          body: { query: '{ hello }' },
        });
        const res = createMockResponse();
        const next = mock(() => {});

        await leakyMiddleware.use(req, res, next);

        expect(res._status).toBe(500);
        const errors = (res._body as { errors: Array<{ message: string }> }).errors;
        expect(errors[0]?.message).toBe('An unexpected error occurred');
        expect(errors[0]?.message).not.toContain('password');

        await leakyDriver.onModuleDestroy();
      });
    });
  });

  describe('csrfPrevention', () => {
    const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

    async function run(
      req: Request,
      extra: Partial<LeavenModuleOptions> = {}
    ): Promise<{ res: ReturnType<typeof createMockResponse>; resolverCalls: number; contextCalls: number }> {
      let resolverCalls = 0;
      let contextCalls = 0;
      const opts: LeavenModuleOptions = {
        schema: new GraphQLSchema({
          query: new GraphQLObjectType({
            name: 'Query',
            fields: {
              hello: {
                type: GraphQLString,
                resolve: () => {
                  resolverCalls += 1;
                  return 'world';
                },
              },
            },
          }),
        }),
        path: '/graphql',
        context: () => {
          contextCalls += 1;
          return {};
        },
        ...extra,
      };
      const csrfDriver = new LeavenDriver(opts);
      await csrfDriver.onModuleInit();
      const res = createMockResponse();
      await new GraphQLMiddleware(csrfDriver, opts).use(req, res, mock(() => {}));
      return { res, resolverCalls, contextCalls };
    }

    test.each([
      ['a form-urlencoded object body', formHeaders],
      ['a multipart object body', { 'content-type': 'multipart/form-data; boundary=x' }],
      ['a text/plain body', { 'content-type': 'text/plain' }],
      ['a body with no Content-Type', {}],
      ['an empty preflight header', { ...formHeaders, 'x-graphql-csrf': ' ' }],
    ])('should answer 400 without running the context factory or resolver for %s', async (_label, headers) => {
      const { res, resolverCalls, contextCalls } = await run(createMockRequest({ headers }));

      expect(res._status).toBe(400);
      const errors = (res._body as { errors: Array<{ message: string; extensions: { code: string } }> }).errors;
      expect(errors[0]?.message).toStartWith('This request is blocked by CSRF prevention: ');
      expect(errors[0]?.extensions.code).toBe('BAD_REQUEST');
      expect(resolverCalls).toBe(0);
      expect(contextCalls).toBe(0);
    });

    test.each([
      ['x-graphql-csrf', { ...formHeaders, 'x-graphql-csrf': '1' }],
      ['apollo-require-preflight', { ...formHeaders, 'apollo-require-preflight': 'true' }],
      ['x-apollo-operation-name', { ...formHeaders, 'x-apollo-operation-name': 'Hello' }],
      ['a repeated preflight header', { ...formHeaders, 'x-graphql-csrf': ['1', '2'] }],
    ])('should execute a form body that carries %s', async (_label, headers) => {
      const { res, resolverCalls } = await run(createMockRequest({ headers }));

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ data: { hello: 'world' } });
      expect(resolverCalls).toBe(1);
    });

    test('should execute an application/json body', async () => {
      const { res, resolverCalls } = await run(createMockRequest());

      expect(res._status).toBe(200);
      expect(resolverCalls).toBe(1);
    });

    test('should let a form body through when csrfPrevention is false', async () => {
      const { res, resolverCalls } = await run(createMockRequest({ headers: formHeaders }), {
        csrfPrevention: false,
      });

      expect(res._status).toBe(200);
      expect(resolverCalls).toBe(1);
    });

    test('should accept only the configured requestHeaders', async () => {
      const csrfPrevention = { requestHeaders: ['X-My-CSRF'] };
      const custom = await run(
        createMockRequest({ headers: { ...formHeaders, 'x-my-csrf': '1' } }),
        { csrfPrevention }
      );
      const defaultHeader = await run(
        createMockRequest({ headers: { ...formHeaders, 'x-graphql-csrf': '1' } }),
        { csrfPrevention }
      );

      expect(custom.res._status).toBe(200);
      expect(defaultHeader.res._status).toBe(400);
    });

    test.each([['bad header'], ['x-csrf\u0000'], [''], ['a:b']])(
      'should throw a TypeError at construction for the header name %p',
      (name) => {
        const opts: LeavenModuleOptions = { schema, csrfPrevention: { requestHeaders: [name] } };
        expect(() => new GraphQLMiddleware(driver, opts)).toThrow(TypeError);
      }
    );
  });

  describe('formatError hook on thrown errors', () => {
    async function runWith(
      req: Request,
      extra: Partial<LeavenModuleOptions>
    ): Promise<{ res: ReturnType<typeof createMockResponse>; hookCalls: number }> {
      let hookCalls = 0;
      const opts: LeavenModuleOptions = {
        schema,
        path: '/graphql',
        formatError: (e) => {
          hookCalls += 1;
          return e;
        },
        ...extra,
      };
      const d = new LeavenDriver(opts);
      await d.onModuleInit();
      const res = createMockResponse();
      await new GraphQLMiddleware(d, opts).use(req, res, mock(() => {}));
      return { res, hookCalls };
    }

    test('should apply formatError exactly once to a CSRF-blocked request', async () => {
      const { res, hookCalls } = await runWith(
        createMockRequest({
          body: { query: '{ hello }' },
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        }),
        {}
      );
      expect(res._status).toBe(400);
      expect(hookCalls).toBe(1);
    });

    test('should apply formatError exactly once to a query-less POST', async () => {
      const { res, hookCalls } = await runWith(createMockRequest({ body: {} }), {});
      expect(res._status).toBe(400);
      expect(hookCalls).toBe(1);
    });

    test('should derive the status of a coded non-Leaven GraphQLError from its code', async () => {
      const { res } = await runWith(createMockRequest(), {
        context: () => {
          throw new GraphQLError('no', { extensions: { code: 'UNAUTHENTICATED' } });
        },
      });
      expect(res._status).toBe(401);
    });
  });

  describe('playground HTML', () => {
    test('should include the GraphQL endpoint in playground', async () => {
      const req = createMockRequest({
        method: 'GET',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await middleware.use(req, res, next);

      expect(res._body).toContain('/graphql');
    });

    test('should include React and GraphiQL scripts', async () => {
      const req = createMockRequest({
        method: 'GET',
        path: '/graphql',
      });
      const res = createMockResponse();
      const next = mock(() => {});

      await middleware.use(req, res, next);

      expect(res._body).toContain('react');
      expect(res._body).toContain('graphiql');
    });
  });
});

describe('createGraphQLMiddleware', () => {
  test('should return GraphQLMiddleware class', () => {
    const MiddlewareClass = createGraphQLMiddleware();
    expect(MiddlewareClass).toBe(GraphQLMiddleware);
  });
});
