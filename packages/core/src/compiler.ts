/**
 * @leaven-graphql/core - Query compilation and static analysis
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import type {
  DocumentNode,
  GraphQLSchema,
  OperationDefinitionNode,
  FieldNode,
  SelectionSetNode,
  FragmentDefinitionNode,
} from 'graphql';
import { Kind, getOperationAST } from 'graphql';

import { createVisitBudget } from './parser';
import type { OperationType, Variables } from './types';
import { escapeLog } from './escape-log';

/**
 * Options for query compilation
 */
export interface CompilerOptions {
  /** Enable query complexity calculation */
  calculateComplexity?: boolean;
  /** Custom complexity calculator */
  complexityCalculator?: (field: FieldNode, depth: number) => number;
}

/**
 * A compiled GraphQL query: the static analysis of a single operation
 * (operation metadata, field tree, variable requirements, and an optional
 * complexity score). Execution itself is performed by the executor via
 * graphql-js; this class does not execute queries.
 *
 * Named fragment spreads are NOT inlined into the field tree. Each fragment
 * is compiled exactly once into {@link CompiledQuery.fragments} and referred
 * to by name from {@link CompiledField.fragmentSpreads}. Inlining would make
 * both the compiled tree and the complexity score exponential in the number
 * of fragments — `fragment F1 { ...F2 ...F2 }` chained N deep expands 2^N
 * times — which is a cheap denial-of-service vector because compilation runs
 * on unauthenticated input.
 */
export class CompiledQuery<_TData = Record<string, unknown>> {
  public readonly document: DocumentNode;
  public readonly schema: GraphQLSchema;
  public readonly operationType: OperationType;
  public readonly operationName: string | null;
  public readonly complexity: number;
  public readonly requiredVariables: string[];
  public readonly optionalVariables: string[];
  /** Fields selected directly by the operation (fragments are not inlined) */
  public readonly fields: CompiledField[];
  /** Names of fragments spread directly by the operation's selection set */
  public readonly fragmentSpreads: string[];
  /** Every fragment defined by the document, each compiled exactly once */
  public readonly fragments: ReadonlyMap<string, CompiledFragment>;

  constructor(
    schema: GraphQLSchema,
    document: DocumentNode,
    operationName?: string,
    options?: CompilerOptions
  ) {
    this.schema = schema;
    this.document = document;

    const operation = getOperationAST(document, operationName);
    if (!operation) {
      throw new Error(
        operationName
          ? `Operation "${escapeLog(operationName)}" not found`
          : 'No operation found in document'
      );
    }

    this.operationType = operation.operation as OperationType;
    this.operationName = operation.name?.value ?? null;

    // Extract variable definitions
    const { required, optional } = this.extractVariables(operation);
    this.requiredVariables = required;
    this.optionalVariables = optional;

    // Compile every fragment once, then the operation's own selection set
    this.fragments = this.compileFragments(document);
    const root = this.compileSelectionSet(operation.selectionSet, 0, createVisitBudget());
    this.fields = root.fields;
    this.fragmentSpreads = root.fragmentSpreads;

    // Calculate complexity
    this.complexity = options?.calculateComplexity
      ? this.calculateComplexity(options.complexityCalculator)
      : 0;
  }

