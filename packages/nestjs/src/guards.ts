/**
 * @leaven-graphql/nestjs - Guards
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  SetMetadata,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getGqlContext as getSharedGqlContext } from './execution-context';
import type { GqlContext } from './types';

/**
 * Metadata key for public resolvers
 */
export const IS_PUBLIC_KEY = 'leaven:isPublic';

/**
 * Metadata key for required roles
 */
export const ROLES_KEY = 'leaven:roles';

/**
 * Metadata key for required permissions
 */
export const PERMISSIONS_KEY = 'leaven:permissions';

/**
 * Injection token under which the module must provide the maximum allowed
 * query complexity (see `LeavenModuleOptions.maxComplexity`) for
 * `ComplexityGuard`.
 *
 * Overriding this provider with a finite limit while leaving
 * `LeavenModuleOptions.maxComplexity` unset rejects every request: the driver
 * measures complexity only when the *option* is set, and the guard fails
 * closed on an unmeasured request. Set the option too.
 */
export const LEAVEN_MAX_COMPLEXITY = 'LEAVEN_MAX_COMPLEXITY';

/**
 * Injection token under which the module must provide the maximum allowed
 * query depth (see `LeavenModuleOptions.maxDepth`) for `DepthGuard`.
 *
 * As with {@link LEAVEN_MAX_COMPLEXITY}, a finite override is only meaningful
 * alongside `LeavenModuleOptions.maxDepth`, which is what makes the driver
 * measure each request's depth.
 */
export const LEAVEN_MAX_DEPTH = 'LEAVEN_MAX_DEPTH';

/**
 * Mark a resolver as public (no authentication required)
 *
 * @example
 * ```typescript
 * @Query(() => String)
 * @Public()
 * async publicInfo() {
 *   return 'This is public';
 * }
 * ```
 */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Require specific roles
 *
 * @example
 * ```typescript
 * @Query(() => [User])
 * @Roles('admin', 'moderator')
 * async users() {
 *   return this.userService.findAll();
 * }
 * ```
 */
export const Roles = (...roles: string[]): ClassDecorator & MethodDecorator => SetMetadata(ROLES_KEY, roles);

/**
 * Require specific permissions
 *
 * @example
 * ```typescript
 * @Mutation(() => User)
 * @Permissions('user:write', 'user:delete')
 * async deleteUser(@Args('id') id: string) {
 *   return this.userService.delete(id);
 * }
 * ```
 */
export const Permissions = (...permissions: string[]): ClassDecorator & MethodDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Authentication guard for GraphQL resolvers
 *
 * Ensures the user is authenticated before accessing protected resolvers.
 *
 * @example
 * ```typescript
 * @UseGuards(AuthGuard)
 * @Resolver(() => User)
 * export class UserResolver {
 *   // All resolvers in this class require authentication
 * }
 * ```
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    // Check if resolver is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const gqlContext = this.getGqlContext(context);
    const user = this.extractUser(gqlContext);

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    return true;
  }

  /**
   * Get GraphQL context from execution context
   *
   * Delegates to the shared `execution-context` helper, which owns the
   * positional assumption (`GQL_RESOLVER_ARGS`) about resolver arguments.
   */
  protected getGqlContext(context: ExecutionContext): GqlContext {
    return getSharedGqlContext(context);
  }

  /**
   * Extract user from context
   * Override this method to customize user extraction
   */
  protected extractUser(context: GqlContext): unknown {
    // Try common user locations
    return (
      context.user ??
      (context.req as unknown as Record<string, unknown>)?.user ??
      null
    );
  }
}

