/**
 * @leaven-graphql/nestjs - Guards tests
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { describe, test, expect } from 'bun:test';
import 'reflect-metadata';
import {
  Public,
  Roles,
  Permissions,
  IS_PUBLIC_KEY,
  ROLES_KEY,
  PERMISSIONS_KEY,
  AuthGuard,
  RolesGuard,
  PermissionsGuard,
  ComplexityGuard,
  DepthGuard,
} from './guards';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { GraphQLSchema, GraphQLObjectType, GraphQLString } from 'graphql';
import { LeavenDriver } from './driver';
import type { GqlContext } from './types';

describe('Guard Decorators', () => {
  describe('Public', () => {
    test('should set public metadata', () => {
      class TestClass {
        @Public()
        publicMethod() {}
      }

      const metadata = Reflect.getMetadata(IS_PUBLIC_KEY, TestClass.prototype.publicMethod);
      expect(metadata).toBe(true);
    });
  });

  describe('Roles', () => {
    test('should set single role metadata', () => {
      class TestClass {
        @Roles('admin')
        adminMethod() {}
      }

      const metadata = Reflect.getMetadata(ROLES_KEY, TestClass.prototype.adminMethod);
      expect(metadata).toEqual(['admin']);
    });

    test('should set multiple roles metadata', () => {
      class TestClass {
        @Roles('admin', 'moderator')
        restrictedMethod() {}
      }

      const metadata = Reflect.getMetadata(ROLES_KEY, TestClass.prototype.restrictedMethod);
      expect(metadata).toEqual(['admin', 'moderator']);
    });
  });

  describe('Permissions', () => {
    test('should set single permission metadata', () => {
      class TestClass {
        @Permissions('user:read')
        readMethod() {}
      }

      const metadata = Reflect.getMetadata(PERMISSIONS_KEY, TestClass.prototype.readMethod);
      expect(metadata).toEqual(['user:read']);
    });

    test('should set multiple permissions metadata', () => {
      class TestClass {
        @Permissions('user:read', 'user:write', 'user:delete')
        crudMethod() {}
      }

      const metadata = Reflect.getMetadata(PERMISSIONS_KEY, TestClass.prototype.crudMethod);
      expect(metadata).toEqual(['user:read', 'user:write', 'user:delete']);
    });
  });
});

describe('AuthGuard', () => {
  function createMockContext(
    _isPublic: boolean | undefined,
    user: unknown
  ): ExecutionContext {
    return {
      getHandler: () => ({ name: 'testHandler' }),
      getClass: () => ({ name: 'TestClass' }),
      getArgs: () => [{}, {}, { user, req: { user } }, {}],
      getType: () => 'graphql',
      switchToHttp: () => ({} as unknown),
      switchToRpc: () => ({} as unknown),
      switchToWs: () => ({} as unknown),
      getArgByIndex: () => ({} as unknown),
    } as unknown as ExecutionContext;
  }

  test('should allow access for public routes', () => {
    const reflector = new Reflector();
    const originalGet = reflector.getAllAndOverride;
    reflector.getAllAndOverride = () => true;

    const guard = new AuthGuard(reflector);
    const context = createMockContext(true, null);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
    reflector.getAllAndOverride = originalGet;
  });

  test('should allow access for authenticated users', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => false;

    const guard = new AuthGuard(reflector);
    const context = createMockContext(false, { id: '1', name: 'Test User' });

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  test('should deny access for unauthenticated users', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => false;

    const guard = new AuthGuard(reflector);
    const context = createMockContext(false, null);

    expect(() => guard.canActivate(context)).toThrow('Authentication required');
  });
});

describe('RolesGuard', () => {
  function createMockContext(_roles: string[], user: unknown): ExecutionContext {
    return {
      getHandler: () => ({ name: 'testHandler' }),
      getClass: () => ({ name: 'TestClass' }),
      getArgs: () => [{}, {}, { user, req: { user } }, {}],
      getType: () => 'graphql',
      switchToHttp: () => ({} as unknown),
      switchToRpc: () => ({} as unknown),
      switchToWs: () => ({} as unknown),
      getArgByIndex: () => ({} as unknown),
    } as unknown as ExecutionContext;
  }

  test('should allow access when no roles required', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => null;

    const guard = new RolesGuard(reflector);
    const context = createMockContext([], { id: '1', roles: [] });

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  test('should allow access when user has required role', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => ['admin'];

    const guard = new RolesGuard(reflector);
    const context = createMockContext(['admin'], {
      id: '1',
      roles: ['admin', 'user'],
    });

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  test('should deny access when user lacks required role', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => ['admin'];

    const guard = new RolesGuard(reflector);
    const context = createMockContext(['admin'], { id: '1', roles: ['user'] });

    expect(() => guard.canActivate(context)).toThrow('Required roles: admin');
  });

  test('should deny access when user is not authenticated', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => ['admin'];

    const guard = new RolesGuard(reflector);
    const context = createMockContext(['admin'], null);

    expect(() => guard.canActivate(context)).toThrow('Authentication required');
  });
});

describe('PermissionsGuard', () => {
  function createMockContext(
    _permissions: string[],
    user: unknown
  ): ExecutionContext {
    return {
      getHandler: () => ({ name: 'testHandler' }),
      getClass: () => ({ name: 'TestClass' }),
      getArgs: () => [{}, {}, { user, req: { user } }, {}],
      getType: () => 'graphql',
      switchToHttp: () => ({} as unknown),
      switchToRpc: () => ({} as unknown),
      switchToWs: () => ({} as unknown),
      getArgByIndex: () => ({} as unknown),
    } as unknown as ExecutionContext;
  }

  test('should allow access when no permissions required', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => null;

    const guard = new PermissionsGuard(reflector);
    const context = createMockContext([], { id: '1', permissions: [] });

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  test('should allow access when user has all required permissions', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => ['user:read', 'user:write'];

    const guard = new PermissionsGuard(reflector);
    const context = createMockContext(['user:read', 'user:write'], {
      id: '1',
      permissions: ['user:read', 'user:write', 'user:delete'],
    });

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  test('should deny access when user lacks required permissions', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => ['user:read', 'user:write'];

    const guard = new PermissionsGuard(reflector);
    const context = createMockContext(['user:read', 'user:write'], {
      id: '1',
      permissions: ['user:read'],
    });

    expect(() => guard.canActivate(context)).toThrow(
      'Required permissions: user:read, user:write'
    );
  });

  test('should deny access when user is not authenticated', () => {
    const reflector = new Reflector();
    reflector.getAllAndOverride = () => ['user:read'];

    const guard = new PermissionsGuard(reflector);
    const context = createMockContext(['user:read'], null);

    expect(() => guard.canActivate(context)).toThrow('Authentication required');
  });
});

describe('ComplexityGuard', () => {
  function createMockContext(queryComplexity: number | undefined): ExecutionContext {
    return {
      getHandler: () => ({ name: 'testHandler' }),
      getClass: () => ({ name: 'TestClass' }),
      getArgs: () => [{}, {}, { _queryComplexity: queryComplexity }, {}],
      getType: () => 'graphql',
      switchToHttp: () => ({} as unknown),
      switchToRpc: () => ({} as unknown),
      switchToWs: () => ({} as unknown),
      getArgByIndex: () => ({} as unknown),
    } as unknown as ExecutionContext;
  }

  test('should allow access when complexity is within limit', () => {
    const guard = new ComplexityGuard(100);
    const context = createMockContext(50);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  test('should fail closed when complexity is missing', () => {
    const guard = new ComplexityGuard(100);
    const context = createMockContext(undefined);

    expect(() => guard.canActivate(context)).toThrow(
      'Query complexity could not be determined'
    );
  });

  test('should fail closed when complexity is not a number', () => {
    const guard = new ComplexityGuard(100);
    const context = {
      getHandler: () => ({ name: 'testHandler' }),
      getClass: () => ({ name: 'TestClass' }),
      getArgs: () => [{}, {}, { _queryComplexity: 'lots' }, {}],
      getType: () => 'graphql',
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(
      'Query complexity could not be determined'
    );
  });

  test('should reject the fail-closed sentinel recorded by the driver', () => {
    const guard = new ComplexityGuard(100);
    const context = createMockContext(Number.POSITIVE_INFINITY);

    expect(() => guard.canActivate(context)).toThrow('exceeds maximum allowed 100');
  });

  test('should allow the fail-closed sentinel when no limit is configured', () => {
    // `createLimitProviders` supplies Infinity when `maxComplexity` is unset,
    // and Infinity > Infinity is false: no limit really does mean no limit.
    const guard = new ComplexityGuard(Number.POSITIVE_INFINITY);
    const context = createMockContext(Number.POSITIVE_INFINITY);

    expect(guard.canActivate(context)).toBe(true);
  });

  test('should allow an unmeasured request when no limit is configured', () => {
    // With no limit the driver skips analysis altogether, so failing closed
    // here would reject every request for a measurement nobody asked for.
    const guard = new ComplexityGuard(Number.POSITIVE_INFINITY);
    const context = createMockContext(undefined);

    expect(guard.canActivate(context)).toBe(true);
  });

  test('should deny access when complexity exceeds limit', () => {
    const guard = new ComplexityGuard(100);
    const context = createMockContext(150);

    expect(() => guard.canActivate(context)).toThrow(
      'Query complexity 150 exceeds maximum allowed 100'
    );
  });
});

describe('DepthGuard', () => {
  function createMockContext(queryDepth: number | undefined): ExecutionContext {
    return {
      getHandler: () => ({ name: 'testHandler' }),
      getClass: () => ({ name: 'TestClass' }),
      getArgs: () => [{}, {}, { _queryDepth: queryDepth }, {}],
      getType: () => 'graphql',
      switchToHttp: () => ({} as unknown),
      switchToRpc: () => ({} as unknown),
      switchToWs: () => ({} as unknown),
      getArgByIndex: () => ({} as unknown),
    } as unknown as ExecutionContext;
  }

  test('should allow access when depth is within limit', () => {
    const guard = new DepthGuard(10);
    const context = createMockContext(5);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  test('should fail closed when depth is missing', () => {
    const guard = new DepthGuard(10);
    const context = createMockContext(undefined);

    expect(() => guard.canActivate(context)).toThrow(
      'Query depth could not be determined'
    );
  });

  test('should fail closed when depth is not a number', () => {
    const guard = new DepthGuard(10);
    const context = {
      getHandler: () => ({ name: 'testHandler' }),
      getClass: () => ({ name: 'TestClass' }),
      getArgs: () => [{}, {}, { _queryDepth: null }, {}],
      getType: () => 'graphql',
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(
      'Query depth could not be determined'
    );
  });

  test('should reject the fail-closed sentinel recorded by the driver', () => {
    const guard = new DepthGuard(10);
    const context = createMockContext(Number.POSITIVE_INFINITY);

    expect(() => guard.canActivate(context)).toThrow('exceeds maximum allowed 10');
  });

  test('should allow the fail-closed sentinel when no limit is configured', () => {
    const guard = new DepthGuard(Number.POSITIVE_INFINITY);
    const context = createMockContext(Number.POSITIVE_INFINITY);

    expect(guard.canActivate(context)).toBe(true);
  });

  test('should allow an unmeasured request when no limit is configured', () => {
    const guard = new DepthGuard(Number.POSITIVE_INFINITY);
    const context = createMockContext(undefined);

    expect(guard.canActivate(context)).toBe(true);
  });

  test('should deny access when depth exceeds limit', () => {
    const guard = new DepthGuard(10);
    const context = createMockContext(15);

    expect(() => guard.canActivate(context)).toThrow(
      'Query depth 15 exceeds maximum allowed 10'
    );
  });
});

describe('Guard integration with LeavenDriver', () => {
  /**
   * Build a NestJS-style ExecutionContext whose GraphQL context argument is
   * the real context object threaded through the driver, mirroring how Nest
   * invokes guards for GraphQL resolvers (context at args[2]).
   */
  function executionContextFor(gqlContext: unknown): ExecutionContext {
    return {
      getHandler: () => ({ name: 'testHandler' }),
      getClass: () => ({ name: 'TestClass' }),
      getArgs: () => [{}, {}, gqlContext, {}],
      getType: () => 'graphql',
      switchToHttp: () => ({} as unknown),
      switchToRpc: () => ({} as unknown),
      switchToWs: () => ({} as unknown),
      getArgByIndex: () => ({} as unknown),
    } as unknown as ExecutionContext;
  }

  function makeContext(): GqlContext {
    return {
      req: new Request('http://localhost/graphql'),
      res: new Response(),
    };
  }

  /** Schema whose `a` resolver runs the guard, as Nest would before resolving */
  function buildFlatSchema(guard: ComplexityGuard): GraphQLSchema {
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          a: {
            type: GraphQLString,
            resolve: (_source, _args, ctx) => {
              guard.canActivate(executionContextFor(ctx));
              return 'a';
            },
          },
          b: { type: GraphQLString, resolve: () => 'b' },
          c: { type: GraphQLString, resolve: () => 'c' },
        },
      }),
    });
  }

  /** Nested schema whose `parent` resolver runs the guard */
  function buildNestedSchema(guard: DepthGuard): GraphQLSchema {
    const child = new GraphQLObjectType({
      name: 'Child',
      fields: {
        leaf: { type: GraphQLString, resolve: () => 'leaf' },
      },
    });
    const parent = new GraphQLObjectType({
      name: 'Parent',
      fields: {
        child: { type: child, resolve: () => ({}) },
      },
    });
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          parent: {
            type: parent,
            resolve: (_source, _args, ctx) => {
              guard.canActivate(executionContextFor(ctx));
              return {};
            },
          },
        },
      }),
    });
  }

  test('should reject an over-limit query run through the driver with ComplexityGuard', async () => {
    const guard = new ComplexityGuard(1);
    // The module option is what makes the driver measure each request; the
    // guard's own limit is the stricter one under test, so the driver's is
    // set high enough that the executor never rejects first.
    const driver = new LeavenDriver({
      schema: buildFlatSchema(guard),
      maxComplexity: 1000,
    });
    await driver.onModuleInit();

    const request = new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ a b c }' }),
    });
    const result = await driver.handleRequest(request, new Response());

    expect(
      result.errors?.some((error) =>
        error.message.includes('Query complexity 3 exceeds maximum allowed 1')
      )
    ).toBe(true);

    await driver.onModuleDestroy();
  });

  test('should allow a query within the limit populated by the driver with ComplexityGuard', async () => {
    const guard = new ComplexityGuard(100);
    const driver = new LeavenDriver({
      schema: buildFlatSchema(guard),
      maxComplexity: 1000,
    });
    await driver.onModuleInit();

    const context = makeContext();
    const result = await driver.execute('{ a }', undefined, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ a: 'a' });
    // The driver, not the test, populated the analysis fields
    expect(typeof (context as Record<string, unknown>)._queryComplexity).toBe('number');
    expect(typeof (context as Record<string, unknown>)._queryDepth).toBe('number');

    await driver.onModuleDestroy();
  });

  test('should admit a request the driver never measured with an unlimited ComplexityGuard', async () => {
    // No `maxComplexity` option: the module would inject Infinity and the
    // driver skips analysis, so the guard must not fail closed.
    const guard = new ComplexityGuard(Number.POSITIVE_INFINITY);
    const driver = new LeavenDriver({ schema: buildFlatSchema(guard) });
    await driver.onModuleInit();

    const context = makeContext();
    const result = await driver.execute('{ a b c }', undefined, context);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ a: 'a', b: 'b', c: 'c' });
    expect((context as Record<string, unknown>)._queryComplexity).toBeUndefined();

    await driver.onModuleDestroy();
  });

  test('should reject an over-limit query run through the driver with DepthGuard', async () => {
    const guard = new DepthGuard(2);
    // As above: the option enables measurement, the guard enforces the
    // stricter limit under test.
    const driver = new LeavenDriver({
      schema: buildNestedSchema(guard),
      maxDepth: 100,
    });
    await driver.onModuleInit();

    const context = makeContext();
    const result = await driver.execute(
      '{ parent { child { leaf } } }',
      undefined,
      context
    );

    expect((context as Record<string, unknown>)._queryDepth).toBe(3);
    expect(
      result.errors?.some((error) =>
        error.message.includes('Query depth 3 exceeds maximum allowed 2')
      )
    ).toBe(true);

    await driver.onModuleDestroy();
  });

  test('should allow a query within the limit with DepthGuard', async () => {
    const guard = new DepthGuard(5);
    const driver = new LeavenDriver({
      schema: buildNestedSchema(guard),
      maxDepth: 100,
    });
    await driver.onModuleInit();

    const context = makeContext();
    const result = await driver.execute(
      '{ parent { child { leaf } } }',
      undefined,
      context
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ parent: { child: { leaf: 'leaf' } } });

    await driver.onModuleDestroy();
  });
});

describe('Metadata Keys', () => {
  test('should have correct public key', () => {
    expect(IS_PUBLIC_KEY).toBe('leaven:isPublic');
  });

  test('should have correct roles key', () => {
    expect(ROLES_KEY).toBe('leaven:roles');
  });

  test('should have correct permissions key', () => {
    expect(PERMISSIONS_KEY).toBe('leaven:permissions');
  });
});
