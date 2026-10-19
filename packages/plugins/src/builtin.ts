/**
 * @leaven-graphql/plugins - Built-in plugins
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import { Kind, getOperationAST } from 'graphql';
import type { DocumentNode, OperationDefinitionNode } from 'graphql';
import { ComplexityError, DepthLimitError } from '@leaven-graphql/errors';
import type { GraphQLResponse } from '@leaven-graphql/core';
import type { Plugin, PluginContext, PluginHooks, PluginMetadata } from './types';

/**
 * Create a custom plugin
 */
export function createPlugin(
  metadata: PluginMetadata,
  hooks: PluginHooks
): Plugin {
  return {
    metadata,
    ...hooks,
  };
}

/**
 * Compose multiple plugins into one
 */
export function composePlugins(name: string, ...plugins: Plugin[]): Plugin {
  // Computed once at composition time; `afterExecute` runs in reverse order,
  // mirroring PluginManager, without per-request array allocations.
  const reversed = [...plugins].reverse();

  // `satisfies Required<PluginHooks>` forces this composite to delegate EVERY
  // hook declared in PluginHooks — adding a new hook to the interface without
  // delegating it here becomes a compile error instead of a silent drop.
  const hooks = {
    async beforeParse(query, context) {
      let result = query;
      for (const plugin of plugins) {
        if (plugin.beforeParse) {
          const modified = await plugin.beforeParse(result, context);
          if (typeof modified === 'string') {
            result = modified;
          }
        }
      }
      return result;
    },

    async afterParse(document, context) {
      let result = document;
      for (const plugin of plugins) {
        if (plugin.afterParse) {
          const modified = await plugin.afterParse(result, context);
          if (modified) {
            result = modified;
          }
        }
      }
      return result;
    },

    async beforeValidate(document, context) {
      for (const plugin of plugins) {
        await plugin.beforeValidate?.(document, context);
      }
    },

    async afterValidate(result, context) {
      for (const plugin of plugins) {
        await plugin.afterValidate?.(result, context);
      }
    },

    async beforeExecute(document, context) {
      for (const plugin of plugins) {
        const response = await plugin.beforeExecute?.(document, context);
        if (response) {
          // Propagate a short-circuit response from an inner plugin.
          return response;
        }
      }

      return undefined;
    },

    async afterExecute(response, context) {
      let result = response;
      for (const plugin of reversed) {
        if (plugin.afterExecute) {
          const modified = await plugin.afterExecute(result, context);
          if (modified) {
            result = modified;
          }
        }
      }
      return result;
    },

    async onError(error, context) {
      let result = error;
      for (const plugin of plugins) {
        if (plugin.onError) {
          const modified = await plugin.onError(result, context);
          if (modified instanceof Error) {
            result = modified;
          }
        }
      }
      return result;
    },
  } satisfies Required<PluginHooks>;

  return {
    metadata: {
      name,
      description: `Composed plugin from: ${plugins.map((p) => p.metadata.name).join(', ')}`,
    },

    async onRegister(schema) {
      for (const plugin of plugins) {
        await plugin.onRegister?.(schema);
      }
    },

    async onUnregister() {
      for (const plugin of plugins) {
        await plugin.onUnregister?.();
      }
    },

    ...hooks,
  };
}

/**
 * Create a caching plugin
 *
 * Caches successful responses keyed by query, operation name, and variables.
 * On a cache hit, `beforeExecute` returns the cached response, which
 * `PluginManager.beforeExecute` surfaces to its caller so execution can be
 * skipped entirely. Pipelines that ignore that return value still receive the
 * cached response, because `afterExecute` substitutes it for the freshly
 * executed result.
 *
 * A cache hit skips execution entirely, so resolvers — and any field-level
 * authorization they perform — do not run. Caller identity must therefore be
 * part of the cache key, and the plugin refuses to be constructed unless that
 * choice is explicit: supply a `keyFn` that incorporates the identity, or set
 * `allowSharedCache: true` to opt in to a cache shared by every caller (safe
 * only for data that is identical for everyone, e.g. fully public content).
 */
