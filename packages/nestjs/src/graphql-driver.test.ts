/**
 * @leaven-graphql/nestjs - LeavenGraphQLDriver end-to-end tests
 *
 * These tests boot a genuine NestJS application on the Bun HTTP adapter, wire
 * `GraphQLModule.forRoot({ driver: LeavenGraphQLDriver })` into it, and drive
 * it over real HTTP with `fetch`. That is the only way to prove the claim this
 * driver exists to make: that NestJS guards, interceptors and parameter
 * decorators actually execute around a Leaven-executed resolver.
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Module,
  type NestInterceptor,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  AbstractGraphQLDriver,
  Args as NestArgs,
  Field,
  GraphQLModule,
  ObjectType,
  Query,
  Resolver,
  Subscription,
} from '@nestjs/graphql';
import { BunAdapter } from '@lexmata/nestjs-platform-bun';
import { GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import type { Observable } from 'rxjs';
import { AuthenticationError, ErrorCode, LeavenError } from '@leaven-graphql/errors';
import { createPubSub } from '@leaven-graphql/ws';
import { map } from 'rxjs/operators';
import { LeavenGraphQLDriver, type LeavenDriverConfig } from './graphql-driver';
import { Args as LeavenArgs, Context as LeavenContext } from './decorators';
import { AuthGuard } from './guards';
import { withNodeEnv } from './test-utils/env';

/**
 * Observable side effects recorded by the guards, interceptors and resolver
 * bodies below. Reset before every request that inspects them.
 */
const spy = {
  blockedResolverBody: 0,
  allowingGuard: 0,
  blockingGuard: 0,
  interceptor: 0,
};

function resetSpy(): void {
  spy.blockedResolverBody = 0;
  spy.allowingGuard = 0;
  spy.blockingGuard = 0;
  spy.interceptor = 0;
}

/** Denies every request by returning `false` — Nest turns that into a 403. */
@Injectable()
class BlockingGuard implements CanActivate {
  public canActivate(): boolean {
    spy.blockingGuard += 1;
    return false;
  }
}

/** Allows every request, recording that it ran. */
@Injectable()
class AllowingGuard implements CanActivate {
  public canActivate(): boolean {
    spy.allowingGuard += 1;
    return true;
  }
}

/** Counts invocations and rewrites the resolved value. */
@Injectable()
class CountingInterceptor implements NestInterceptor {
  public intercept(
    _context: ExecutionContext,
    next: CallHandler
  ): Observable<unknown> {
    spy.interceptor += 1;
    return next.handle().pipe(map((value) => `intercepted:${String(value)}`));
  }
}

@ObjectType()
class Box {
  @Field(() => String)
  public ok!: string;

  /** Nullable so a throwing resolver yields `data` alongside `errors`. */
  @Field(() => String, { nullable: true })
  public boom!: string | null;
}

@Resolver(() => Box)
class BoxResolver {
  @Query(() => Box)
  public box(): Box {
    return { ok: 'fine', boom: null };
  }

  /** Nullable so the failure is confined to this field and `data` survives. */
  @Query(() => String, { nullable: true })
  public boxBoom(): string {
    throw new Error('resolver exploded');
  }
}

@Resolver()
class TestResolver {
  /** Guard returns false — this body must never run. */
  @Query(() => String)
  @UseGuards(BlockingGuard)
  public blocked(): string {
    spy.blockedResolverBody += 1;
    return 'the-guard-did-not-run';
  }

  /** Guard returns true — the body runs. */
  @Query(() => String)
  @UseGuards(AllowingGuard)
  public allowed(): string {
    return 'allowed';
  }

  /** Leaven's shipped `AuthGuard`: denies when the context has no user. */
  @Query(() => String)
  @UseGuards(AuthGuard)
  public secret(): string {
    return 'top-secret';
  }

  /** `@Args` from `@nestjs/graphql`. */
  @Query(() => String)
  public echo(@NestArgs('id', { type: () => String }) id: string): string {
    return `echo:${id}`;
  }