/**
 * Role-based access guard
 *
 * Ensures the user has the required roles.
 *
 * @example
 * ```typescript
 * @UseGuards(AuthGuard, RolesGuard)
 * @Roles('admin')
 * @Resolver(() => Admin)
 * export class AdminResolver {
 *   // Only admins can access these resolvers
 * }
 * ```
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const gqlContext = this.getGqlContext(context);
    const user = this.extractUser(gqlContext);

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const userRoles = this.extractRoles(user);
    const hasRole = requiredRoles.some((role) => userRoles.includes(role));

    if (!hasRole) {
      throw new ForbiddenException(
        `Required roles: ${requiredRoles.join(', ')}`
      );
    }

    return true;
  }

  /**
   * Get GraphQL context from execution context
   *
   * Delegates to the shared `execution-context` helper, which owns the
   * positional assumption (`GQL_RESOLVER_ARGS`) about resolver arguments.
   */
  protected getGqlContext(context: ExecutionContext): GqlContext {
    return getSharedGqlContext(context);
  }

  /**
   * Extract user from context
   */
  protected extractUser(context: GqlContext): unknown {
    return (
      context.user ??
      (context.req as unknown as Record<string, unknown>)?.user ??
      null
    );
  }

  /**
   * Extract roles from user
   * Override this method to customize role extraction
   */
  protected extractRoles(user: unknown): string[] {
    const userObj = user as Record<string, unknown>;
    const roles = userObj?.roles ?? userObj?.role;

    if (Array.isArray(roles)) {
      return roles.map(String);
    }

    if (typeof roles === 'string') {
      return [roles];
    }

    return [];
  }
}

/**
 * Permission-based access guard
 *
 * Ensures the user has the required permissions.
 *
 * @example
 * ```typescript
 * @UseGuards(AuthGuard, PermissionsGuard)
 * @Permissions('posts:read', 'posts:write')
 * @Resolver(() => Post)
 * export class PostResolver {
 *   // Users need posts:read and posts:write permissions
 * }
 * ```
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()]
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const gqlContext = this.getGqlContext(context);
    const user = this.extractUser(gqlContext);

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const userPermissions = this.extractPermissions(user);
    const hasAllPermissions = requiredPermissions.every((permission) =>
      userPermissions.includes(permission)
    );

    if (!hasAllPermissions) {
      throw new ForbiddenException(
        `Required permissions: ${requiredPermissions.join(', ')}`
      );
    }

    return true;
  }

  /**
   * Get GraphQL context from execution context
   *
   * Delegates to the shared `execution-context` helper, which owns the
   * positional assumption (`GQL_RESOLVER_ARGS`) about resolver arguments.
   */
  protected getGqlContext(context: ExecutionContext): GqlContext {
    return getSharedGqlContext(context);
  }

  /**
   * Extract user from context
   */
  protected extractUser(context: GqlContext): unknown {
    return (
      context.user ??
      (context.req as unknown as Record<string, unknown>)?.user ??
      null
    );
  }

  /**
   * Extract permissions from user
   * Override this method to customize permission extraction
   */
  protected extractPermissions(user: unknown): string[] {
    const userObj = user as Record<string, unknown>;
    const permissions = userObj?.permissions ?? userObj?.scopes;

    if (Array.isArray(permissions)) {
      return permissions.map(String);
    }

    if (typeof permissions === 'string') {
      return permissions.split(' ');
    }

    return [];
  }
}

/**
 * Complexity limit guard
 *
 * Prevents queries that exceed complexity limits. `LeavenDriver` computes
 * each request's complexity before execution and records it on the request
 * context as `_queryComplexity`; this guard rejects the request when that
 * value exceeds the limit provided via the `LEAVEN_MAX_COMPLEXITY`
 * injection token.
 *
 * Whenever a finite limit is configured the guard fails **closed**: a request
 * whose complexity is missing or non-numeric — analysis never ran, or it
 * failed — is rejected rather than allowed through unmeasured.
 *
 * With no limit configured the module supplies the `Infinity` sentinel. There
 * is then nothing to enforce, and the driver does not compute
 * `_queryComplexity` at all, so the guard admits every request instead of
 * rejecting them all for a measurement nobody asked for.
 *
 * **`LeavenModule` only.** Both the `LEAVEN_MAX_COMPLEXITY` token and the
 * `_queryComplexity` value come from `LeavenModule` and its `LeavenDriver`. Under
 * `LeavenGraphQLDriver` (`GraphQLModule.forRoot({ driver: LeavenGraphQLDriver })`)
 * neither exists: the guard either fails dependency injection or, with the
 * token provided by hand, rejects every request because `_queryComplexity` is
 * never set. On that path configure the driver's `maxComplexity` option instead,
 * which the executor enforces before any resolver runs.
 *
 * NestJS enhancers do not fire for `LeavenModule`'s resolvers either, so Nest
 * never runs this guard for you on either path. Invoke it yourself (in a
 * custom pipeline or a unit test), or rely on the `maxComplexity` option, which
 * applies automatically.
 */