export function createCachingPlugin(options?: {
  /** Maximum cache size */
  maxSize?: number;
  /** Cache TTL in milliseconds */
  ttl?: number;
  /**
   * Derives the cache key for a request. Use this to incorporate user or
   * tenant identity (e.g. from `context.context`) so cached responses are
   * not shared across callers.
   */
  keyFn?: (context: PluginContext) => string;
  /**
   * Opt in to a cache keyed only by query, operation name, and variables —
   * with NO caller identity, so any caller may be served any other caller's
   * response. Required when no `keyFn` is supplied.
   */
  allowSharedCache?: boolean;
}): Plugin {
  const cache = new Map<string, { data: GraphQLResponse; expires: number }>();
  const maxSize = options?.maxSize ?? 100;
  const ttl = options?.ttl ?? 60000;
  const keyFn = options?.keyFn;

  if (!keyFn && options?.allowSharedCache !== true) {
    throw new TypeError(
      'createCachingPlugin requires an explicit cache-identity decision: pass a ' +
        '`keyFn` that incorporates the caller identity (recommended), or set ' +
        '`allowSharedCache: true` to serve one cached response to every caller. ' +
        'A cache hit skips execution, so without caller identity in the key one ' +
        "user can receive another user's response."
    );
  }

  const makeKey = (context: PluginContext): string =>
    keyFn
      ? keyFn(context)
      : JSON.stringify({
          query: context.request.query,
          operationName: context.request.operationName ?? null,
          variables: context.request.variables ?? null,
        });

  return {
    metadata: {
      name: 'caching',
      version: '1.0.0',
      description:
        'Caches successful query responses and serves them on subsequent requests',
    },

    async beforeExecute(document, context) {
      // Only queries are cacheable: a mutation has side effects and must run
      // every time, and a subscription is a stream.
      const operation = getOperationAST(
        document,
        context.request.operationName ?? undefined
      );
      if (operation?.operation !== 'query') {
        context.state.set('cacheSkip', true);
        return;
      }

      const key = makeKey(context);
      context.state.set('cacheKey', key);

      const cached = cache.get(key);
      if (!cached) {
        return;
      }

      // Reap expired entries on read
      if (cached.expires <= Date.now()) {
        cache.delete(key);
        return;
      }

      // Touch the entry (delete + re-insert) so eviction is least-recently-used
      cache.delete(key);
      cache.set(key, cached);

      context.state.set('cacheHit', true);
      context.state.set('cachedResponse', cached.data);

      // Short-circuit: PluginManager.beforeExecute surfaces this response so
      // the caller can skip execution.
      return cached.data;
    },

    async afterExecute(response, context) {
      if (context.state.get('cacheSkip')) {
        return response;
      }

      if (context.state.get('cacheHit')) {
        return context.state.get('cachedResponse') as typeof response;
      }

      // Don't cache errors
      if (response.errors && response.errors.length > 0) {
        return response;
      }

      // Only store what this plugin's own beforeExecute cleared as a query. If
      // an earlier plugin short-circuited, that hook never ran, the operation
      // type is unchecked, and a mutation's response must not take a slot.
      const key = context.state.get('cacheKey') as string | undefined;
      if (key === undefined) {
        return response;
      }
      const now = Date.now();

      // No full sweep here: it would cost O(maxSize) on every response.
      // `beforeExecute` already reaps each expired entry on read, and the LRU
      // eviction below bounds the map at `maxSize` regardless of expiry, so a
      // sweep buys nothing for correctness.

      // Evict least-recently-used entries if at max size. Overwriting a key
      // that is already present does not grow the map, so no eviction is
      // needed for it — evicting anyway would discard a live entry for nothing.
      while (!cache.has(key) && cache.size >= maxSize) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) break;
        cache.delete(oldestKey);
      }

      cache.set(key, {
        data: response,
        expires: now + ttl,
      });

      return response;
    },
  };
}

/** Numeric severity ranks for log levels, hoisted so no per-call allocation occurs. */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

type LogLevel = keyof typeof LOG_LEVELS;

/**
 * Create a logging plugin
 */