  /**
   * Leaven's own `@Args()` and `@Context()` param decorators.
   *
   * The first parameter exists only so `@nestjs/graphql`'s code-first schema
   * builder declares an `id` argument on the field; the value under test is
   * the one Leaven's decorator extracts into the second parameter.
   */
  @Query(() => String)
  public leavenParams(
    @NestArgs('id', { type: () => String }) _declaresIdArg: string,
    @LeavenArgs('id') id: string,
    @LeavenContext() context: Record<string, unknown>
  ): string {
    const user = context.user as { id: string } | null | undefined;
    return `${id}|${user?.id ?? 'anonymous'}`;
  }

  /** Interceptor rewrites the value on the way out. */
  @Query(() => String)
  @UseInterceptors(CountingInterceptor)
  public intercepted(): string {
    return 'raw';
  }
}

interface BunHeaders {
  [key: string]: string | string[] | undefined;
}

@Module({
  imports: [
    GraphQLModule.forRoot<LeavenDriverConfig>({
      driver: LeavenGraphQLDriver,
      autoSchemaFile: true,
      playground: true,
      path: '/graphql',
      context: ({ req }: { req: { headers: BunHeaders } }) => {
        const header = req.headers['x-user'];
        const userId = Array.isArray(header) ? header[0] : header;
        return {
          req,
          user: userId ? { id: userId, roles: ['admin'] } : null,
        };
      },
    }),
  ],
  providers: [TestResolver, BoxResolver, BlockingGuard, AllowingGuard, CountingInterceptor],
})
class AppModule {}

/**
 * Reserve an ephemeral port by binding and immediately releasing one, so the
 * test suite never collides with a port already in use on the machine.
 */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = server;
  await server.stop(true);
  return port;
}

interface GraphQLHttpResult {
  status: number;
  body: {
    data?: Record<string, unknown> | null;
    errors?: { message: string; extensions?: Record<string, unknown> }[];
  };
}

describe('LeavenGraphQLDriver (end-to-end over HTTP)', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let url: string;

  beforeAll(async () => {
    const port = await freePort();
    app = await NestFactory.create(AppModule, new BunAdapter(), { logger: false });
    await app.listen(port);
    url = `http://127.0.0.1:${port}/graphql`;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function post(
    query: string,
    headers: Record<string, string> = {}
  ): Promise<GraphQLHttpResult> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query }),
    });
    return {
      status: response.status,
      body: (await response.json()) as GraphQLHttpResult['body'],
    };
  }

  it('should block the query when a guard returns false and never runs the resolver', async () => {
    resetSpy();

    const result = await post('{ blocked }');

    expect(spy.blockingGuard).toBe(1);
    expect(spy.blockedResolverBody).toBe(0);
    expect(result.body.data?.blocked ?? null).toBeNull();
    expect(result.body.errors?.length).toBeGreaterThan(0);
    expect(result.body.errors?.[0]?.message).toContain('Forbidden');
    expect(result.status).toBe(403);
  });

  it('should let the query through when a guard returns true', async () => {
    resetSpy();

    const result = await post('{ allowed }');

    expect(spy.allowingGuard).toBe(1);
    expect(result.status).toBe(200);
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data?.allowed).toBe('allowed');
  });

  it("should run Leaven's AuthGuard: 401 without a user, 200 with one", async () => {
    const denied = await post('{ secret }');
    expect(denied.status).toBe(401);
    expect(denied.body.data?.secret ?? null).toBeNull();
    expect(denied.body.errors?.[0]?.message).toContain('Authentication required');

    const allowed = await post('{ secret }', { 'x-user': 'u-1' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data?.secret).toBe('top-secret');
  });

  it('should deliver the real argument value to @Args()', async () => {
    const result = await post('{ echo(id: "abc-123") }');

    expect(result.status).toBe(200);
    expect(result.body.data?.echo).toBe('echo:abc-123');
  });

  it("should deliver arguments and context to Leaven's own @Args() and @Context()", async () => {
    const result = await post('{ leavenParams(id: "xyz") }', { 'x-user': 'u-7' });

    expect(result.status).toBe(200);
    expect(result.body.data?.leavenParams).toBe('xyz|u-7');
  });

  it('should run an interceptor around the resolver and transform the result', async () => {
    resetSpy();

    const result = await post('{ intercepted }');

    expect(spy.interceptor).toBe(1);
    expect(result.status).toBe(200);
    expect(result.body.data?.intercepted).toBe('intercepted:raw');
  });

  it('should return HTTP 200 for a partial success carrying both data and errors', async () => {
    const result = await post('{ box { ok boom } boxBoom }');

    expect(result.status).toBe(200);
    expect(result.body.data).not.toBeNull();
    expect((result.body.data?.box as { ok: string }).ok).toBe('fine');
    expect(result.body.errors?.length).toBeGreaterThan(0);
  });

  it("should map a guard's HttpException to the matching ErrorCode in extensions", async () => {
    const result = await post('{ blocked }');

    // The executor's `formatExecutionError` hook is the only place the NestJS
    // exception is still reachable as `originalError`; without it the error
    // reaches the client codeless and is treated as a 500.
    expect(result.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(result.body.errors?.[0]?.extensions?.statusCode).toBe(403);
  });

  it('should leave a plain resolver error as INTERNAL_ERROR', async () => {
    const result = await post('{ boxBoom }');

    // `boxBoom` is nullable, so this is a partial success: 200 with errors.
    expect(result.status).toBe(200);
    expect(result.body.errors?.[0]?.message).toBe('resolver exploded');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('INTERNAL_ERROR');
  });

  it('should reject a document over the default 10000-token parse budget', async () => {
    const result = await post(`{ ${'allowed '.repeat(10_001)} }`);

    expect(result.body.data ?? null).toBeNull();
    expect(result.body.errors?.[0]?.message).toMatch(/tokens/i);
  });

  it('should serve GraphiQL over GET when playground is enabled', async () => {
    const response = await fetch(url, { method: 'GET' });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('graphiql');
  });
});

