/**
 * @leaven-graphql/nestjs - GraphQL Execution Context
 *
 * Provides a helper class for accessing GraphQL-specific context in guards,
 * interceptors, and other NestJS constructs.
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type { ExecutionContext, ArgumentsHost } from '@nestjs/common';
import type { GraphQLResolveInfo, SelectionSetNode } from 'graphql';
import type { GqlContext } from './types';

/**
 * Positional indices of the GraphQL resolver arguments as exposed by
 * NestJS's `ExecutionContext.getArgs()` for GraphQL invocations:
 * `[root, args, context, info]`.
 *
 * This is the single source of truth for the positional assumption shared by
 * the execution-context helpers and the param decorators. Use these named
 * indices instead of hard-coded numbers so a change in argument ordering only
 * needs to be reflected in one place.
 *
 * @internal
 */
export const GQL_RESOLVER_ARGS = {
  /** The root/parent value — 1st resolver argument */
  ROOT: 0,
  /** The resolver arguments object — 2nd resolver argument */
  ARGS: 1,
  /** The GraphQL context object — 3rd resolver argument */
  CONTEXT: 2,
  /** The `GraphQLResolveInfo` object — 4th resolver argument */
  INFO: 3,
} as const;

/**
 * GraphQL execution context helper
 *
 * Provides easy access to GraphQL resolver arguments from NestJS execution context.
 *
 * Despite the shared name, this is **not** `@nestjs/graphql`'s
 * `GqlExecutionContext` and is not itself an `ExecutionContext` or
 * `ArgumentsHost`: it cannot be passed where Nest expects one, and has no
 * `switchToHttp()` / `switchToRpc()` / `switchToWs()` / `getArgByIndex()`. It
 * is a read-only helper over the positional resolver arguments (see
 * {@link GQL_RESOLVER_ARGS}) — `getRoot()`, `getArgs()`, `getContext()`,
 * `getInfo()` and a few conveniences — with `getHost()` returning the
 * original context for anything else.
 *
 * @example
 * ```typescript
 * @Injectable()
 * export class AuthGuard implements CanActivate {
 *   canActivate(context: ExecutionContext): boolean {
 *     const gqlContext = GqlExecutionContext.create(context);
 *     const ctx = gqlContext.getContext();
 *     const args = gqlContext.getArgs();
 *     const info = gqlContext.getInfo();
 *
 *     return !!ctx.user;
 *   }
 * }
 * ```
 */
export class GqlExecutionContext {
  private readonly args: unknown[];

  private constructor(private readonly host: ArgumentsHost) {
    this.args = host.getArgs();
  }

  /**
   * Create a GqlExecutionContext from an ExecutionContext
   */
  public static create(context: ExecutionContext): GqlExecutionContext {
    return new GqlExecutionContext(context);
  }

  /**
   * Get the GraphQL context object
   *
   * The context is the third argument in GraphQL resolvers:
   * (root, args, context, info)
   */
  public getContext<T = GqlContext>(): T {
    return this.args[GQL_RESOLVER_ARGS.CONTEXT] as T;
  }

  /**
   * Get the root/parent value
   *
   * The root is the first argument in GraphQL resolvers:
   * (root, args, context, info)
   */
  public getRoot<T = unknown>(): T {
    return this.args[GQL_RESOLVER_ARGS.ROOT] as T;
  }

  /**
   * Get the resolver arguments
   *
   * The args is the second argument in GraphQL resolvers:
   * (root, args, context, info)
   */
  public getArgs<T = Record<string, unknown>>(): T {
    return this.args[GQL_RESOLVER_ARGS.ARGS] as T;
  }

  /**
   * Get the GraphQL resolve info
   *
   * The info is the fourth argument in GraphQL resolvers:
   * (root, args, context, info)
   */
  public getInfo<T = GraphQLResolveInfo>(): T {
    return this.args[GQL_RESOLVER_ARGS.INFO] as T;
  }

  /**
   * Get a specific argument by name
   */
  public getArg<T = unknown>(name: string): T | undefined {
    const args = this.getArgs<Record<string, unknown>>();
    return args[name] as T | undefined;
  }

  /**
   * Get a specific context property by name
   */
  public getContextProperty<T = unknown>(name: string): T | undefined {
    const ctx = this.getContext<Record<string, unknown>>();
    return ctx[name] as T | undefined;
  }

  /**
   * Get the underlying ArgumentsHost
   */
  public getHost(): ArgumentsHost {
    return this.host;
  }

  /**
   * Get the type of the execution context
   * For GraphQL resolvers, this typically returns 'graphql'
   */
  public getType(): string {
    return (this.host as ExecutionContext).getType?.() ?? 'unknown';
  }

  /**
   * Check if this is a GraphQL context
   */
  public isGraphQL(): boolean {
    return this.getType() === 'graphql';
  }

  /**
   * Get the handler (method) being executed
   */
  public getHandler(): Function | undefined {
    return (this.host as ExecutionContext).getHandler?.();
  }

  /**
   * Get the class containing the handler
   */
  public getClass(): Function | undefined {
    return (this.host as ExecutionContext).getClass?.();
  }

  /**
   * Get the field name being resolved
   */
  public getFieldName(): string | undefined {
    const info = this.getInfo<GraphQLResolveInfo>();
    return info?.fieldName;
  }