export function createLoggingPlugin(options?: {
  /** Log level */
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Custom logger */
  logger?: {
    debug: (msg: string, data?: unknown) => void;
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
}): Plugin {
  const logger = options?.logger ?? console;
  const level = options?.level ?? 'info';

  // The threshold is fixed at construction; compare precomputed numbers.
  const threshold = LOG_LEVELS[level];
  const shouldLog = (msgLevel: LogLevel): boolean =>
    LOG_LEVELS[msgLevel] >= threshold;

  return {
    metadata: {
      name: 'logging',
      version: '1.0.0',
      description: 'Logs GraphQL operations',
    },

    async beforeExecute(document, context) {
      context.state.set('startTime', performance.now());

      if (shouldLog('debug')) {
        logger.debug('Executing GraphQL operation', {
          operationName: context.request.operationName,
          query: context.request.query,
        });
      }
    },

    async afterExecute(response, context) {
      const startTime = context.state.get('startTime') as number | undefined;
      // beforeExecute may not have run (another plugin short-circuited), in
      // which case there is no start time and the duration is unknown.
      const duration =
        startTime === undefined
          ? 'unknown'
          : `${(performance.now() - startTime).toFixed(2)}ms`;

      if (response.errors && response.errors.length > 0) {
        if (shouldLog('error')) {
          logger.error('GraphQL operation completed with errors', {
            operationName: context.request.operationName,
            duration,
            errors: response.errors,
          });
        }
      } else {
        if (shouldLog('info')) {
          logger.info('GraphQL operation completed', {
            operationName: context.request.operationName,
            duration,
          });
        }
      }

      return response;
    },

    async onError(error, context) {
      if (shouldLog('error')) {
        logger.error('GraphQL operation failed', {
          operationName: context.request.operationName,
          error: error.message,
        });
      }
      return error;
    },
  };
}

/** Internal per-request state accumulated by the tracing plugin. */
interface TraceState {
  startTime: string;
  startNs: number;
  parsingStartNs?: number;
  parsing?: { startOffset: number; duration: number };
  validationStartNs?: number;
  validation?: { startOffset: number; duration: number };
  executionStartNs?: number;
}

/**
 * Create a tracing plugin
 *
 * Emits Apollo Tracing-shaped data (nanosecond offsets/durations) in
 * `extensions.tracing`. Parsing, validation, and execution phases are each
 * measured by their own hooks; a phase whose hooks did not run in the request
 * pipeline is omitted from the output rather than reported as a false zero.
 */
export function createTracingPlugin(): Plugin {
  const TRACE_KEY = 'tracing';

  const ensureTrace = (context: PluginContext): TraceState => {
    let trace = context.state.get(TRACE_KEY) as TraceState | undefined;
    if (!trace) {
      trace = {
        startTime: new Date().toISOString(),
        startNs: Bun.nanoseconds(),
      };
      context.state.set(TRACE_KEY, trace);
    }
    return trace;
  };

  return {
    metadata: {
      name: 'tracing',
      version: '1.0.0',
      description: 'Adds tracing information to responses',
    },

    async beforeParse(_query, context) {
      const trace = ensureTrace(context);
      trace.parsingStartNs = Bun.nanoseconds();
    },

    async afterParse(document, context) {
      const trace = ensureTrace(context);
      if (trace.parsingStartNs !== undefined) {
        trace.parsing = {
          startOffset: trace.parsingStartNs - trace.startNs,
          duration: Bun.nanoseconds() - trace.parsingStartNs,
        };
      }
      return document;
    },

    async beforeValidate(_document, context) {
      const trace = ensureTrace(context);
      trace.validationStartNs = Bun.nanoseconds();
    },

    async afterValidate(_result, context) {
      const trace = ensureTrace(context);
      if (trace.validationStartNs !== undefined) {
        trace.validation = {
          startOffset: trace.validationStartNs - trace.startNs,
          duration: Bun.nanoseconds() - trace.validationStartNs,
        };
      }
    },

    async beforeExecute(_document, context) {
      const trace = ensureTrace(context);
      trace.executionStartNs = Bun.nanoseconds();
    },

    async afterExecute(response, context) {
      const trace = context.state.get(TRACE_KEY) as TraceState | undefined;

      if (!trace) return response;

      const endNs = Bun.nanoseconds();
      const duration = endNs - trace.startNs;

      const tracing: Record<string, unknown> = {
        version: 1,
        startTime: trace.startTime,
        endTime: new Date().toISOString(),
        duration,
      };

      if (trace.parsing) {
        tracing['parsing'] = trace.parsing;
      }
      if (trace.validation) {
        tracing['validation'] = trace.validation;
      }
      if (trace.executionStartNs !== undefined) {
        tracing['execution'] = {
          startOffset: trace.executionStartNs - trace.startNs,
          duration: endNs - trace.executionStartNs,
        };
      }

      return {
        ...response,
        extensions: {
          ...response.extensions,
          tracing,
        },
      };
    },
  };
}

/** Minimal structural view of the AST nodes the depth/complexity walkers visit. */
interface WalkerNode {
  kind?: string;
  name?: { value: string };
  selectionSet?: { selections: unknown[] };
}

/**
 * Hard cap on the AST nodes a single depth or complexity analysis may visit.
 *
 * Fragment memoization already makes the common case linear in document size,
 * but a document can still be enormous on its own. The budget makes such a
 * document fail fast with a normal GraphQL error instead of blocking the event
 * loop for an unbounded amount of time.
 */
const MAX_WALKER_VISITS = 100_000;

/** Mutable visit counter shared by every walk over a single document. */
interface VisitBudget {
  visits: number;
}

/**
 * Build a map of fragment name to fragment definition from a document's
 * definitions, so fragment spreads can be resolved during AST walks.
 */
function collectFragments(definitions: readonly unknown[]): Map<string, unknown> {
  const fragments = new Map<string, unknown>();
  for (const definition of definitions) {
    const typed = definition as WalkerNode;
    if (typed.kind === Kind.FRAGMENT_DEFINITION && typed.name) {
      fragments.set(typed.name.value, definition);
    }
  }
  return fragments;
}

/** Per-document state for a depth walk. */
interface DepthWalker {
  /** Fragment name to fragment definition, for resolving spreads. */
  fragments: Map<string, unknown>;
  /**
   * Memoized depth each fragment contributes BELOW its spread site. A
   * fragment's contribution does not depend on where it is spread, so it is
   * computed once per document and reused; a fragment spread many times (or
   * spread twice per level down a chain) therefore costs linear, not
   * exponential, work.
   */
  fragmentDepths: Map<string, number>;
  /** Fragments currently being measured, so cyclic spreads terminate. */
  inProgress: Set<string>;
  budget: VisitBudget;
  /** Configured limit, used to build the error when the budget is exhausted. */
  limit: number;
}

/**
 * Depth a fragment adds below its spread site, computed at most once per
 * document. A spread of a fragment that is already being measured (a cycle)
 * contributes nothing, which terminates recursive fragments.
 */
function fragmentDepthContribution(walker: DepthWalker, name: string): number {
  const memoized = walker.fragmentDepths.get(name);
  if (memoized !== undefined) {
    return memoized;
  }

  const fragment = walker.fragments.get(name);
  if (!fragment || walker.inProgress.has(name)) {
    return 0;
  }

  walker.inProgress.add(name);
  const contribution = walkDepth(walker, fragment, 0);
  walker.inProgress.delete(name);
  walker.fragmentDepths.set(name, contribution);

  return contribution;
}

/**
 * Deepest field nesting reachable from `node`, where `currentDepth` is the
 * depth of `node`'s parent field.
 *
 * Only fields add a level; inline fragments, fragment definitions, and
 * operation definitions are traversed at the current depth. Siblings are each
 * measured from the SAME starting depth — only the running maximum varies — so
 * breadth is never mistaken for depth.
 */
function walkDepth(
  walker: DepthWalker,
  node: unknown,
  currentDepth: number
): number {
  if (!node || typeof node !== 'object') return currentDepth;

  if (++walker.budget.visits > MAX_WALKER_VISITS) {
    throw new DepthLimitError(walker.limit + 1, walker.limit, {
      extensions: {
        reason: 'ANALYSIS_BUDGET_EXCEEDED',
        maxNodesVisited: MAX_WALKER_VISITS,
      },
    });
  }

  const typedNode = node as WalkerNode;

  if (typedNode.kind === Kind.FRAGMENT_SPREAD) {
    const fragmentName = typedNode.name?.value;
    if (fragmentName === undefined) {
      return currentDepth;
    }
    return currentDepth + fragmentDepthContribution(walker, fragmentName);
  }

  const childDepth =
    typedNode.kind === Kind.FIELD ? currentDepth + 1 : currentDepth;
  let maxFoundDepth = childDepth;

  if (typedNode.selectionSet) {
    for (const selection of typedNode.selectionSet.selections) {
      const depth = walkDepth(walker, selection, childDepth);
      if (depth > maxFoundDepth) {
        maxFoundDepth = depth;
      }
    }
  }

  return maxFoundDepth;
}

/**
 * Create a depth limit plugin
 *
 * Accepts either the bare number form `createDepthLimitPlugin(10)` or the
 * options-object form `createDepthLimitPlugin({ maxDepth: 10 })`. Only field
 * selections add a level of depth, matching `calculateQueryDepth` in
 * `@leaven-graphql/core`. Fragment spreads are resolved through their
 * definitions and each fragment is measured once per document, so a document
 * that spreads fragments repeatedly cannot fan out exponentially; recursive
 * fragments are detected and terminated after one unrolling.
 *
 * Throws {@link DepthLimitError} (HTTP 400, `extensions.code: 'DEPTH_LIMIT'`)
 * when a query exceeds the configured depth, or when analyzing the document
 * would exceed the node budget (`extensions.reason:
 * 'ANALYSIS_BUDGET_EXCEEDED'`).
 */
export function createDepthLimitPlugin(
  maxDepth: number | { maxDepth: number }
): Plugin {
  const limit = typeof maxDepth === 'number' ? maxDepth : maxDepth?.maxDepth;

  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new TypeError(
      `createDepthLimitPlugin requires a finite numeric maxDepth; received ${JSON.stringify(maxDepth)}. ` +
        'Pass a number or an object of the form { maxDepth: number }.'
    );
  }

  return {
    metadata: {
      name: 'depth-limit',
      version: '1.0.0',
      description: `Limits query depth to ${limit}`,
    },

    async afterParse(document, _context) {
      const walker: DepthWalker = {
        fragments: collectFragments(document.definitions),
        fragmentDepths: new Map(),
        inProgress: new Set(),
        budget: { visits: 0 },
        limit,
      };

      // No operation selection: every operation is measured and the deepest
      // one wins.
      let depth = 0;

      for (const definition of document.definitions) {
        if ((definition as { kind: string }).kind === Kind.OPERATION_DEFINITION) {
          const opDepth = walkDepth(walker, definition, 0);
          if (opDepth > depth) {
            depth = opDepth;
          }
        }
      }

      if (depth > limit) {
        throw new DepthLimitError(depth, limit);
      }

      return document;
    },
  };
}