  /**
   * Compile every fragment definition in the document exactly once.
   *
   * A fragment's fields are compiled relative to the fragment itself (its
   * top-level fields are at depth 0), because the same compiled fragment is
   * shared by every site that spreads it.
   */
  private compileFragments(document: DocumentNode): Map<string, CompiledFragment> {
    const compiled = new Map<string, CompiledFragment>();
    const countVisit = createVisitBudget();

    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        const fragment = definition as FragmentDefinitionNode;
        const { fields, fragmentSpreads } = this.compileSelectionSet(
          fragment.selectionSet,
          0,
          countVisit
        );
        compiled.set(fragment.name.value, {
          name: fragment.name.value,
          typeCondition: fragment.typeCondition.name.value,
          fields,
          fragmentSpreads,
        });
      }
    }

    return compiled;
  }

  /**
   * Extract variable definitions from an operation
   */
  private extractVariables(operation: OperationDefinitionNode): {
    required: string[];
    optional: string[];
  } {
    const required: string[] = [];
    const optional: string[] = [];

    if (operation.variableDefinitions) {
      for (const varDef of operation.variableDefinitions) {
        const name = varDef.variable.name.value;
        const isRequired =
          varDef.type.kind === Kind.NON_NULL_TYPE && !varDef.defaultValue;

        if (isRequired) {
          required.push(name);
        } else {
          optional.push(name);
        }
      }
    }

    return { required, optional };
  }

  /**
   * Compile a selection set.
   *
   * Inline fragments are flattened into the enclosing selection (they cannot
   * recurse, so this stays bounded by document size). Named fragment spreads
   * are recorded by name only — see the class doc for why they are never
   * inlined.
   */
  private compileSelectionSet(
    selectionSet: SelectionSetNode,
    depth: number,
    countVisit: () => void
  ): { fields: CompiledField[]; fragmentSpreads: string[] } {
    const fields: CompiledField[] = [];
    const fragmentSpreads: string[] = [];

    for (const selection of selectionSet.selections) {
      countVisit();

      switch (selection.kind) {
        case Kind.FIELD:
          fields.push(this.compileField(selection, depth, countVisit));
          break;
        case Kind.INLINE_FRAGMENT:
          if (selection.selectionSet) {
            const inlined = this.compileSelectionSet(
              selection.selectionSet,
              depth,
              countVisit
            );
            fields.push(...inlined.fields);
            fragmentSpreads.push(...inlined.fragmentSpreads);
          }
          break;
        case Kind.FRAGMENT_SPREAD:
          fragmentSpreads.push(selection.name.value);
          break;
      }
    }

    return { fields, fragmentSpreads };
  }

  /**
   * Compile a single field
   */
  private compileField(
    field: FieldNode,
    depth: number,
    countVisit: () => void
  ): CompiledField {
    const selection = field.selectionSet
      ? this.compileSelectionSet(field.selectionSet, depth + 1, countVisit)
      : { fields: [], fragmentSpreads: [] };

    const compiled: CompiledField = {
      name: field.name.value,
      alias: field.alias?.value ?? null,
      depth,
      arguments: this.extractArguments(field),
      children: selection.fields,
      fragmentSpreads: selection.fragmentSpreads,
      node: field,
    };

    return compiled;
  }

  /**
   * Extract arguments from a field
   */
  private extractArguments(field: FieldNode): Record<string, unknown> {
    const args: Record<string, unknown> = {};

    if (field.arguments) {
      for (const arg of field.arguments) {
        args[arg.name.value] = this.extractValue(arg.value);
      }
    }

    return args;
  }

  /**
   * Extract a value from an AST node
   */
  private extractValue(node: { kind: string; value?: unknown; values?: readonly unknown[]; fields?: ReadonlyArray<{ name: { value: string }; value: unknown }> }): unknown {
    switch (node.kind) {
      case Kind.VARIABLE:
        return { __variable: (node as unknown as { name: { value: string } }).name.value };
      case Kind.INT:
        return parseInt(node.value as string, 10);
      case Kind.FLOAT:
        return parseFloat(node.value as string);
      case Kind.STRING:
      case Kind.BOOLEAN:
      case Kind.ENUM:
        return node.value;
      case Kind.NULL:
        return null;
      case Kind.LIST:
        return (node.values ?? []).map((v) => this.extractValue(v as { kind: string; value?: unknown; values?: readonly unknown[] }));
      case Kind.OBJECT: {
        const obj: Record<string, unknown> = {};
        for (const field of node.fields ?? []) {
          obj[field.name.value] = this.extractValue(field.value as { kind: string; value?: unknown; values?: unknown[] });
        }
        return obj;
      }
      default:
        return undefined;
    }
  }

  /**
   * Calculate query complexity.
   *
   * Fragments are scored once per (fragment, depth) pair and the result is
   * memoised, so a fragment spread twice at the same depth is scored once
   * rather than expanded twice. Without this a chain of N fragments each
   * spreading the next twice costs O(2^N).
   *
   * Cyclic spreads contribute nothing on re-entry, matching the termination
   * behaviour of `calculateQueryDepth`. A score computed with such a cut in it
   * is a lower bound specific to that expansion path, so it is deliberately
   * NOT memoised — sharing it would make the reported complexity depend on the
   * order the operation's root fields happen to appear in. Cyclic documents
   * therefore fall back to re-expansion, bounded by the visit budget, and are
   * rejected by graphql-js validation moments later anyway.
   */
  private calculateComplexity(
    calculator?: (field: FieldNode, depth: number) => number
  ): number {
    const countVisit = createVisitBudget();
    const memo = new Map<string, number>();
    const expanding = new Set<string>();
    /** Spreads cut so far by cycle detection; see the doc comment above */
    let cycleCuts = 0;

    const scoreFields = (fields: readonly CompiledField[], depth: number): number => {
      let total = 0;

      for (const field of fields) {
        countVisit();

        // Use the custom calculator when one is provided and the originating
        // AST node is available; otherwise default to 1 + (depth * 0.5).
        total +=
          calculator && field.node
            ? calculator(field.node, depth)
            : 1 + depth * 0.5;

        if (field.children.length > 0 || field.fragmentSpreads.length > 0) {
          total += scoreSelection(field.children, field.fragmentSpreads, depth + 1);
        }
      }

      return total;
    };

    const scoreFragment = (fragmentName: string, depth: number): number => {
      // Complexity is depth-dependent, so memoise per (fragment, depth) pair.
      // The number of distinct depths is bounded by the document's nesting.
      const key = `${fragmentName}@${depth}`;
      const memoized = memo.get(key);
      if (memoized !== undefined) return memoized;

      // Cyclic fragment spread; contribute nothing to guarantee termination.
      if (expanding.has(fragmentName)) {
        cycleCuts++;
        return 0;
      }

      const fragment = this.fragments.get(fragmentName);
      if (!fragment) return 0;

      expanding.add(fragmentName);
      const cutsBefore = cycleCuts;
      const score = scoreSelection(fragment.fields, fragment.fragmentSpreads, depth);
      expanding.delete(fragmentName);

      // Only memoise a score nothing was cut out of — see the doc comment.
      if (cycleCuts === cutsBefore) {
        memo.set(key, score);
      }
      return score;
    };

    function scoreSelection(
      fields: readonly CompiledField[],
      fragmentSpreads: readonly string[],
      depth: number
    ): number {
      let total = scoreFields(fields, depth);
      for (const fragmentName of fragmentSpreads) {
        total += scoreFragment(fragmentName, depth);
      }
      return total;
    }

    return scoreSelection(this.fields, this.fragmentSpreads, 0);
  }

  /**
   * Validate variables against requirements
   */
  public validateVariables(variables?: Variables): { valid: boolean; missing: string[] } {
    const missing: string[] = [];

    for (const required of this.requiredVariables) {
      if (
        variables === undefined ||
        variables[required] === undefined ||
        variables[required] === null
      ) {
        missing.push(required);
      }
    }

    return {
      valid: missing.length === 0,
      missing,
    };
  }

  /**
   * Get the distinct names of every field the operation can select,
   * including fields reached through fragment spreads.
   *
   * Names are de-duplicated: a fragment is walked at most once, so the result
   * stays linear in document size instead of exploding with the number of
   * spread sites.
   */
  public getFieldNames(): string[] {
    const countVisit = createVisitBudget();
    const names = new Set<string>();
    const seenFragments = new Set<string>();

    const collect = (
      fields: readonly CompiledField[],
      fragmentSpreads: readonly string[]
    ): void => {
      for (const field of fields) {
        countVisit();
        names.add(field.name);
        collect(field.children, field.fragmentSpreads);
      }

      for (const fragmentName of fragmentSpreads) {
        if (seenFragments.has(fragmentName)) continue;
        seenFragments.add(fragmentName);

        const fragment = this.fragments.get(fragmentName);
        if (fragment) {
          collect(fragment.fields, fragment.fragmentSpreads);
        }
      }
    };

    collect(this.fields, this.fragmentSpreads);
    return [...names];
  }
}