describe('LeavenGraphQLDriver.stop()', () => {
  it('should release the executor', async () => {
    const port = await freePort();
    const app = await NestFactory.create(AppModule, new BunAdapter(), {
      logger: false,
    });
    await app.listen(port);

    // `GraphQLModule` registers the driver under the `AbstractGraphQLDriver`
    // token, not under the concrete class.
    const driver = app.get<LeavenGraphQLDriver>(AbstractGraphQLDriver, {
      strict: false,
    });
    expect(driver).toBeInstanceOf(LeavenGraphQLDriver);
    expect(driver.getExecutor()).not.toBeNull();

    await driver.stop();
    expect(driver.getExecutor()).toBeNull();

    await app.close();
  });
});

describe('LeavenGraphQLDriver.subscriptionWithFilter()', () => {
  async function* events(): AsyncGenerator<{ roomId: string; n: number }> {
    yield { roomId: 'a', n: 1 };
    yield { roomId: 'b', n: 2 };
    yield { roomId: 'a', n: 3 };
  }

  it('should yield only the events the filter accepts, with the resolver as this', async () => {
    const driver = new LeavenGraphQLDriver();
    const instance = { wanted: 'a' };
    const seen: unknown[][] = [];
    const subscribe = driver.subscriptionWithFilter(
      instance,
      function (this: typeof instance, payload, variables, context) {
        seen.push([this, variables, context, arguments[3]]);
        return (payload as { roomId: string }).roomId === this.wanted;
      },
      () => () => events()
    );

    const info = { fieldName: 'messageAdded' };
    const iterator = await subscribe(undefined, { roomId: 'a' }, { user: 'u' }, info);
    const received: number[] = [];
    for await (const event of iterator) {
      received.push((event as { n: number }).n);
    }

    expect(received).toEqual([1, 3]);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual([instance, { roomId: 'a' }, { user: 'u' }, info]);
  });

  it('should apply the filter option of a code-first @Subscription end to end', async () => {
    const pubSub = createPubSub();

    @ObjectType()
    class RoomMessage {
      @Field(() => String)
      public roomId!: string;

      @Field(() => String)
      public body!: string;
    }

    @Resolver()
    class RoomResolver {
      @Query(() => String)
      public ping(): string {
        return 'pong';
      }

      @Subscription(() => RoomMessage, {
        filter: (
          payload: { messageAdded: { roomId: string } },
          variables: { roomId: string }
        ) => payload.messageAdded.roomId === variables.roomId,
      })
      public messageAdded(
        @NestArgs('roomId', { type: () => String }) _roomId: string
      ): AsyncIterableIterator<unknown> {
        return pubSub.asyncIterator('MESSAGE_ADDED');
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRoot<LeavenDriverConfig>({
          driver: LeavenGraphQLDriver,
          autoSchemaFile: true,
          path: '/graphql',
        }),
      ],
      providers: [RoomResolver],
    })
    class RoomModule {}

    const app = await NestFactory.create(RoomModule, new BunAdapter(), { logger: false });
    await app.init();
    try {
      const driver = app.get<LeavenGraphQLDriver>(AbstractGraphQLDriver, { strict: false });
      const result = await driver.getExecutor()!.subscribe({
        query: 'subscription { messageAdded(roomId: "a") { roomId body } }',
      });
      expect(Symbol.asyncIterator in Object(result)).toBe(true);
      const iterator = result as AsyncIterableIterator<{ data?: unknown }>;

      const first = iterator.next();
      pubSub.publish('MESSAGE_ADDED', { messageAdded: { roomId: 'b', body: 'other room' } });
      pubSub.publish('MESSAGE_ADDED', { messageAdded: { roomId: 'a', body: 'mine' } });

      expect((await first).value?.data).toEqual({
        messageAdded: { roomId: 'a', body: 'mine' },
      });
      await iterator.return?.();
    } finally {
      await app.close();
    }
  });

  it('should hand a non-iterable resolver result back unwrapped', async () => {
    const driver = new LeavenGraphQLDriver();
    const subscribe = driver.subscriptionWithFilter(
      undefined,
      () => true,
      () => () => undefined
    );

    expect(await subscribe(undefined, {}, {}, {})).toBeUndefined();
  });

  it('should forward return() to an idle source', async () => {
    const driver = new LeavenGraphQLDriver();
    let returned = false;
    const idle: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => new Promise<IteratorResult<unknown>>(() => {}),
      return: async () => {
        returned = true;
        return { value: undefined, done: true };
      },
    };
    const subscribe = driver.subscriptionWithFilter(
      undefined,
      () => true,
      () => () => Promise.resolve(idle)
    );

    const iterator = await subscribe(undefined, {}, {}, {});
    void iterator.next();
    await iterator.return?.();

    expect(returned).toBe(true);
  });
});