/**
 * Operations a request is scored against: the single operation named by
 * `operationName` when exactly one matches, otherwise every operation in the
 * document (no name, or a name matching zero or several operations).
 */
function selectOperations(
  document: DocumentNode,
  operationName: string | null | undefined
): OperationDefinitionNode[] {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION
  );
  if (operationName === undefined || operationName === null) {
    return operations;
  }
  const matching = operations.filter((op) => op.name?.value === operationName);
  return matching.length === 1 ? matching : operations;
}

/** Arguments whose value is treated as a page size that multiplies cost. */
const LIST_SIZE_ARGUMENTS = new Set(['first', 'last', 'limit']);

/** Shared empty map for operations that declare no variables. */
const NO_VARIABLE_DEFAULTS: ReadonlyMap<string, number> = new Map();

/** Minimal structural view of an argument or variable-default value node. */
interface ValueNodeLike {
  kind?: string;
  value?: unknown;
  name?: { value: string };
}

/**
 * Coerce a candidate page size to a usable multiplier.
 *
 * Only finite, positive values are usable: a negative or zero page size would
 * cancel out — or invert — the rest of the score, letting an expensive query
 * slip under the limit. Anything else is rejected so the caller can fall back.
 */
function toPositiveMultiplier(raw: unknown): number | undefined {
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw)
        : Number.NaN;

  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