/**
 * A compiled fragment definition: the fragment's own selection set, compiled
 * exactly once and shared by every site that spreads it.
 */
export interface CompiledFragment {
  /** Fragment name */
  name: string;
  /** The type the fragment applies to */
  typeCondition: string;
  /**
   * Fields declared directly by the fragment. Their `depth` is relative to
   * the fragment (top-level fields are at depth 0), because the compiled
   * fragment is shared across spread sites at different depths.
   */
  fields: CompiledField[];
  /** Names of fragments this fragment spreads */
  fragmentSpreads: string[];
}

/**
 * A compiled field
 */
export interface CompiledField {
  /** Field name */
  name: string;
  /** Field alias or null */
  alias: string | null;
  /** Depth in the query */
  depth: number;
  /** Field arguments */
  arguments: Record<string, unknown>;
  /** Child fields selected directly (fragment spreads are not inlined) */
  children: CompiledField[];
  /**
   * Names of fragments spread inside this field's selection set. Resolve
   * them through {@link CompiledQuery.fragments}.
   */
  fragmentSpreads: string[];
  /** Originating AST node, used by custom complexity calculators */
  node?: FieldNode;
}

/**
 * Compile a GraphQL query
 */
export function compileQuery<TData = Record<string, unknown>>(
  schema: GraphQLSchema,
  document: DocumentNode,
  operationName?: string,
  options?: CompilerOptions
): CompiledQuery<TData> {
  return new CompiledQuery<TData>(schema, document, operationName, options);
}
