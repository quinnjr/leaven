/**
 * @leaven-graphql/core - GraphQL parsing and validation
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  parse,
  validate,
  type DocumentNode,
  type GraphQLSchema,
  GraphQLError,
  type ParseOptions as GraphQLParseOptions,
  getOperationAST,
  Kind,
} from 'graphql';

import { DepthLimitError, ErrorCode } from '@leaven-graphql/errors';

import type { OperationType, ParsedRequest, GraphQLRequest } from './types';
import { escapeLog } from './escape-log';

/**
 * Hard upper bound on the number of AST nodes a single static-analysis pass
 * may visit.
 *
 * Fragment results are memoised, so analysis is linear in document size for
 * every well-formed document; this budget is a backstop that turns any
 * remaining pathological input into a rejected request instead of an
 * unbounded CPU/memory burn. It is deliberately far above anything a real
 * query reaches.
 */
export const MAX_ANALYSIS_VISITS = 100_000;

/**
 * Create a visit counter for one static-analysis pass.
 *
 * The returned function must be called once per visited AST node and throws
 * once {@link MAX_ANALYSIS_VISITS} is exceeded, so a pathological document
 * fails fast instead of exhausting CPU or memory.
 */
export function createVisitBudget(): () => void {
  let visits = 0;
  return (): void => {
    if (++visits > MAX_ANALYSIS_VISITS) {
      throw new GraphQLError(
        `Query analysis exceeded the maximum of ${MAX_ANALYSIS_VISITS} nodes`,
        { extensions: { code: ErrorCode.COMPLEXITY_LIMIT } }
      );
    }
  };
}

/**
 * Options for parsing GraphQL documents
 */
export interface ParseOptions {
  /** GraphQL parse options */
  graphqlOptions?: GraphQLParseOptions;
  /**
   * Maximum query depth allowed.
   *
   * Without {@link ParseOptions.maxIntrospectionDepth}, every selection
   * counts against it, introspection included.
   */
  maxDepth?: number;
  /**
   * Maximum depth allowed for introspection selections.
   *
   * When set, a path that enters the introspection meta-fields `__schema` or
   * `__type` at an operation's root (directly, or through root-level inline
   * fragments and fragment spreads) counts against this limit instead of
   * {@link ParseOptions.maxDepth}, so a client like GraphiQL can send
   * graphql-js's `getIntrospectionQuery()` (depth 15) while ordinary queries
   * stay under a tighter `maxDepth`. Introspection depth is still bounded:
   * deep `__type { ofType { ofType ... } } }` nesting is a known DoS vector.
   * `__typename`, and a meta-field below the root, count as ordinary fields.
   *
   * When unset, introspection counts against `maxDepth`, as it always has.
   */
  maxIntrospectionDepth?: number;
  /** Maximum number of tokens allowed */
  maxTokens?: number;
}

/**
 * Result of document validation
 */
export interface ValidationResult {
  /** Whether the document is valid */
  valid: boolean;
  /** Validation errors if invalid */
  errors: readonly GraphQLError[];
  /** Warnings that don't prevent execution */
  warnings?: readonly GraphQLError[];
}

/**
 * Parse a GraphQL query string into a document node
 */
export function parseDocument(query: string, options?: ParseOptions): DocumentNode {
  const parseOptions: GraphQLParseOptions = {
    noLocation: false,
    ...options?.graphqlOptions,
  };

  // The dedicated maxTokens option takes precedence over graphqlOptions
  if (options?.maxTokens !== undefined) {
    parseOptions.maxTokens = options.maxTokens;
  }

  try {
    const document = parse(query, parseOptions);

    // Validate query depth if specified. DepthLimitError owns the message,
    // the ErrorCode and the `depth`/`maxDepth` extensions, and carries a 400
    // statusCode for the HTTP layer — a hand-rolled GraphQLError with a
    // literal code string has none of that.
    const maxDepth = options?.maxDepth;
    const maxIntrospectionDepth = options?.maxIntrospectionDepth;
    if (maxIntrospectionDepth !== undefined) {
      // Two limits: `extensions.limit` says which one was exceeded
      const { depth, introspectionDepth } = calculateQueryDepths(document);
      if (maxDepth !== undefined && depth > maxDepth) {
        throw new DepthLimitError(depth, maxDepth, {
          extensions: { limit: 'maxDepth' },
        }).toGraphQLError();
      }
      if (introspectionDepth > maxIntrospectionDepth) {
        throw new DepthLimitError(introspectionDepth, maxIntrospectionDepth, {
          extensions: { limit: 'maxIntrospectionDepth' },
        }).toGraphQLError();
      }
    } else if (maxDepth !== undefined) {
      const depth = calculateQueryDepth(document);
      if (depth > maxDepth) {
        throw new DepthLimitError(depth, maxDepth).toGraphQLError();
      }
    }

    return document;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Failed to parse GraphQL query');
  }
}