/** Positive numeric defaults declared by an operation's variable definitions. */
function collectVariableDefaults(
  operation: unknown
): ReadonlyMap<string, number> {
  const definitions = (
    operation as {
      variableDefinitions?: Array<{
        variable?: { name?: { value: string } };
        defaultValue?: ValueNodeLike;
      }>;
    }
  ).variableDefinitions;

  if (!definitions || definitions.length === 0) {
    return NO_VARIABLE_DEFAULTS;
  }

  const defaults = new Map<string, number>();
  for (const definition of definitions) {
    const name = definition.variable?.name?.value;
    const defaultValue = definition.defaultValue;
    if (name === undefined || !defaultValue) continue;
    if (defaultValue.kind !== Kind.INT && defaultValue.kind !== Kind.FLOAT) {
      continue;
    }
    const numeric = toPositiveMultiplier(defaultValue.value);
    if (numeric !== undefined) {
      defaults.set(name, numeric);
    }
  }

  return defaults;
}

/** Per-operation state for a complexity walk. */
interface ComplexityWalker {
  fragments: Map<string, unknown>;
  /**
   * Memoized complexity of each fragment. A fragment scores the same wherever
   * it is spread, so it is computed once; a fragment spread repeatedly costs
   * linear, not exponential, work.
   */
  fragmentComplexities: Map<string, number>;
  /** Fragments currently being scored, so cyclic spreads terminate. */
  inProgress: Set<string>;
  budget: VisitBudget;
  maxComplexity: number;
  defaultComplexity: number;
  calculator: ((node: unknown, childComplexity: number) => number) | undefined;
  /** Variables supplied with the request, for resolving page-size arguments. */
  variables: Record<string, unknown> | undefined;
  /** Defaults declared by the operation being scored. */
  variableDefaults: ReadonlyMap<string, number>;
  /** Assumed page size when an argument's value cannot be determined. */
  unknownMultiplier: number;
}

