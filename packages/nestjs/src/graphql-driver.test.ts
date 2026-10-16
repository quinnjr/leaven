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
  Module,
  type NestInterceptor,
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
} from '@nestjs/graphql';
import { BunAdapter } from '@lexmata/nestjs-platform-bun';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { LeavenGraphQLDriver, type LeavenDriverConfig } from './graphql-driver';
import { Args as LeavenArgs, Context as LeavenContext } from './decorators';
import { AuthGuard } from './guards';

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

  it('blocks the query when a guard returns false and never runs the resolver', async () => {
    resetSpy();

    const result = await post('{ blocked }');

    expect(spy.blockingGuard).toBe(1);
    expect(spy.blockedResolverBody).toBe(0);
    expect(result.body.data?.blocked ?? null).toBeNull();
    expect(result.body.errors?.length).toBeGreaterThan(0);
    expect(result.body.errors?.[0]?.message).toContain('Forbidden');
    expect(result.status).toBe(403);
  });

  it('lets the query through when a guard returns true', async () => {
    resetSpy();

    const result = await post('{ allowed }');

    expect(spy.allowingGuard).toBe(1);
    expect(result.status).toBe(200);
    expect(result.body.errors).toBeUndefined();
    expect(result.body.data?.allowed).toBe('allowed');
  });

  it("runs Leaven's AuthGuard: 401 without a user, 200 with one", async () => {
    const denied = await post('{ secret }');
    expect(denied.status).toBe(401);
    expect(denied.body.data?.secret ?? null).toBeNull();
    expect(denied.body.errors?.[0]?.message).toContain('Authentication required');

    const allowed = await post('{ secret }', { 'x-user': 'u-1' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data?.secret).toBe('top-secret');
  });

  it('delivers the real argument value to @Args()', async () => {
    const result = await post('{ echo(id: "abc-123") }');

    expect(result.status).toBe(200);
    expect(result.body.data?.echo).toBe('echo:abc-123');
  });

  it("delivers arguments and context to Leaven's own @Args() and @Context()", async () => {
    const result = await post('{ leavenParams(id: "xyz") }', { 'x-user': 'u-7' });

    expect(result.status).toBe(200);
    expect(result.body.data?.leavenParams).toBe('xyz|u-7');
  });

  it('runs an interceptor around the resolver and transforms the result', async () => {
    resetSpy();

    const result = await post('{ intercepted }');

    expect(spy.interceptor).toBe(1);
    expect(result.status).toBe(200);
    expect(result.body.data?.intercepted).toBe('intercepted:raw');
  });

  it('returns HTTP 200 for a partial success carrying both data and errors', async () => {
    const result = await post('{ box { ok boom } boxBoom }');

    expect(result.status).toBe(200);
    expect(result.body.data).not.toBeNull();
    expect((result.body.data?.box as { ok: string }).ok).toBe('fine');
    expect(result.body.errors?.length).toBeGreaterThan(0);
  });

  it("maps a guard's HttpException to the matching ErrorCode in extensions", async () => {
    const result = await post('{ blocked }');

    // The executor's `formatExecutionError` hook is the only place the NestJS
    // exception is still reachable as `originalError`; without it the error
    // reaches the client codeless and is treated as a 500.
    expect(result.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    expect(result.body.errors?.[0]?.extensions?.statusCode).toBe(403);
  });

  it('leaves a plain resolver error as INTERNAL_ERROR', async () => {
    const result = await post('{ boxBoom }');

    // `boxBoom` is nullable, so this is a partial success: 200 with errors.
    expect(result.status).toBe(200);
    expect(result.body.errors?.[0]?.message).toBe('resolver exploded');
    expect(result.body.errors?.[0]?.extensions?.code).toBe('INTERNAL_ERROR');
  });

  it('rejects a document over the default 10000-token parse budget', async () => {
    const result = await post(`{ ${'allowed '.repeat(10_001)} }`);

    expect(result.body.data ?? null).toBeNull();
    expect(result.body.errors?.[0]?.message).toMatch(/tokens/i);
  });

  it('serves GraphiQL over GET when playground is enabled', async () => {
    const response = await fetch(url, { method: 'GET' });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('graphiql');
  });
});

describe('LeavenGraphQLDriver.stop()', () => {
  it('releases the executor', async () => {
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