@Injectable()
export class ComplexityGuard implements CanActivate {
  constructor(
    @Inject(LEAVEN_MAX_COMPLEXITY) private readonly maxComplexity: number
  ) {}

  public canActivate(context: ExecutionContext): boolean {
    if (this.maxComplexity === Number.POSITIVE_INFINITY) {
      return true;
    }

    const gqlContext = getSharedGqlContext(context) as Record<string, unknown> | undefined;
    const currentComplexity = gqlContext?._queryComplexity;

    if (typeof currentComplexity !== 'number' || Number.isNaN(currentComplexity)) {
      throw new ForbiddenException(
        'Query complexity could not be determined; rejecting the request'
      );
    }

    if (currentComplexity > this.maxComplexity) {
      throw new ForbiddenException(
        `Query complexity ${currentComplexity} exceeds maximum allowed ${this.maxComplexity}`
      );
    }

    return true;
  }
}

/**
 * Depth limit guard
 *
 * Prevents queries that exceed depth limits. `LeavenDriver` computes each
 * request's depth before execution and records it on the request context as
 * `_queryDepth`; this guard rejects the request when that value exceeds the
 * limit provided via the `LEAVEN_MAX_DEPTH` injection token.
 *
 * Whenever a finite limit is configured the guard fails **closed**: a request
 * whose depth is missing or non-numeric — analysis never ran, or it failed —
 * is rejected rather than allowed through unmeasured.
 *
 * With no limit configured the module supplies the `Infinity` sentinel. There
 * is then nothing to enforce, and the driver does not compute `_queryDepth` at
 * all, so the guard admits every request instead of rejecting them all for a
 * measurement nobody asked for.
 *
 * **`LeavenModule` only.** Both the `LEAVEN_MAX_DEPTH` token and the
 * `_queryDepth` value come from `LeavenModule` and its `LeavenDriver`. Under
 * `LeavenGraphQLDriver` (`GraphQLModule.forRoot({ driver: LeavenGraphQLDriver })`)
 * neither exists: the guard either fails dependency injection or, with the
 * token provided by hand, rejects every request because `_queryDepth` is
 * never set. On that path configure the driver's `maxDepth` option instead,
 * which the executor enforces before any resolver runs.
 *
 * NestJS enhancers do not fire for `LeavenModule`'s resolvers either, so Nest
 * never runs this guard for you on either path. Invoke it yourself (in a
 * custom pipeline or a unit test), or rely on the `maxDepth` option, which
 * applies automatically.
 */
@Injectable()
export class DepthGuard implements CanActivate {
  constructor(
    @Inject(LEAVEN_MAX_DEPTH) private readonly maxDepth: number
  ) {}

  public canActivate(context: ExecutionContext): boolean {
    if (this.maxDepth === Number.POSITIVE_INFINITY) {
      return true;
    }

    const gqlContext = getSharedGqlContext(context) as Record<string, unknown> | undefined;
    const currentDepth = gqlContext?._queryDepth;

    if (typeof currentDepth !== 'number' || Number.isNaN(currentDepth)) {
      throw new ForbiddenException(
        'Query depth could not be determined; rejecting the request'
      );
    }

    if (currentDepth > this.maxDepth) {
      throw new ForbiddenException(
        `Query depth ${currentDepth} exceeds maximum allowed ${this.maxDepth}`
      );
    }

    return true;
  }
}