/**
 * Resolve a `first`/`last`/`limit` argument to a cost multiplier.
 *
 * Complexity analysis runs on the parsed document BEFORE schema validation, so
 * nothing has type-checked the argument yet: a literal is trusted only when it
 * is a finite positive number. Variables are resolved against the request's
 * variables, then the operation's declared default, and finally the configured
 * worst case — never a fixed small constant, which would let a client-supplied
 * page size escape scoring entirely.
 *
 * Returns `undefined` when the argument carries no usable page size, leaving
 * the field's multiplier unchanged.
 */
function resolveListSizeMultiplier(
  walker: ComplexityWalker,
  value: ValueNodeLike
): number | undefined {
  if (value.kind === Kind.INT || value.kind === Kind.FLOAT) {
    return toPositiveMultiplier(value.value);
  }

  if (value.kind === Kind.VARIABLE) {
    const name = value.name?.value;
    if (name !== undefined) {
      const supplied = walker.variables?.[name];
      if (supplied !== undefined) {
        const fromRequest = toPositiveMultiplier(supplied);
        if (fromRequest !== undefined) {
          return fromRequest;
        }
      }

      const declaredDefault = walker.variableDefaults.get(name);
      if (declaredDefault !== undefined) {
        return declaredDefault;
      }
    }

    return walker.unknownMultiplier;
  }

  return undefined;
}

/** Complexity a fragment contributes, computed at most once per operation. */
function fragmentComplexityContribution(
  walker: ComplexityWalker,
  name: string
): number {
  const memoized = walker.fragmentComplexities.get(name);
  if (memoized !== undefined) {
    return memoized;
  }

  const fragment = walker.fragments.get(name);
  if (!fragment || walker.inProgress.has(name)) {
    return 0;
  }

  walker.inProgress.add(name);
  const contribution = walkComplexity(walker, fragment);
  walker.inProgress.delete(name);
  walker.fragmentComplexities.set(name, contribution);

  return contribution;
}

/** Accumulated complexity of `node` and everything it selects. */
function walkComplexity(walker: ComplexityWalker, node: unknown): number {
  if (!node || typeof node !== 'object') return 0;

  if (++walker.budget.visits > MAX_WALKER_VISITS) {
    throw new ComplexityError(walker.maxComplexity + 1, walker.maxComplexity, {
      extensions: {
        reason: 'ANALYSIS_BUDGET_EXCEEDED',
        maxNodesVisited: MAX_WALKER_VISITS,
      },
    });
  }

  const typedNode = node as WalkerNode & {
    arguments?: Array<{ name: { value: string }; value: ValueNodeLike }>;
  };

  if (typedNode.kind === Kind.FRAGMENT_SPREAD) {
    const fragmentName = typedNode.name?.value;
    if (fragmentName === undefined) {
      return 0;
    }
    return fragmentComplexityContribution(walker, fragmentName);
  }

  let childComplexity = 0;

  if (typedNode.selectionSet) {
    for (const selection of typedNode.selectionSet.selections) {
      childComplexity += walkComplexity(walker, selection);
    }
  }

  if (typedNode.kind === Kind.FIELD) {
    if (walker.calculator) {
      return walker.calculator(node, childComplexity);
    }

    let multiplier = 1;
    if (typedNode.arguments) {
      for (const arg of typedNode.arguments) {
        if (!LIST_SIZE_ARGUMENTS.has(arg.name.value)) continue;
        const resolved = resolveListSizeMultiplier(walker, arg.value);
        if (resolved !== undefined) {
          multiplier = resolved;
        }
      }
    }

    // Nesting compounds: requesting N of this field also requests its whole
    // selection set N times, so the children are multiplied too.
    return (walker.defaultComplexity + childComplexity) * multiplier;
  }

  return childComplexity;
}