/**
 * Validate a GraphQL document against a schema
 */
export function validateDocument(
  schema: GraphQLSchema,
  document: DocumentNode,
  options?: { rules?: readonly unknown[] }
): ValidationResult {
  const errors = validate(schema, document, options?.rules as undefined);

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Sentinel returned by the depth helpers for a selection that contributes no
 * field of its own (an empty inline fragment, an unresolvable spread, or a
 * spread cut off by cycle detection). It is below every real depth, so it is
 * absorbed by the surrounding `Math.max`.
 */
const NO_DEPTH = -1;

/**
 * Depth of a document, split by whether a path is introspection.
 */
export interface QueryDepths {
  /** Deepest path that does not enter introspection (0 when there is none) */
  depth: number;
  /**
   * Deepest path that enters `__schema` or `__type` at an operation root
   * (0 when there is none)
   */
  introspectionDepth: number;
}

/**
 * How a selection set is being analysed: at an operation's root (where the
 * introspection meta-fields live), below an ordinary field, or below
 * `__schema`/`__type`. A fragment's depth can depend on it, so fragments are
 * memoised per mode.
 */
const MODE_ROOT = 0;
const MODE_NESTED = 1;
const MODE_INTROSPECTION = 2;
type DepthMode = typeof MODE_ROOT | typeof MODE_NESTED | typeof MODE_INTROSPECTION;

/** The introspection meta-fields that open an introspection path */
const INTROSPECTION_ROOT_FIELDS: ReadonlySet<string> = new Set(['__schema', '__type']);

/**
 * Deepest regular and introspection depth inside one selection, each
 * NO_DEPTH when the selection reaches no field of that kind.
 */
interface DepthPair {
  regular: number;
  introspection: number;
}

/**
 * Calculate the depth of a GraphQL query
 *
 * The deepest path of the document, introspection included; see
 * {@link calculateQueryDepths} for the traversal. Equal to
 * `Math.max(depth, introspectionDepth)` of that function.
 *
 * @throws {GraphQLError} with `extensions.code = 'COMPLEXITY_LIMIT'` when the
 * traversal exceeds {@link MAX_ANALYSIS_VISITS} nodes.
 */
export function calculateQueryDepth(document: DocumentNode): number {
  const { depth, introspectionDepth } = calculateQueryDepths(document);
  return Math.max(depth, introspectionDepth);
}

/**
 * Calculate the depth of a GraphQL query, reporting introspection paths
 * separately.
 *
 * Only field selections add a level of depth. Fragment spreads are resolved
 * against the document's fragment definitions and traversed at the current
 * depth, and inline fragments are traversed at the current depth, matching
 * GraphQL response-shape semantics. Cyclic fragment spreads are detected and
 * terminated rather than recursing indefinitely.
 *
 * A path is an introspection path once it enters `__schema` or `__type` at an
 * operation's root, directly or through root-level inline fragments and
 * spreads; every field below it counts towards `introspectionDepth`. Those
 * meta-fields exist only on the query root, so one below the root is an
 * ordinary field (and is rejected by validation later), as is `__typename`.
 *
 * A fragment's contribution is independent of where it is spread — spreading
 * it at depth D simply shifts every field inside it by D — so each fragment
 * is expanded at most once per mode (root, nested, introspection) and its
 * relative depths are memoised. Re-expanding per spread site would cost
 * O(2^N) for a document of N fragments each spreading the next twice, which
 * is a trivially cheap denial-of-service vector because this analysis runs
 * before validation. The mode is part of the memo key because the same
 * fragment can contribute introspection depth at the root and regular depth
 * elsewhere.
 *
 * That equivalence only holds for a value computed with no cycle cut in it: a
 * fragment expanded from inside a cycle yields a truncated lower bound that is
 * specific to that expansion path, so such values are deliberately NOT
 * memoised. Otherwise the reported depth would depend on the order the root
 * fields happen to appear in. Cyclic documents therefore fall back to
 * re-expansion, bounded by {@link MAX_ANALYSIS_VISITS}, and are rejected by
 * graphql-js validation moments later anyway.
 *
 * @throws {GraphQLError} with `extensions.code = 'COMPLEXITY_LIMIT'` when the
 * traversal exceeds {@link MAX_ANALYSIS_VISITS} nodes.
 */
export function calculateQueryDepths(document: DocumentNode): QueryDepths {
  // Map of fragment name -> fragment definition, for resolving spreads
  const fragments = new Map<
    string,
    { selectionSet?: { selections: readonly unknown[] } }
  >();
  for (const definition of document.definitions) {
    if ((definition as { kind: string }).kind === Kind.FRAGMENT_DEFINITION) {
      const fragDef = definition as {
        name: { value: string };
        selectionSet?: { selections: readonly unknown[] };
      };
      fragments.set(fragDef.name.value, fragDef);
    }
  }

  /** Memoised relative depths of each fragment, measured from depth 0, per mode */
  const fragmentDepths: [Map<string, DepthPair>, Map<string, DepthPair>, Map<string, DepthPair>] =
    [new Map(), new Map(), new Map()];
  /** Fragments currently being expanded in each mode, used to cut cycles */
  const expanding: [Set<string>, Set<string>, Set<string>] = [new Set(), new Set(), new Set()];
  /**
   * Number of spreads cut so far by cycle detection. Compared before and
   * after a fragment's expansion to tell a complete value (safe to memoise)
   * from a truncated one (path-specific, must not be shared).
   */
  let cycleCuts = 0;
  const countVisit = createVisitBudget();
  const none = (): DepthPair => ({ regular: NO_DEPTH, introspection: NO_DEPTH });

  /** Fold `child` into `into`, keeping the deeper value of each kind */
  function absorb(into: DepthPair, child: DepthPair): void {
    if (child.regular > into.regular) into.regular = child.regular;
    if (child.introspection > into.introspection) into.introspection = child.introspection;
  }

  /**
   * Maximum depths reached inside a single selection.
   */
  function selectionDepth(node: unknown, currentDepth: number, mode: DepthMode): DepthPair {
    countVisit();

    if (!node || typeof node !== 'object') return none();

    const typedNode = node as {
      kind?: string;
      name?: { value: string };
      selectionSet?: { selections: readonly unknown[] };
    };

    if (typedNode.kind === Kind.FIELD) {
      const fieldMode: DepthMode =
        mode === MODE_INTROSPECTION ||
        (mode === MODE_ROOT && INTROSPECTION_ROOT_FIELDS.has(typedNode.name?.value ?? ''))
          ? MODE_INTROSPECTION
          : MODE_NESTED;
      const deepest: DepthPair =
        fieldMode === MODE_INTROSPECTION
          ? { regular: NO_DEPTH, introspection: currentDepth }
          : { regular: currentDepth, introspection: NO_DEPTH };
      if (typedNode.selectionSet) {
        for (const selection of typedNode.selectionSet.selections) {
          absorb(deepest, selectionDepth(selection, currentDepth + 1, fieldMode));
        }
      }
      return deepest;
    }

    if (typedNode.kind === Kind.INLINE_FRAGMENT) {
      // Inline fragments do not add a level of depth, nor change the mode
      const deepest = none();
      if (typedNode.selectionSet) {
        for (const selection of typedNode.selectionSet.selections) {
          absorb(deepest, selectionDepth(selection, currentDepth, mode));
        }
      }
      return deepest;
    }

    if (typedNode.kind === Kind.FRAGMENT_SPREAD && typedNode.name) {
      const relative = fragmentDepth(typedNode.name.value, mode);
      return {
        regular: relative.regular === NO_DEPTH ? NO_DEPTH : currentDepth + relative.regular,
        introspection:
          relative.introspection === NO_DEPTH ? NO_DEPTH : currentDepth + relative.introspection,
      };
    }

    return none();
  }

  /**
   * Relative depths added by a fragment spread in `mode`, computed once per
   * document and mode unless a cycle forces re-expansion (see
   * {@link calculateQueryDepths}).
   */
  function fragmentDepth(fragmentName: string, mode: DepthMode): DepthPair {
    const memoized = fragmentDepths[mode].get(fragmentName);
    if (memoized !== undefined) return memoized;

    // Stop on cycles so cyclic fragments terminate instead of overflowing
    if (expanding[mode].has(fragmentName)) {
      cycleCuts++;
      return none();
    }

    const fragment = fragments.get(fragmentName);
    if (!fragment?.selectionSet) return none();

    expanding[mode].add(fragmentName);
    const cutsBefore = cycleCuts;
    const deepest = none();
    for (const selection of fragment.selectionSet.selections) {
      absorb(deepest, selectionDepth(selection, 0, mode));
    }
    expanding[mode].delete(fragmentName);

    // Only memoise a value nothing was cut out of. A truncated value is a
    // lower bound for THIS expansion path; reusing it at another spread site
    // makes the reported depth depend on root-field order.
    if (cycleCuts === cutsBefore) {
      fragmentDepths[mode].set(fragmentName, deepest);
    }
    return deepest;
  }

  const total: DepthPair = { regular: 0, introspection: 0 };
  for (const definition of document.definitions) {
    if ((definition as { kind: string }).kind === Kind.OPERATION_DEFINITION) {
      const opDef = definition as { selectionSet?: { selections: unknown[] } };
      if (opDef.selectionSet) {
        for (const selection of opDef.selectionSet.selections) {
          absorb(total, selectionDepth(selection, 1, MODE_ROOT));
        }
      }
    }
  }

  return { depth: total.regular, introspectionDepth: total.introspection };
}

/**
 * Extract operation type from a document
 */
export function getOperationType(
  document: DocumentNode,
  operationName?: string
): OperationType | null {
  const operation = getOperationAST(document, operationName);
  if (!operation) return null;

  return operation.operation as OperationType;
}

/**
 * Parse and extract full request information
 */
export function parseRequest(
  request: GraphQLRequest,
  options?: ParseOptions
): ParsedRequest {
  const document = parseDocument(request.query, options);
  const operation = getOperationAST(document, request.operationName);

  if (!operation) {
    throw new Error(
      request.operationName
        ? `Operation "${escapeLog(request.operationName)}" not found in document`
        : 'No operation found in document'
    );
  }

  return {
    ...request,
    document,
    operation,
    operationType: operation.operation as OperationType,
  };
}

/**
 * Count the number of fields in a document
 */
export function countFields(document: DocumentNode): number {
  let count = 0;

  function traverse(node: unknown): void {
    if (!node || typeof node !== 'object') return;

    const typedNode = node as { kind?: string; selectionSet?: { selections: unknown[] } };

    if (typedNode.kind === Kind.FIELD) {
      count++;
    }

    if (typedNode.selectionSet) {
      for (const selection of typedNode.selectionSet.selections) {
        traverse(selection);
      }
    }
  }

  for (const definition of document.definitions) {
    traverse(definition);
  }

  return count;
}

/**
 * Get all operation names from a document
 */
export function getOperationNames(document: DocumentNode): string[] {
  const names: string[] = [];

  for (const definition of document.definitions) {
    if ((definition as { kind: string }).kind === Kind.OPERATION_DEFINITION) {
      const opDef = definition as { name?: { value: string } };
      if (opDef.name) {
        names.push(opDef.name.value);
      }
    }
  }

  return names;
}
