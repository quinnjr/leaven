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
  /** Maximum query depth allowed */
  maxDepth?: number;
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

    // Validate query depth if specified
    if (options?.maxDepth !== undefined) {
      const depth = calculateQueryDepth(document);
      if (depth > options.maxDepth) {
        // DepthLimitError owns the message, the ErrorCode and the
        // `depth`/`maxDepth` extensions, and carries a 400 statusCode for the
        // HTTP layer — a hand-rolled GraphQLError with a literal code string
        // has none of that.
        throw new DepthLimitError(depth, options.maxDepth).toGraphQLError();
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
 * Calculate the depth of a GraphQL query
 *
 * Only field selections add a level of depth. Fragment spreads are resolved
 * against the document's fragment definitions and traversed at the current
 * depth, and inline fragments are traversed at the current depth, matching
 * GraphQL response-shape semantics. Cyclic fragment spreads are detected and
 * terminated rather than recursing indefinitely.
 *
 * A fragment's contribution is independent of where it is spread — spreading
 * it at depth D simply shifts every field inside it by D — so each fragment
 * is expanded at most once and its relative depth is memoised. Re-expanding
 * per spread site would cost O(2^N) for a document of N fragments each
 * spreading the next twice, which is a trivially cheap denial-of-service
 * vector because this analysis runs before validation.
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
export function calculateQueryDepth(document: DocumentNode): number {
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

  /** Memoised relative depth of each fragment, measured from depth 0 */
  const fragmentDepths = new Map<string, number>();
  /** Fragments currently being expanded, used to cut cycles */
  const expanding = new Set<string>();
  /**
   * Number of spreads cut so far by cycle detection. Compared before and
   * after a fragment's expansion to tell a complete value (safe to memoise)
   * from a truncated one (path-specific, must not be shared).
   */
  let cycleCuts = 0;
  const countVisit = createVisitBudget();

  /**
   * Maximum depth reached inside a single selection, or NO_DEPTH when the
   * selection contains no field.
   */
  function selectionDepth(node: unknown, currentDepth: number): number {
    countVisit();

    if (!node || typeof node !== 'object') return NO_DEPTH;

    const typedNode = node as {
      kind?: string;
      name?: { value: string };
      selectionSet?: { selections: readonly unknown[] };
    };

    if (typedNode.kind === Kind.FIELD) {
      let deepest = currentDepth;
      if (typedNode.selectionSet) {
        for (const selection of typedNode.selectionSet.selections) {
          deepest = Math.max(deepest, selectionDepth(selection, currentDepth + 1));
        }
      }
      return deepest;
    }

    if (typedNode.kind === Kind.INLINE_FRAGMENT) {
      // Inline fragments do not add a level of depth
      let deepest = NO_DEPTH;
      if (typedNode.selectionSet) {
        for (const selection of typedNode.selectionSet.selections) {
          deepest = Math.max(deepest, selectionDepth(selection, currentDepth));
        }
      }
      return deepest;
    }

    if (typedNode.kind === Kind.FRAGMENT_SPREAD && typedNode.name) {
      const relative = fragmentDepth(typedNode.name.value);
      return relative === NO_DEPTH ? NO_DEPTH : currentDepth + relative;
    }

    return NO_DEPTH;
  }

  /**
   * Relative depth added by a fragment, computed once per document unless a
   * cycle forces re-expansion (see {@link calculateQueryDepth}).
   */
  function fragmentDepth(fragmentName: string): number {
    const memoized = fragmentDepths.get(fragmentName);
    if (memoized !== undefined) return memoized;

    // Stop on cycles so cyclic fragments terminate instead of overflowing
    if (expanding.has(fragmentName)) {
      cycleCuts++;
      return NO_DEPTH;
    }

    const fragment = fragments.get(fragmentName);
    if (!fragment?.selectionSet) return NO_DEPTH;

    expanding.add(fragmentName);
    const cutsBefore = cycleCuts;
    let deepest = NO_DEPTH;
    for (const selection of fragment.selectionSet.selections) {
      deepest = Math.max(deepest, selectionDepth(selection, 0));
    }
    expanding.delete(fragmentName);

    // Only memoise a value nothing was cut out of. A truncated value is a
    // lower bound for THIS expansion path; reusing it at another spread site
    // makes the reported depth depend on root-field order.
    if (cycleCuts === cutsBefore) {
      fragmentDepths.set(fragmentName, deepest);
    }
    return deepest;
  }

  let maxDepth = 0;
  for (const definition of document.definitions) {
    if ((definition as { kind: string }).kind === Kind.OPERATION_DEFINITION) {
      const opDef = definition as { selectionSet?: { selections: unknown[] } };
      if (opDef.selectionSet) {
        for (const selection of opDef.selectionSet.selections) {
          maxDepth = Math.max(maxDepth, selectionDepth(selection, 1));
        }
      }
    }
  }

  return maxDepth;
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