/**
 * Unit-level tests that drive {@link LeavenGraphQLDriver} through a fake HTTP
 * adapter, so each transport claim can be checked in isolation (environment,
 * options, request shape) without booting a NestJS application per case.
 */
describe('LeavenGraphQLDriver (fake adapter)', () => {
  interface Captured {
    status: number;
    body: {
      data?: Record<string, unknown> | null;
      errors?: { message: string; extensions?: Record<string, unknown> }[];
      extensions?: Record<string, unknown>;
    };
  }

  type Handler = (req: Record<string, unknown>, res: unknown) => Promise<void>;

  let resolverCalls = 0;

  const unitSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        hello: { type: GraphQLString, resolve: () => 'world' },
        count: {
          type: GraphQLString,
          resolve: () => {
            resolverCalls += 1;
            return 'counted';
          },
        },
        crash: {
          type: new GraphQLNonNull(GraphQLString),
          resolve: () => {
            throw new Error('db password hunter2');
          },
        },
        whoami: {
          type: GraphQLString,
          resolve: (_root: unknown, _args: unknown, ctx: Record<string, unknown>) =>
            `${String(ctx.tenant)}|${ctx.req ? 'req' : 'no-req'}|${ctx.res ? 'res' : 'no-res'}`,
        },
      },
    }),
  });

  async function startDriver(
    config: Partial<LeavenDriverConfig> = {}
  ): Promise<{ driver: LeavenGraphQLDriver; handler: Handler }> {
    const driver = new LeavenGraphQLDriver();
    let handler: Handler | undefined;
    (driver as unknown as { httpAdapterHost: unknown }).httpAdapterHost = {
      httpAdapter: {
        post: (_path: string, fn: Handler) => {
          handler = fn;
        },
        get: () => undefined,
      },
    };
    await driver.start({ path: '/graphql', schema: unitSchema, ...config } as LeavenDriverConfig);
    if (!handler) throw new Error('POST handler was not registered');
    return { driver, handler };
  }

  async function call(handler: Handler, req: Record<string, unknown>): Promise<Captured> {
    const captured: Captured = { status: 0, body: {} };
    const res = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      json(body: Captured['body']) {
        captured.body = body;
        return res;
      },
      send: () => res,
      setHeader: () => res,
    };
    // JSON by default, as a real client sends; a test passing `headers`
    // replaces the whole map.
    await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, ...req }, res);
    return captured;
  }

  it('should mask a residual INTERNAL_ERROR in production', async () => {
    const result = await withNodeEnv('production', async () => {
      const { driver, handler } = await startDriver();
      const response = await call(handler, { body: { query: '{ crash }' } });
      await driver.stop();
      return response;
    });

    expect(result.status).toBe(500);
    expect(result.body.errors).toEqual([
      {
        message: 'An unexpected error occurred',
        locations: [{ line: 1, column: 3 }],
        path: ['crash'],
        extensions: { code: 'INTERNAL_ERROR' },
      },
    ]);
  });

  it('should keep the real message in production when includeStacktraceInErrorResponses is set', async () => {
    const result = await withNodeEnv('production', async () => {
      const { driver, handler } = await startDriver({ includeStacktraceInErrorResponses: true });
      const response = await call(handler, { body: { query: '{ crash }' } });
      await driver.stop();
      return response;
    });

    expect(result.body.errors?.[0]?.message).toBe('db password hunter2');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('INTERNAL_ERROR');
  });

  it('should apply the user formatError after masking', async () => {
    const seen: string[] = [];
    const result = await withNodeEnv('production', async () => {
      const { driver, handler } = await startDriver({
        formatError: (error) => {
          seen.push(error.message);
          return { ...error, message: `formatted:${error.message}` };
        },
      });
      const response = await call(handler, { body: { query: '{ crash }' } });
      await driver.stop();
      return response;
    });

    expect(seen).toEqual(['An unexpected error occurred']);
    expect(result.body.errors?.[0]?.message).toBe('formatted:An unexpected error occurred');
  });

  it.each([
    ['a CSRF-blocked request', {}, { body: { query: '{ hello }' }, headers: { 'content-type': 'text/plain' } }],
    [
      'a 415 raw body',
      {},
      { headers: {}, raw: new Request('http://localhost/graphql', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain', 'X-GraphQL-CSRF': '1' } }) },
    ],
    [
      'a throwing context factory',
      { context: () => { throw new AuthenticationError('Token expired'); } },
      { body: { query: '{ hello }' } },
    ],
    ['an execution error', {}, { body: { query: '{ crash }' } }],
  ] as const)('should run the user formatError exactly once for %s', async (_label, config, req) => {
    let calls = 0;
    const { driver, handler } = await startDriver({
      ...(config as Partial<LeavenDriverConfig>),
      formatError: (error) => {
        calls += 1;
        return error;
      },
    });
    const result = await call(handler, req as Record<string, unknown>);
    await driver.stop();

    expect(result.body.errors).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('should merge a context factory result over req/res and pass it { req, res }', async () => {
    let received: Record<string, unknown> | undefined;
    const { driver, handler } = await startDriver({
      context: (base: Record<string, unknown>) => {
        received = base;
        return { tenant: 'acme' };
      },
    });
    const result = await call(handler, { body: { query: '{ whoami }' } });
    await driver.stop();

    expect(Object.keys(received ?? {}).sort()).toEqual(['req', 'res']);
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ whoami: 'acme|req|res' });
  });

  it('should merge a context object over req/res', async () => {
    const { driver, handler } = await startDriver({ context: { tenant: 'static' } });
    const result = await call(handler, { body: { query: '{ whoami }' } });
    await driver.stop();

    expect(result.body.data).toEqual({ whoami: 'static|req|res' });
  });

  it('should turn a throwing context factory into a coded error with its own status', async () => {
    const { driver, handler } = await startDriver({
      context: () => {
        throw new AuthenticationError('Token expired');
      },
    });
    const result = await call(handler, { body: { query: '{ hello }' } });
    await driver.stop();

    expect(result.status).toBe(401);
    expect(result.body.errors?.[0]?.message).toBe('Token expired');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('should map an HttpException from the context factory to its status and code in production', async () => {
    const result = await withNodeEnv('production', async () => {
      const { driver, handler } = await startDriver({
        context: () => {
          throw new UnauthorizedException('bad token');
        },
      });
      const response = await call(handler, { body: { query: '{ hello }' } });
      await driver.stop();
      return response;
    });

    expect(result.status).toBe(401);
    expect(result.body.errors?.[0]?.message).toBe('bad token');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });

  it('should keep masking a 5xx HttpException from the context factory in production', async () => {
    const result = await withNodeEnv('production', async () => {
      const { driver, handler } = await startDriver({
        context: () => {
          throw new InternalServerErrorException('db down');
        },
      });
      const response = await call(handler, { body: { query: '{ hello }' } });
      await driver.stop();
      return response;
    });

    expect(result.status).toBe(500);
    expect(result.body.errors?.[0]?.message).toBe('An unexpected error occurred');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('INTERNAL_ERROR');
  });

  it("should answer a thrown LeavenError's own statusCode, not its code's default", async () => {
    const { driver, handler } = await startDriver({
      context: () => {
        throw new LeavenError('Tenant already exists', ErrorCode.BAD_REQUEST, { statusCode: 409 });
      },
    });
    const result = await call(handler, { body: { query: '{ hello }' } });
    await driver.stop();

    expect(result.status).toBe(409);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
  });

  it('should answer 503 once the driver has stopped', async () => {
    const { driver, handler } = await startDriver();
    await driver.stop();

    const result = await call(handler, { body: { query: '{ hello }' } });

    expect(result.status).toBe(503);
    expect(result.body.errors?.[0]?.message).toBe('GraphQL server is not running');
  });

  it('should answer 400 for a non-JSON string body', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, {
      body: '{ not json',
      headers: { 'content-type': 'application/json' },
    });
    await driver.stop();

    expect(result.status).toBe(400);
    expect(result.body.errors?.[0]?.message).toBe('Malformed request body: expected JSON');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
  });

  const rawRequest = (body: BodyInit, headers: Record<string, string> = {}): Request =>
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });

  it('should answer 400 for a raw body that is not JSON', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, { raw: rawRequest('{ not json') });
    await driver.stop();

    expect(result.status).toBe(400);
    expect(result.body.errors?.[0]?.message).toBe('Malformed request body: expected JSON');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
  });

  it('should fall back to the parsed body when raw is a Node IncomingMessage', async () => {
    const { driver, handler } = await startDriver();
    // Node-style: plain-object headers, no headers.get and no Fetch body
    const result = await call(handler, {
      body: { query: '{ hello }' },
      headers: { 'content-type': 'application/json' },
      raw: { headers: { 'content-type': 'application/json' } },
    });
    await driver.stop();

    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ hello: 'world' });
  });

  it('should apply CSRF prevention when raw is a Node IncomingMessage', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, {
      body: { query: '{ hello }' },
      headers: { 'content-type': 'text/plain' },
      raw: { headers: { 'content-type': 'text/plain' } },
    });
    await driver.stop();

    expect(result.status).toBe(400);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
  });

  it('should execute a valid raw body read from the Fetch Request', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, {
      raw: rawRequest(JSON.stringify({ query: '{ hello }' })),
    });
    await driver.stop();

    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ hello: 'world' });
  });

  it('should answer 413 PAYLOAD_TOO_LARGE for a raw body over maxBodySize', async () => {
    const { driver, handler } = await startDriver({ maxBodySize: 10 });
    const declared = await call(handler, {
      raw: rawRequest(JSON.stringify({ query: '{ hello }' })),
    });
    const streamed = await call(handler, {
      raw: rawRequest(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ query: '{ hello }' })));
            controller.close();
          },
        })
      ),
    });
    await driver.stop();

    for (const result of [declared, streamed]) {
      expect(result.status).toBe(413);
      expect(result.body.errors?.[0]?.message).toBe('Request body too large');
      expect(result.body.errors?.[0]?.extensions?.code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('should default the raw body limit to 1_000_000 bytes', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, {
      raw: rawRequest(`{"query":"{ hello }"}${' '.repeat(1_000_001)}`),
    });
    await driver.stop();

    expect(result.status).toBe(413);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('should answer 400 BAD_REQUEST when a raw body misses bodyReadTimeoutMs', async () => {
    const { driver, handler } = await startDriver({ bodyReadTimeoutMs: 20 });
    const started = Date.now();
    const result = await call(handler, {
      raw: rawRequest(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })),
    });
    await driver.stop();

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.status).toBe(400);
    expect(result.body.errors?.[0]?.message).toBe('Timed out reading request body after 20ms');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
  });

  // Each carries `x-graphql-csrf` so it gets past CSRF prevention and reaches
  // the Content-Type check, which still refuses a body it would parse itself.
  const csrf = { 'x-graphql-csrf': '1' };
  it.each([
    ['a text/plain raw body', { headers: {}, raw: rawRequest(JSON.stringify({ query: '{ count }' }), { 'Content-Type': 'text/plain', ...csrf }) }],
    ['a text/plain string body', { body: JSON.stringify({ query: '{ count }' }), headers: { 'content-type': 'text/plain', ...csrf } }],
    ['a smuggled text/plain; x=application/json raw body', { headers: {}, raw: rawRequest(JSON.stringify({ query: '{ count }' }), { 'Content-Type': 'text/plain; x=application/json', ...csrf }) }],
    ['a smuggled text/plain;application/json string body', { body: JSON.stringify({ query: '{ count }' }), headers: { 'content-type': 'text/plain;application/json', ...csrf } }],
    ['a string body with no Content-Type', { body: JSON.stringify({ query: '{ count }' }), headers: csrf }],
  ])('should answer 415 without executing for %s', async (_label, req) => {
    const { driver, handler } = await startDriver();
    const before = resolverCalls;
    const result = await call(handler, req);
    await driver.stop();

    expect(result.status).toBe(415);
    expect(result.body.errors?.[0]?.message).toBe('Unsupported Content-Type: use application/json');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
    expect(resolverCalls).toBe(before);
  });

  describe('csrfPrevention', () => {
    const formBody = { query: '{ count }' };
    const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

    it.each([
      ['a form-urlencoded object body', { body: formBody, headers: formHeaders }],
      ['a multipart object body', { body: formBody, headers: { 'content-type': 'multipart/form-data; boundary=x' } }],
      ['a text/plain string body', { body: JSON.stringify(formBody), headers: { 'content-type': 'text/plain' } }],
      ['an object body with no Content-Type', { body: formBody, headers: {} }],
      ['a text/plain raw body', { headers: {}, raw: rawRequest(JSON.stringify(formBody), { 'Content-Type': 'text/plain' }) }],
      ['an empty preflight header', { body: formBody, headers: { ...formHeaders, 'x-graphql-csrf': '  ' } }],
    ])('should answer 400 without building the context or executing for %s', async (_label, req) => {
      let contextCalls = 0;
      const { driver, handler } = await startDriver({
        context: () => {
          contextCalls += 1;
          return {};
        },
      });
      const before = resolverCalls;
      const result = await call(handler, req);
      await driver.stop();

      expect(result.status).toBe(400);
      expect(result.body.errors?.[0]?.message).toStartWith(
        'This request is blocked by CSRF prevention: '
      );
      expect(result.body.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
      expect(resolverCalls).toBe(before);
      expect(contextCalls).toBe(0);
    });

    it.each([
      ['x-graphql-csrf', { ...formHeaders, 'x-graphql-csrf': '1' }],
      ['apollo-require-preflight', { ...formHeaders, 'apollo-require-preflight': 'true' }],
      ['x-apollo-operation-name', { ...formHeaders, 'x-apollo-operation-name': 'Count' }],
    ])('should execute a form body that carries %s', async (_label, headers) => {
      const { driver, handler } = await startDriver();
      const before = resolverCalls;
      const result = await call(handler, { body: formBody, headers });
      await driver.stop();

      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ count: 'counted' });
      expect(resolverCalls).toBe(before + 1);
    });

    it('should accept a capitalised X-GraphQL-CSRF key in a Node header map', async () => {
      const { driver, handler } = await startDriver();
      const result = await call(handler, {
        body: formBody,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-GraphQL-CSRF': '1' },
      });
      await driver.stop();

      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ count: 'counted' });
    });

    it('should read the preflight header from the raw Fetch Request', async () => {
      const { driver, handler } = await startDriver();
      const result = await call(handler, {
        body: formBody,
        headers: formHeaders,
        raw: rawRequest('', {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-GraphQL-CSRF': '1',
        }),
      });
      await driver.stop();

      expect(result.status).toBe(200);
    });

    it('should execute an application/json object body', async () => {
      const { driver, handler } = await startDriver();
      const result = await call(handler, { body: formBody });
      await driver.stop();

      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ count: 'counted' });
    });

    it('should let a form body through when csrfPrevention is false', async () => {
      const { driver, handler } = await startDriver({ csrfPrevention: false });
      const result = await call(handler, { body: formBody, headers: formHeaders });
      await driver.stop();

      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({ count: 'counted' });
    });

    it('should accept only the configured requestHeaders, normalized', async () => {
      const { driver, handler } = await startDriver({
        csrfPrevention: { requestHeaders: ['  X-My-CSRF '] },
      });
      const custom = await call(handler, {
        body: formBody,
        headers: { ...formHeaders, 'x-my-csrf': '1' },
      });
      const defaultHeader = await call(handler, {
        body: formBody,
        headers: { ...formHeaders, 'x-graphql-csrf': '1' },
      });
      await driver.stop();

      expect(custom.status).toBe(200);
      expect(defaultHeader.status).toBe(400);
    });

    it('should throw a TypeError from start() for an invalid header name', async () => {
      await expect(
        startDriver({ csrfPrevention: { requestHeaders: ['bad header'] } })
      ).rejects.toThrow(TypeError);
    });
  });

  it('should accept a string body whose Content-Type names application/json', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, {
      body: JSON.stringify({ query: '{ hello }' }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    await driver.stop();

    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ hello: 'world' });
  });

  it('should answer 400 when the query is missing', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, { body: {} });
    await driver.stop();

    expect(result.status).toBe(400);
    expect(result.body.errors?.[0]?.message).toBe('Query is required');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['a JSON null body', { body: 'null', headers: { 'content-type': 'application/json' } }, 'Request body must be a JSON object'],
    ['a raw body of JSON null', { raw: rawRequest('null') }, 'Request body must be a JSON object'],
    ['a numeric query', { body: { query: 42 } }, 'Query is required'],
    ['an array variables', { body: { query: '{ hello }', variables: [1] } }, '"variables" must be a JSON object'],
    ['an object operationName', { body: { query: '{ hello }', operationName: { a: 1 } } }, '"operationName" must be a string'],
  ])('should answer 400 VALIDATION_ERROR for %s', async (_label, req, message) => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, req);
    await driver.stop();

    expect(result.status).toBe(400);
    expect(result.body.errors?.[0]?.message).toBe(message);
    expect(result.body.errors?.[0]?.extensions?.code).toBe('VALIDATION_ERROR');
  });

  it('should treat null variables and operationName as absent', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, {
      body: { query: '{ hello }', variables: null, operationName: null },
    });
    await driver.stop();

    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ hello: 'world' });
  });

  it('should derive a total failure status from ERROR_CODES', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, { body: { query: '{ nope }' } });
    await driver.stop();

    expect(result.body.data ?? null).toBeNull();
    expect(result.body.errors?.[0]?.extensions?.code).toBe('VALIDATION_ERROR');
    expect(result.status).toBe(400);
  });

  it('should report metrics under extensions when enabled', async () => {
    const { driver, handler } = await startDriver({ metrics: true });
    const result = await call(handler, { body: { query: '{ hello }' } });
    await driver.stop();

    expect(result.body.data).toEqual({ hello: 'world' });
    expect(result.body.extensions?.metrics).toBeDefined();
  });

  it('should omit metrics when disabled', async () => {
    const { driver, handler } = await startDriver();
    const result = await call(handler, { body: { query: '{ hello }' } });
    await driver.stop();

    expect(result.body.extensions?.metrics).toBeUndefined();
  });
});