  /**
   * Get the parent type name
   */
  public getParentTypeName(): string | undefined {
    const info = this.getInfo<GraphQLResolveInfo>();
    return info?.parentType?.name;
  }

  /**
   * Get the return type name
   */
  public getReturnTypeName(): string | undefined {
    const info = this.getInfo<GraphQLResolveInfo>();
    return info?.returnType?.toString();
  }

  /**
   * Get the operation name from the query
   */
  public getOperationName(): string | undefined {
    const info = this.getInfo<GraphQLResolveInfo>();
    return info?.operation?.name?.value;
  }

  /**
   * Get the operation type (query, mutation, subscription)
   */
  public getOperationType(): 'query' | 'mutation' | 'subscription' | undefined {
    const info = this.getInfo<GraphQLResolveInfo>();
    return info?.operation?.operation;
  }

  /**
   * Get the variable values from the operation
   */
  public getVariables<T = Record<string, unknown>>(): T {
    const info = this.getInfo<GraphQLResolveInfo>();
    return (info?.variableValues ?? {}) as T;
  }

  /**
   * Get the field-name path to the current field
   *
   * List indices are omitted, so `users[3].email` yields
   * `['users', 'email']` — the same value this method has always returned,
   * which keeps `getPath().join('.')` stable as a metric label, log key, or
   * cache key.
   *
   * @deprecated Use {@link getFullPath}, which preserves list indices and so
   * identifies an individual element rather than a field position.
   */
  public getPath(): string[] {
    return this.getFullPath().filter(
      (segment): segment is string => typeof segment === 'string'
    );
  }

  /**
   * Get the full path to the current field
   *
   * Every path segment is included: field names as strings and list indices
   * as numbers, so `users[3].email` yields `['users', 3, 'email']` and list
   * positions remain distinguishable from field names.
   */
  public getFullPath(): Array<string | number> {
    const info = this.getInfo<GraphQLResolveInfo>();
    if (!info?.path) return [];

    const path: Array<string | number> = [];
    let current: GraphQLResolveInfo['path'] | undefined = info.path;

    while (current) {
      path.unshift(current.key);
      current = current.prev;
    }

    return path;
  }

  /**
   * Get the requested fields (first level)
   *
   * Resolves fragment spreads (via `info.fragments`) and inline fragments,
   * and merges the selections of every field node for the current field, so
   * fields hidden behind `...SomeFragment` or `... on Type { ... }` are
   * reported. Fragment cycles are tolerated. Returned names are the schema
   * field names (not client aliases), deduplicated.
   */
  public getSelectedFields(): string[] {
    const info = this.getInfo<GraphQLResolveInfo>();
    if (!info?.fieldNodes?.length) return [];

    const fields = new Set<string>();
    const visitedFragments = new Set<string>();

    const collect = (selectionSet: SelectionSetNode | undefined): void => {
      if (!selectionSet?.selections) return;

      for (const selection of selectionSet.selections) {
        if (selection.kind === 'Field') {
          fields.add(selection.name.value);
        } else if (selection.kind === 'InlineFragment') {
          collect(selection.selectionSet);
        } else if (selection.kind === 'FragmentSpread') {
          const fragmentName = selection.name.value;
          if (visitedFragments.has(fragmentName)) continue;
          visitedFragments.add(fragmentName);
          collect(info.fragments?.[fragmentName]?.selectionSet);
        }
      }
    };

    for (const fieldNode of info.fieldNodes) {
      collect(fieldNode?.selectionSet);
    }

    return [...fields];
  }
}

/**
 * Per-host cache so repeated helper calls (e.g. a guard calling
 * `getGqlContext` then `getGqlArgs`) reuse one `GqlExecutionContext`
 * instead of constructing a throwaway instance per call. Keyed weakly on the
 * `ExecutionContext`, which NestJS creates per invocation, so entries are
 * released with the request and never observed across invocations.
 */
const executionContextCache = new WeakMap<ExecutionContext, GqlExecutionContext>();

function getCachedGqlExecutionContext(context: ExecutionContext): GqlExecutionContext {
  let gqlContext = executionContextCache.get(context);
  if (!gqlContext) {
    gqlContext = GqlExecutionContext.create(context);
    executionContextCache.set(context, gqlContext);
  }
  return gqlContext;
}

/**
 * Helper function to extract GraphQL context from execution context
 */
export function getGqlContext<T = GqlContext>(context: ExecutionContext): T {
  return getCachedGqlExecutionContext(context).getContext<T>();
}

/**
 * Helper function to extract GraphQL args from execution context
 */
export function getGqlArgs<T = Record<string, unknown>>(context: ExecutionContext): T {
  return getCachedGqlExecutionContext(context).getArgs<T>();
}

/**
 * Helper function to extract GraphQL info from execution context
 */
export function getGqlInfo<T = GraphQLResolveInfo>(context: ExecutionContext): T {
  return getCachedGqlExecutionContext(context).getInfo<T>();
}

/**
 * Helper function to extract GraphQL root from execution context
 */
export function getGqlRoot<T = unknown>(context: ExecutionContext): T {
  return getCachedGqlExecutionContext(context).getRoot<T>();
}