/**
 * Create a complexity plugin
 *
 * A field scores `defaultComplexity` plus its children, and the whole subtree
 * is multiplied by any `first`/`last`/`limit` page size — literal or variable.
 * Fragment spreads are resolved through their definitions and each fragment is
 * scored once per operation, so repeated spreads cannot fan out exponentially;
 * recursive fragments are detected and terminated.
 *
 * Throws {@link ComplexityError} (HTTP 400,
 * `extensions.code: 'COMPLEXITY_LIMIT'`) when a query exceeds the configured
 * complexity, or when analyzing the document would exceed the node budget
 * (`extensions.reason: 'ANALYSIS_BUDGET_EXCEEDED'`).
 *
 * The operation `operationName` selects is scored; without a unique match (no
 * name, or a name matching zero or several operations), the most complex
 * operation is. Every operation shares one analysis budget.
 */
export function createComplexityPlugin(options: {
  /** Maximum allowed complexity */
  maxComplexity: number;
  /** Default field complexity */
  defaultComplexity?: number;
  /**
   * Page size assumed for a `first`/`last`/`limit` argument whose value cannot
   * be determined from the document — a variable the request did not supply
   * that also declares no default. Deliberately pessimistic: the value is
   * client-controlled, so assuming a small page size would let an unbounded
   * request score as a cheap one. Defaults to 100.
   */
  unknownMultiplier?: number;
  /**
   * Custom complexity calculator, invoked for each field node with the
   * accumulated complexity of its children. Its return value is used as the
   * field's TOTAL complexity (so incorporate `childComplexity` as desired).
   * When omitted, a field scores `defaultComplexity` plus its children's
   * complexity, all multiplied by any `first`/`last`/`limit` argument.
   */
  calculator?: (
    node: unknown,
    childComplexity: number
  ) => number;
}): Plugin {
  const {
    maxComplexity,
    defaultComplexity = 1,
    unknownMultiplier = 100,
    calculator,
  } = options;

  return {
    metadata: {
      name: 'complexity',
      version: '1.0.0',
      description: `Limits query complexity to ${maxComplexity}`,
    },

    async afterParse(document, context) {
      const fragments = collectFragments(document.definitions);
      // Shared across operations so one document cannot buy extra budget by
      // splitting the work across many operation definitions.
      const budget: VisitBudget = { visits: 0 };
      // Score only the operation the request selects. With no usable
      // selection, fall back to the max across all operations. (The depth
      // plugin does no selection: it always takes the max over every
      // operation.)
      const selected = selectOperations(
        document,
        context.request.operationName
      );
      let totalComplexity = 0;

      for (const definition of selected) {
        // Variable defaults are per-operation, and fragment scores depend on
        // them, so each operation gets its own memo table.
        const walker: ComplexityWalker = {
          fragments,
          fragmentComplexities: new Map(),
          inProgress: new Set(),
          budget,
          maxComplexity,
          defaultComplexity,
          calculator,
          variables: context.request.variables,
          variableDefaults: collectVariableDefaults(definition),
          unknownMultiplier,
        };

        totalComplexity = Math.max(
          totalComplexity,
          walkComplexity(walker, definition)
        );
      }

      context.state.set('complexity', totalComplexity);

      if (totalComplexity > maxComplexity) {
        throw new ComplexityError(totalComplexity, maxComplexity);
      }

      return document;
    },
  };
}
