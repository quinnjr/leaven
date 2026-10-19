/**
 * @leaven-graphql/schema - Schema merging utilities
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  GraphQLSchema,
  printSchema,
  parse,
  buildASTSchema,
  Kind,
  isObjectType,
  isInterfaceType,
  isUnionType,
  isScalarType,
  isSpecifiedScalarType,
  visit,
  print,
  OperationTypeNode,
  type ConstDirectiveNode,
  type DefinitionNode,
  type DocumentNode,
  type GraphQLFieldMap,
  type GraphQLScalarType,
  type InputObjectTypeDefinitionNode,
  type InterfaceTypeDefinitionNode,
  type NamedTypeNode,
  type ObjectTypeDefinitionNode,
  type SchemaDefinitionNode,
  type SchemaExtensionNode,
  type StringValueNode,
} from 'graphql';

import type { Resolvers } from './resolvers';

/**
 * Options for schema merging.
 */
export interface MergeOptions {
  /**
   * How to resolve duplicate definitions of the same name.
   *
   * {@link mergeSchemasFromStrings} resolves whole type definitions, because
   * SDL can express additive composition explicitly with `extend type`:
   * - `'first'` (default): keep the first non-extension definition
   * - `'last'`: keep the last non-extension definition
   * - `'error'`: throw when a name has more than one non-extension definition
   *
   * Type extensions (`extend type ...`) are ALWAYS merged into the base
   * definition regardless of this setting — including under `'error'`, where
   * only duplicate *base* definitions are an error.
   *
   * {@link mergeSchemas} resolves individual FIELDS instead, because
   * `printSchema` never emits `extend type`: every source schema contributes
   * full type definitions, so object, interface and input types sharing a name
   * are merged field by field.
   * - `'first'` (default): the first schema to define a field wins
   * - `'last'`: the last schema to define a field wins
   * - `'error'`: throw when two schemas define the same field
   *
   * Names that have no field map to merge — scalars, enums, unions, directive
   * definitions, and two definitions of different kinds — fall back to
   * whole-definition resolution under both functions.
   *
   * Root operation types (`schema { query: RootQuery }`, or, in a source with
   * no `schema { ... }` definition of its own, a default-named
   * `Query`/`Mutation`/`Subscription` type for an operation it does not name)
   * are resolved per operation under both functions. When two sources
   * name different types as the root of the same operation, `'first'` keeps
   * the first name (also under `'error'`) and `'last'` keeps the last one, and
   * the fields of the losing root types are merged into the winner field by
   * field, so every source's root fields stay reachable. A field defined by
   * more than one of those root types follows this setting like any other
   * field: `'error'` throws only on such a field, never on the differing names
   * alone. The losing type is dropped unless another type still references
   * it, in which case it stays as an ordinary type. The merged schema carries
   * a single schema definition.
   */
  onTypeConflict?: 'error' | 'first' | 'last';
}

/**
 * Merge multiple GraphQL schemas into one.
 *
 * Type definitions are combined at the AST level: types that appear in more
 * than one source schema are merged field by field, so every source keeps its
 * `Query`, `Mutation` and `Subscription` fields rather than the first schema's
 * root type shadowing the rest. {@link MergeOptions.onTypeConflict} decides
 * which source wins when two of them define the same field.
 *
 * Custom root type names are kept: a source whose query root is `RootQuery`
 * still has `RootQuery` as the merged query root. When two sources name
 * different root types for the same operation,
 * {@link MergeOptions.onTypeConflict} picks the name and the other root
 * types' fields (and resolvers) are merged into it.
 *
 * The merged schema is rebuilt from those definitions, so executable functions
 * from the source schemas — field `resolve`/`subscribe`, `resolveType` on
 * interfaces and unions, `isTypeOf` on object types, and
 * the coercion functions on custom scalars (`serialize`/`parseValue`/
 * `parseLiteral`, and graphql 17's `coerce*`/`valueToLiteral`) — are re-attached
 * afterwards, following the same conflict policy.
 *
 * @throws If two source schemas declare the same type name as different kinds
 * (for example a custom scalar in one schema and an object type in another).
 * Re-attaching the loser's executable functions is impossible, so this fails
 * at composition time instead of surfacing as a coercion error per request.
 *
 * @throws If the optional `resolvers` argument names a type or field that is
 * not present in the merged schema. A key naming a root type folded into
 * another is applied to the winning root instead, and throws only for a field
 * the winner lacks. It is applied last and overrides any re-attached source
 * resolvers.
 *
 * The schema description is the first source's that has one, whether the
 * source was built from SDL or in code. Schema-level directives
 * (`schema @link(...) { ... }`, `extend schema @tag`) are carried over from
 * each source's `astNode` and `extensionASTNodes`, which graphql-js keeps only
 * for schemas built from SDL. A non-repeatable directive is kept once, first
 * source winning; a repeatable one keeps every distinct occurrence.
 *
 * Not preserved across the rebuild: custom internal enum values, the source
 * schemas' own type instances, and the schema-level directives of a source
 * built in code without those AST nodes (`printSchema` never prints
 * schema-level directives). To be sure schema
 * directives survive, merge from SDL with {@link mergeSchemasFromStrings} or
 * the schema loaders instead.
 */
export function mergeSchemas(
  schemas: GraphQLSchema[],
  resolvers?: Resolvers,
  options?: MergeOptions
): GraphQLSchema {
  if (schemas.length === 0) {
    throw new Error('At least one schema is required');
  }

  if (schemas.length === 1 && !resolvers) {
    return schemas[0]!;
  }

  const documents = schemas.map((schema) => parse(printSchema(schema)));
  const { document, rootAliases } = mergeSchemaDocuments(
    documents,
    collectRootTypes(schemas),
    collectSchemaNodes(schemas),
    options
  );
  const mergedSchema = buildMergedSchema(document);

  // Re-attach executable functions lost in the rebuild
  reattachExecutableFunctions(mergedSchema, schemas, rootAliases, options);

  // Apply resolvers if provided
  if (resolvers) {
    return addResolversToSchema(mergedSchema, resolvers, rootAliases, options);
  }

  return mergedSchema;
}

/**
 * Merge GraphQL schemas from SDL strings.
 *
 * `extend type ...` definitions are merged into their base definition;
 * duplicate base definitions follow {@link MergeOptions.onTypeConflict}.
 *
 * `schema { ... }` definitions and `extend schema` extensions are combined
 * into one schema definition, so custom root type names survive the merge.
 * A source with its own `schema { ... }` definition is authoritative for its
 * roots, as in graphql-js. In a source without one (or with only
 * `extend schema`), a default-named `Query`, `Mutation` or `Subscription`
 * object type is the root of any operation it does not name, even when
 * another source has a `schema { ... }` block.
 *
 * Two sources naming different root types for the same operation follow
 * {@link MergeOptions.onTypeConflict} for the name, and the losing root types'
 * fields (and resolvers) are merged into the winner.
 *
 * @throws If the optional `resolvers` argument names a type or field that is
 * not present in the merged schema. A key naming a root type folded into
 * another is applied to the winning root instead, and throws only for a field
 * the winner lacks.
 */
export function mergeSchemasFromStrings(
  typeDefs: string[],
  resolvers?: Resolvers,
  options?: MergeOptions
): GraphQLSchema {
  const documents = typeDefs.map((typeDef) => parse(typeDef));
  const { document, rootAliases } = mergeTypeDefinitionDocuments(
    documents,
    options
  );
  const schema = buildMergedSchema(document);

  if (resolvers) {
    return addResolversToSchema(schema, resolvers, rootAliases, options);
  }

  return schema;
}

/**
 * Build a schema from an already-merged document, tagging build failures so
 * callers can tell them apart from their own SDL errors.
 */
function buildMergedSchema(document: DocumentNode): GraphQLSchema {
  try {
    return buildASTSchema(document);
  } catch (error) {
    throw new Error(`Failed to merge schemas: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * Read the name of a definition node, or `undefined` for the anonymous ones
 * (`schema { ... }` and `extend schema ...`).
 */
function definitionName(definition: DefinitionNode): string | undefined {
  return (definition as { name?: { value: string } }).name?.value;
}

/**
 * Extension AST kinds end with "TypeExtension" (for example
 * `Kind.OBJECT_TYPE_EXTENSION` is `"ObjectTypeExtension"`) — they never start
 * with it.
 */
function isTypeExtension(definition: DefinitionNode): boolean {
  return definition.kind.endsWith('TypeExtension');
}

/**
 * Root operation type names keyed by operation
 */
type RootTypeNames = Map<OperationTypeNode, string>;

/**
 * Every distinct root type name the sources gave each operation, in source
 * order
 */
type RootCandidates = Map<OperationTypeNode, string[]>;

const DEFAULT_ROOT_TYPE_NAMES: Readonly<Record<OperationTypeNode, string>> = {
  [OperationTypeNode.QUERY]: 'Query',
  [OperationTypeNode.MUTATION]: 'Mutation',
  [OperationTypeNode.SUBSCRIPTION]: 'Subscription',
};

const ROOT_OPERATIONS = Object.keys(
  DEFAULT_ROOT_TYPE_NAMES
) as readonly OperationTypeNode[];

/**
 * Record that a source names `typeName` as the root type of `operation`.
 */
function addRootCandidate(
  candidates: RootCandidates,
  operation: OperationTypeNode,
  typeName: string
): void {
  const names = candidates.get(operation);

  if (!names) {
    candidates.set(operation, [typeName]);
  } else if (!names.includes(typeName)) {
    names.push(typeName);
  }
}

/**
 * Pick the winning root type name of each operation: the first candidate, or
 * the last one under `'last'`. Disagreeing names never throw — the losing
 * root types are folded into the winner field by field instead (see
 * {@link foldRootTypes}), so `'error'` only fires on a real field conflict.
 */
function resolveRootTypes(
  candidates: RootCandidates,
  options?: MergeOptions
): RootTypeNames {
  const roots: RootTypeNames = new Map();

  for (const [operation, names] of candidates) {
    roots.set(
      operation,
      options?.onTypeConflict === 'last' ? names[names.length - 1]! : names[0]!
    );
  }

  return roots;
}

/**
 * Collect the root operation types of every source schema.
 */
function collectRootTypes(schemas: GraphQLSchema[]): RootCandidates {
  const candidates: RootCandidates = new Map();

  for (const schema of schemas) {
    for (const operation of ROOT_OPERATIONS) {
      const rootType = schema.getRootType(operation);
      if (rootType) {
        addRootCandidate(candidates, operation, rootType.name);
      }
    }
  }

  return candidates;
}

/**
 * The `schema { ... }` definitions and `extend schema` extensions each source
 * schema was built from, plus the names of every repeatable directive the
 * sources define. `printSchema` drops schema-level directives, so they are
 * carried over from these AST nodes instead. A schema built in code has no
 * such nodes.
 */
interface SourceSchemaNodes {
  nodes: (SchemaDefinitionNode | SchemaExtensionNode)[];
  repeatableDirectives: Set<string>;
  /** The first source's schema description, set for SDL and code alike */
  description?: string;
}

/**
 * Collect the schema-level AST nodes and repeatable directive names of every
 * source schema.
 */
function collectSchemaNodes(schemas: GraphQLSchema[]): SourceSchemaNodes {
  const nodes: (SchemaDefinitionNode | SchemaExtensionNode)[] = [];
  const repeatableDirectives = new Set<string>();
  let description: string | undefined;

  for (const schema of schemas) {
    // First source with a description wins, as in mergeSchemasFromStrings.
    description ??= schema.description ?? undefined;
    if (schema.astNode) nodes.push(schema.astNode);
    nodes.push(...schema.extensionASTNodes);

    for (const directive of schema.getDirectives()) {
      if (directive.isRepeatable) repeatableDirectives.add(directive.name);
    }
  }

  return {
    nodes,
    repeatableDirectives,
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * Root types folded into the winning root type of their operation
 */
interface RootFold {
  /** The folded definition of each winning root type, keyed by its name */
  winners: Map<string, ObjectTypeDefinitionNode>;
  /** Losing root type name to the winning root type it was folded into */
  aliases: Map<string, string>;
}

/**
 * When sources name different root types for the same operation, merge the
 * fields of every candidate into the winning one, in source order, so no
 * source's root fields become unreachable. Same-named fields follow
 * {@link MergeOptions.onTypeConflict} exactly as a same-named type would.
 *
 * An operation whose candidates are not all object type definitions is left
 * alone; building the schema reports that error.
 */
function foldRootTypes(
  roots: RootTypeNames,
  candidates: RootCandidates,
  lookup: (typeName: string) => DefinitionNode | undefined,
  options?: MergeOptions
): RootFold {
  const fold: RootFold = { winners: new Map(), aliases: new Map() };

  for (const [operation, names] of candidates) {
    if (names.length < 2) continue;

    const winner = roots.get(operation)!;
    const definitions = names.map(lookup);

    if (
      !definitions.every(
        (definition): definition is ObjectTypeDefinitionNode =>
          definition?.kind === Kind.OBJECT_TYPE_DEFINITION
      )
    ) {
      continue;
    }

    let folded: ObjectTypeDefinitionNode = definitions[0]!;
    for (const definition of definitions.slice(1)) {
      folded = mergeFieldedDefinitions(
        winner,
        folded,
        definition,
        options
      ) as ObjectTypeDefinitionNode;
    }

    // The fold starts from the first candidate, so its identity (description,
    // directives, location) would otherwise survive even when another
    // candidate wins. Take those from the winner's own definition.
    const own = definitions[names.indexOf(winner)]!;
    const {
      description: _description,
      directives: _directives,
      loc: _loc,
      ...foldedFields
    } = folded;

    fold.winners.set(winner, {
      ...foldedFields,
      name: own.name,
      ...(own.description ? { description: own.description } : {}),
      ...(own.directives ? { directives: own.directives } : {}),
      ...(own.loc ? { loc: own.loc } : {}),
    });

    for (const name of names) {
      if (name !== winner) fold.aliases.set(name, winner);
    }
  }

  return fold;
}

/**
 * The losing root types that can be dropped: those that are not a root of
 * another operation and that no remaining definition references. A loser that
 * is still referenced (as a field type, say) stays, with its fields also
 * merged into the root.
 *
 * `ownedDefinitions` pairs every type definition or extension with the name of
 * the type it belongs to; schema definitions are left out.
 */
function droppableRootTypes(
  fold: RootFold,
  roots: RootTypeNames,
  ownedDefinitions: readonly (readonly [string, DefinitionNode])[]
): Set<string> {
  const rootNames = new Set(roots.values());
  const droppable = new Set(
    [...fold.aliases.keys()].filter((name) => !rootNames.has(name))
  );

  // Dropping a loser removes its references, which may in turn free another
  // loser, so repeat until nothing more is kept.
  let changed = droppable.size > 0;
  while (changed) {
    const referenced = new Set<string>();
    const remaining = ownedDefinitions
      .filter(([owner]) => !droppable.has(owner))
      .map(([, definition]) => definition);

    visit(
      { kind: Kind.DOCUMENT, definitions: remaining },
      {
        NamedType(node) {
          referenced.add(node.name.value);
        },
      }
    );

    changed = false;
    for (const name of droppable) {
      if (referenced.has(name)) {
        droppable.delete(name);
        changed = true;
      }
    }
  }

  return droppable;
}

/**
 * A merged document plus the losing root types folded into each winner
 */
interface MergedDocument {
  document: DocumentNode;
  rootAliases: Map<string, string>;
}

/**
 * The type store a merge path folds its root types into. Each path keeps its
 * definitions differently, so this adapts the store to {@link foldRootDocument}.
 */
interface RootFoldStore {
  /** Look up the definition of `typeName` to fold, if it can be folded */
  lookup(typeName: string): DefinitionNode | undefined;
  /** Replace `typeName` with its folded definition */
  replace(typeName: string, definition: ObjectTypeDefinitionNode): void;
  /** Every type definition or extension, paired with its type's name */
  ownedDefinitions(): readonly (readonly [string, DefinitionNode])[];
  /** Remove `typeName` and its extensions */
  remove(typeName: string): void;
  /** Every remaining type definition and extension, in order */
  definitions(): DefinitionNode[];
  /** The schema definition or extension to emit for the resolved roots */
  schemaDefinitions(roots: RootTypeNames): DefinitionNode[];
}

/**
 * The root type fold both merge paths share: resolve each operation's root,
 * fold the losing roots into it, drop the losers nothing references, then
 * emit the remaining definitions followed by the schema definition.
 */
function foldRootDocument(
  candidates: RootCandidates,
  store: RootFoldStore,
  options?: MergeOptions
): MergedDocument {
  const roots = resolveRootTypes(candidates, options);
  const fold = foldRootTypes(
    roots,
    candidates,
    (typeName) => store.lookup(typeName),
    options
  );

  for (const [typeName, definition] of fold.winners) {
    store.replace(typeName, definition);
  }

  for (const typeName of droppableRootTypes(
    fold,
    roots,
    store.ownedDefinitions()
  )) {
    store.remove(typeName);
  }

  return {
    document: {
      kind: Kind.DOCUMENT,
      definitions: [...store.definitions(), ...store.schemaDefinitions(roots)],
    },
    rootAliases: fold.aliases,
  };
}

/**
 * Build a single schema definition naming the given root operation types.
 */
function buildSchemaDefinition(
  roots: RootTypeNames,
  directives?: readonly ConstDirectiveNode[],
  description?: StringValueNode
): SchemaDefinitionNode {
  return {
    kind: Kind.SCHEMA_DEFINITION,
    ...(description ? { description } : {}),
    ...(directives && directives.length > 0 ? { directives } : {}),
    operationTypes: ROOT_OPERATIONS.filter((operation) =>
      roots.has(operation)
    ).map((operation) => ({
      kind: Kind.OPERATION_TYPE_DEFINITION,
      operation,
      type: {
        kind: Kind.NAMED_TYPE,
        name: { kind: Kind.NAME, value: roots.get(operation)! },
      },
    })),
  };
}

function isSchemaDefinitionOrExtension(
  definition: DefinitionNode
): definition is SchemaDefinitionNode | SchemaExtensionNode {
  return (
    definition.kind === Kind.SCHEMA_DEFINITION ||
    definition.kind === Kind.SCHEMA_EXTENSION
  );
}

/**
 * A base definition plus every extension collected for the same name
 */
interface TypeEntry {
  base?: DefinitionNode;
  extensions: DefinitionNode[];
}

/**
 * Merge parsed SDL documents, keeping `extend type` semantics.
 *
 * Extensions are additive and never conflict, so they accumulate independently
 * of the base definition and survive whichever base wins.
 */
function mergeTypeDefinitionDocuments(
  documents: DocumentNode[],
  options?: MergeOptions
): MergedDocument {
  const entries = new Map<string, TypeEntry>();
  const schemaNodes: (SchemaDefinitionNode | SchemaExtensionNode)[] = [];
  const candidates: RootCandidates = new Map();
  const repeatableDirectives = new Set<string>();

  for (const document of documents) {
    const namedOperations = new Set<OperationTypeNode>();
    const objectTypeNames = new Set<string>();
    let hasSchemaDefinition = false;

    for (const definition of document.definitions) {
      if (isSchemaDefinitionOrExtension(definition)) {
        schemaNodes.push(definition);
        if (definition.kind === Kind.SCHEMA_DEFINITION) {
          hasSchemaDefinition = true;
        }
        for (const operationType of definition.operationTypes ?? []) {
          namedOperations.add(operationType.operation);
          addRootCandidate(
            candidates,
            operationType.operation,
            operationType.type.name.value
          );
        }
        continue;
      }

      if (
        definition.kind === Kind.DIRECTIVE_DEFINITION &&
        definition.repeatable
      ) {
        repeatableDirectives.add(definition.name.value);
      }

      const name = definitionName(definition);

      if (!name) continue;

      if (definition.kind === Kind.OBJECT_TYPE_DEFINITION) {
        objectTypeNames.add(name);
      }

      let entry = entries.get(name);

      if (!entry) {
        entry = { extensions: [] };
        entries.set(name, entry);
      }

      if (isTypeExtension(definition)) {
        entry.extensions.push(definition);
        continue;
      }

      if (!entry.base) {
        entry.base = definition;
        continue;
      }

      if (options?.onTypeConflict === 'error') {
        throw new Error(`Type conflict: ${name} is defined multiple times`);
      }

      if (options?.onTypeConflict === 'last') {
        // Replace only the base definition — the extensions collected so far
        // still apply to the winner.
        entry.base = definition;
      }
      // 'first' is the default - keep the base already collected
    }

    // A source with its own `schema { ... }` definition is authoritative for
    // its roots, as in graphql-js. Any other source (none, or only
    // `extend schema`) has a default-named object type as its root for every
    // operation it does not name. Recording it as a candidate keeps its fields
    // reachable even when another source has a `schema { ... }` block or names
    // a different root type for the same operation.
    if (hasSchemaDefinition) continue;

    for (const operation of ROOT_OPERATIONS) {
      const defaultName = DEFAULT_ROOT_TYPE_NAMES[operation];
      if (!namedOperations.has(operation) && objectTypeNames.has(defaultName)) {
        addRootCandidate(candidates, operation, defaultName);
      }
    }
  }

  const entryDefinitions = (entry: TypeEntry): DefinitionNode[] => [
    ...(entry.base ? [entry.base] : []),
    ...entry.extensions,
  ];

  return foldRootDocument(
    candidates,
    {
      lookup: (typeName) =>
        flattenTypeEntry(typeName, entries.get(typeName), options),
      replace: (typeName, definition) => {
        entries.set(typeName, { base: definition, extensions: [] });
      },
      ownedDefinitions: () =>
        [...entries].flatMap(([typeName, entry]) =>
          entryDefinitions(entry).map(
            (definition) => [typeName, definition] as const
          )
        ),
      remove: (typeName) => {
        entries.delete(typeName);
      },
      definitions: () => [...entries.values()].flatMap(entryDefinitions),
      schemaDefinitions: (roots) =>
        mergeSchemaNodes(schemaNodes, roots, repeatableDirectives),
    },
    options
  );
}

/**
 * Collapse an object type's base definition and its `extend type` extensions
 * into one definition, so it can be folded into another root type. Returns
 * `undefined` for anything that is not an object type with a base definition.
 */
function flattenTypeEntry(
  typeName: string,
  entry: TypeEntry | undefined,
  options?: MergeOptions
): ObjectTypeDefinitionNode | undefined {
  if (
    entry?.base?.kind !== Kind.OBJECT_TYPE_DEFINITION ||
    !entry.extensions.every(
      (extension) => extension.kind === Kind.OBJECT_TYPE_EXTENSION
    )
  ) {
    return undefined;
  }

  let flattened: ObjectTypeDefinitionNode = entry.base;

  for (const extension of entry.extensions) {
    flattened = mergeFieldedDefinitions(
      typeName,
      flattened,
      extension as unknown as ObjectTypeDefinitionNode,
      options
    ) as ObjectTypeDefinitionNode;
  }

  return flattened;
}

/**
 * Combine every `schema { ... }` definition and `extend schema` extension
 * into one schema definition naming the resolved `roots`.
 *
 * `roots` already includes the default-named root types (`Query`, `Mutation`,
 * `Subscription`) for operations no source names, so emitting an explicit
 * definition never drops them. The schema description comes from the first
 * base definition that has one; directives are combined by
 * {@link mergeSchemaDirectives}.
 * `roots` is not modified.
 */
function mergeSchemaNodes(
  schemaNodes: (SchemaDefinitionNode | SchemaExtensionNode)[],
  roots: RootTypeNames,
  repeatableDirectives: ReadonlySet<string>
): DefinitionNode[] {
  if (schemaNodes.length === 0) {
    return [];
  }

  // First base definition that has a description wins, as in mergeSchemas.
  const describedDefinition = schemaNodes.find(
    (node): node is SchemaDefinitionNode =>
      node.kind === Kind.SCHEMA_DEFINITION && node.description !== undefined
  );
  const directives = mergeSchemaDirectives(schemaNodes, repeatableDirectives);

  // emitSchemaDefinition keeps the description only when roots exist: without
  // root types it would print as `"..." schema {}`, which graphql-js cannot
  // re-parse. With no roots the nodes are directive-carrying extensions only,
  // emitted as a bare `extend schema` with duplicate directives dropped.
  return emitSchemaDefinition(
    roots,
    directives,
    describedDefinition?.description
  );
}

/**
 * The one place that decides what schema node carries the resolved roots,
 * directives and description: a `schema { ... }` definition when there are
 * roots, else a bare `extend schema` carrying the directives, else nothing.
 * A description is dropped when there are no roots.
 */
function emitSchemaDefinition(
  roots: RootTypeNames,
  directives: readonly ConstDirectiveNode[],
  description: StringValueNode | undefined
): DefinitionNode[] {
  // A description without root types would print as `"..." schema {}`, which
  // graphql-js cannot re-parse, so it is only kept when roots exist.
  if (roots.size > 0) {
    return [buildSchemaDefinition(roots, directives, description)];
  }
  return directives.length > 0
    ? [{ kind: Kind.SCHEMA_EXTENSION, directives }]
    : [];
}

/**
 * Collect the directives applied to `schema { ... }` definitions and
 * `extend schema` extensions, in order. A non-repeatable directive is kept
 * once per name, first occurrence winning; a directive named in
 * `repeatableDirectives` keeps every distinct occurrence, dropping only exact
 * (printed) duplicates.
 */
function mergeSchemaDirectives(
  schemaNodes: readonly (SchemaDefinitionNode | SchemaExtensionNode)[],
  repeatableDirectives: ReadonlySet<string>
): ConstDirectiveNode[] {
  const directives: ConstDirectiveNode[] = [];
  const seenDirectives = new Set<string>();

  for (const node of schemaNodes) {
    for (const directive of node.directives ?? []) {
      const key = repeatableDirectives.has(directive.name.value)
        ? print(directive)
        : directive.name.value;
      if (seenDirectives.has(key)) continue;
      seenDirectives.add(key);
      directives.push(directive);
    }
  }

  return directives;
}

/**
 * Definition kinds that carry a field map and can therefore be merged field by
 * field instead of one whole definition displacing another
 */
type FieldedDefinitionNode =
  | ObjectTypeDefinitionNode
  | InterfaceTypeDefinitionNode
  | InputObjectTypeDefinitionNode;

function isFieldedDefinition(
  definition: DefinitionNode
): definition is FieldedDefinitionNode {
  return (
    definition.kind === Kind.OBJECT_TYPE_DEFINITION ||
    definition.kind === Kind.INTERFACE_TYPE_DEFINITION ||
    definition.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION
  );
}

/**
 * Merge documents printed from source schemas.
 *
 * `printSchema` never emits `extend type`, so every source contributes a full
 * base definition for its root types. Displacing one with another would drop
 * whole `Query`/`Mutation` field sets (and their resolvers) silently, so types
 * with a field map are merged field by field instead.
 *
 * The printed `schema { ... }` blocks are dropped in favour of one definition
 * built from the resolved root types, emitted only when a root type has a
 * non-default name, a default-named type is not a root in any source
 * (otherwise graphql-js already picks `Query`, `Mutation` and `Subscription`
 * by name), or `schemaNodes` carries schema-level directives or a schema
 * description. The directives come from the sources' own schema AST nodes,
 * since `printSchema` omits them, and are combined by
 * {@link mergeSchemaDirectives}; the description is the first source's.
 *
 * Losing root types are folded into the winner; the returned `rootAliases`
 * maps each one to the root it was folded into.
 */
function mergeSchemaDocuments(
  documents: DocumentNode[],
  candidates: RootCandidates,
  schemaNodes: SourceSchemaNodes,
  options?: MergeOptions
): MergedDocument {
  const merged = new Map<string, DefinitionNode>();

  for (const document of documents) {
    for (const definition of document.definitions) {
      const name = definitionName(definition);

      if (!name) continue;

      const existing = merged.get(name);

      if (!existing) {
        merged.set(name, definition);
        continue;
      }

      if (
        existing.kind === definition.kind &&
        isFieldedDefinition(existing) &&
        isFieldedDefinition(definition)
      ) {
        merged.set(
          name,
          mergeFieldedDefinitions(name, existing, definition, options)
        );
        continue;
      }

      // Scalars, enums, unions, directive definitions and kind mismatches have
      // no field map to merge, so the whole definition is resolved instead.
      if (options?.onTypeConflict === 'error') {
        throw new Error(`Type conflict: ${name} is defined multiple times`);
      }

      if (options?.onTypeConflict === 'last') {
        merged.set(name, definition);
      }
      // 'first' is the default - keep the definition already collected
    }
  }

  return foldRootDocument(
    candidates,
    {
      lookup: (typeName) => merged.get(typeName),
      replace: (typeName, definition) => {
        merged.set(typeName, definition);
      },
      ownedDefinitions: () => [...merged],
      remove: (typeName) => {
        merged.delete(typeName);
      },
      definitions: () => [...merged.values()],
      schemaDefinitions: (roots) =>
        printedSchemaDefinitions(merged, roots, schemaNodes),
    },
    options
  );
}

/**
 * The schema definition to emit for documents printed from source schemas,
 * if one is needed (see {@link mergeSchemaDocuments}).
 */
function printedSchemaDefinitions(
  merged: ReadonlyMap<string, DefinitionNode>,
  roots: RootTypeNames,
  schemaNodes: SourceSchemaNodes
): DefinitionNode[] {
  const hasCustomRootName = [...roots].some(
    ([operation, typeName]) => DEFAULT_ROOT_TYPE_NAMES[operation] !== typeName
  );
  // Without a schema definition graphql-js would promote a default-named type
  // that no source used as a root (`schema { query: Query } type Mutation`).
  const hasNonRootDefaultName = ROOT_OPERATIONS.some(
    (operation) =>
      !roots.has(operation) &&
      merged.get(DEFAULT_ROOT_TYPE_NAMES[operation])?.kind ===
        Kind.OBJECT_TYPE_DEFINITION
  );

  const directives = mergeSchemaDirectives(
    schemaNodes.nodes,
    schemaNodes.repeatableDirectives
  );

  const description: StringValueNode | undefined =
    schemaNodes.description !== undefined
      ? { kind: Kind.STRING, value: schemaNodes.description }
      : undefined;

  // With no roots, emitSchemaDefinition drops the description (it would print
  // as an unparseable `"..." schema {}`) and emits only the directives.
  const needsDefinition =
    description ||
    hasCustomRootName ||
    hasNonRootDefaultName ||
    directives.length > 0;
  return needsDefinition
    ? emitSchemaDefinition(roots, directives, description)
    : [];
}

/**
 * Combine two definitions of the same name into one whose field map is the
 * union of both, resolving same-named fields per {@link MergeOptions}.
 */
function mergeFieldedDefinitions(
  typeName: string,
  existing: FieldedDefinitionNode,
  incoming: FieldedDefinitionNode,
  options?: MergeOptions
): FieldedDefinitionNode {
  type FieldNode = { name: { value: string } };

  const fields = [...(existing.fields ?? [])] as FieldNode[];
  const indexByName = new Map(
    fields.map((field, index) => [field.name.value, index])
  );

  for (const field of (incoming.fields ?? []) as readonly FieldNode[]) {
    const fieldName = field.name.value;
    const index = indexByName.get(fieldName);

    if (index === undefined) {
      indexByName.set(fieldName, fields.length);
      fields.push(field);
      continue;
    }

    if (options?.onTypeConflict === 'error') {
      throw new Error(
        `Type conflict: ${typeName}.${fieldName} is defined multiple times`
      );
    }

    if (options?.onTypeConflict === 'last') {
      fields[index] = field;
    }
    // 'first' is the default - keep the field already collected
  }

  const result = { ...existing, fields } as unknown as FieldedDefinitionNode;
  const interfaces = mergeInterfaceLists(existing, incoming);

  if (interfaces) {
    (result as { interfaces?: readonly NamedTypeNode[] }).interfaces =
      interfaces;
  }

  return result;
}

/**
 * Union the `implements` lists of two definitions of the same object or
 * interface type, so a type only implementing an interface in one source
 * schema still implements it after the merge.
 */
function mergeInterfaceLists(
  existing: FieldedDefinitionNode,
  incoming: FieldedDefinitionNode
): readonly NamedTypeNode[] | undefined {
  const existingInterfaces = (existing as ObjectTypeDefinitionNode).interfaces;
  const incomingInterfaces = (incoming as ObjectTypeDefinitionNode).interfaces;

  if (!existingInterfaces && !incomingInterfaces) {
    return undefined;
  }

  const seen = new Set<string>();
  const result: NamedTypeNode[] = [];

  for (const node of [
    ...(existingInterfaces ?? []),
    ...(incomingInterfaces ?? []),
  ]) {
    if (seen.has(node.name.value)) continue;
    seen.add(node.name.value);
    result.push(node);
  }

  return result;
}

/**
 * Re-attach executable functions from the source schemas to a merged schema
 * that was rebuilt from type definitions (and therefore lost them).
 */
function reattachExecutableFunctions(
  merged: GraphQLSchema,
  sources: GraphQLSchema[],
  rootAliases: Map<string, string>,
  options?: MergeOptions
): void {
  const mergedTypeMap = merged.getTypeMap();

  // Later applications overwrite earlier ones. Under the default 'first'
  // conflict policy the first schema's functions should win, so apply the
  // sources in reverse order; under 'last', apply them in order.
  const ordered =
    options?.onTypeConflict === 'last' ? sources : [...sources].reverse();

  // Pass 1: a losing root type was folded into the winning root type, so its
  // field resolvers belong there too. They are copied before any source's
  // winner-named root type (pass 2), and among the losers in fold precedence
  // order, so the resolver of a winning root field always comes from the
  // definition that supplied the field's SDL.
  for (const loser of orderedRootAliases(rootAliases, options)) {
    const rootType = mergedTypeMap[rootAliases.get(loser)!];
    if (!isObjectType(rootType)) continue;

    for (const source of ordered) {
      const sourceType = source.getType(loser);
      if (isObjectType(sourceType)) {
        copyFieldResolvers(sourceType.getFields(), rootType.getFields());
      }
    }
  }

  // Pass 2: every type's own executable functions, including those of the
  // winning root types (and of a losing root type that was kept).
  for (const source of ordered) {
    for (const [typeName, sourceType] of Object.entries(source.getTypeMap())) {
      if (typeName.startsWith('__')) continue;

      const mergedType = mergedTypeMap[typeName];
      const rootAlias = rootAliases.get(typeName);

      if (!mergedType) {
        if (rootAlias !== undefined) continue;

        // Built-in scalars are never printed into the merged SDL, so they drop
        // out whenever nothing in the merged schema references them — that is
        // expected and carries no custom behaviour. Anything else going missing
        // means the type lost its slot during conflict resolution and its
        // executable functions cannot be re-attached.
        if (!isSpecifiedScalarType(sourceType)) {
          console.warn(
            `mergeSchemas: type "${typeName}" exists in a source schema but not ` +
              `in the merged schema; its resolvers were dropped.`
          );
        }
        continue;
      }

      if (mergedType === sourceType) continue;

      if (isScalarType(sourceType) && isScalarType(mergedType)) {
        if (!isSpecifiedScalarType(sourceType)) {
          copyScalarFunctions(sourceType, mergedType);
        }
      } else if (isObjectType(sourceType) && isObjectType(mergedType)) {
        if (sourceType.isTypeOf) {
          mergedType.isTypeOf = sourceType.isTypeOf;
        }
        copyFieldResolvers(sourceType.getFields(), mergedType.getFields());
      } else if (isInterfaceType(sourceType) && isInterfaceType(mergedType)) {
        if (sourceType.resolveType) {
          mergedType.resolveType = sourceType.resolveType;
        }
        copyFieldResolvers(sourceType.getFields(), mergedType.getFields());
      } else if (isUnionType(sourceType) && isUnionType(mergedType)) {
        if (sourceType.resolveType) {
          mergedType.resolveType = sourceType.resolveType;
        }
      } else if (sourceType.constructor !== mergedType.constructor) {
        // Two source schemas declared the same name as different kinds (e.g.
        // a custom scalar in one and an object type in the other). Conflict
        // resolution kept one of them, so the loser's executable functions
        // have nowhere to go. Fail loudly at composition time rather than
        // producing a schema that misbehaves per-request.
        throw new Error(
          `Cannot merge type "${typeName}": source is ${sourceType.constructor.name} but merged is ${mergedType.constructor.name}`
        );
      }
    }
  }
}

/**
 * Scalar function slots carried across a merge. graphql 17 executes through
 * the `coerce*` functions and only keeps the legacy `serialize`/`parse*` names
 * as deprecated aliases, so both sets are copied; slots the installed graphql
 * version does not define are skipped.
 */
const SCALAR_FUNCTION_KEYS = [
  'serialize',
  'parseValue',
  'parseLiteral',
  'coerceOutputValue',
  'coerceInputValue',
  'coerceInputLiteral',
  'valueToLiteral',
] as const;

/**
 * Copy the executable functions of a custom scalar onto its rebuilt copy.
 */
function copyScalarFunctions(
  source: GraphQLScalarType,
  target: GraphQLScalarType
): void {
  const from = source as unknown as Record<string, unknown>;
  const to = target as unknown as Record<string, unknown>;
  for (const key of SCALAR_FUNCTION_KEYS) {
    if (key in from) {
      to[key] = from[key];
    }
  }
}

/**
 * The losing root type names of `rootAliases` in the order their resolvers
 * must be applied to the winning root, so that a later application overwrites
 * an earlier one exactly where {@link foldRootTypes} lets a later fold step
 * win a field.
 *
 * `rootAliases` lists the losers in candidate order. Under `'first'` the
 * earliest candidate keeps a shared field, so the losers apply in reverse;
 * under `'last'` the latest candidate takes it, so they apply in order. The
 * winner sits at the end of that precedence either way and is applied after
 * all of them.
 */
function orderedRootAliases(
  rootAliases: Map<string, string>,
  options?: MergeOptions
): string[] {
  const losers = [...rootAliases.keys()];
  return options?.onTypeConflict === 'last' ? losers : losers.reverse();
}

/**
 * Copy `resolve` and `subscribe` functions from source fields onto the
 * matching fields of a rebuilt type.
 */
function copyFieldResolvers(
  sourceFields: GraphQLFieldMap<unknown, unknown>,
  targetFields: GraphQLFieldMap<unknown, unknown>
): void {
  for (const [fieldName, sourceField] of Object.entries(sourceFields)) {
    const targetField = targetFields[fieldName];
    if (!targetField) continue;

    if (sourceField.resolve) {
      targetField.resolve = sourceField.resolve;
    }
    if (sourceField.subscribe) {
      targetField.subscribe = sourceField.subscribe;
    }
  }
}

/**
 * Add resolvers to an existing schema.
 *
 * Unknown type and field names throw, matching `SchemaBuilder.applyResolvers`,
 * so a typo fails at composition time instead of silently resolving to `null`
 * at runtime.
 *
 * Also like `SchemaBuilder.applyResolvers`, a bare function under the
 * subscription root type is applied as the field's `subscribe` function,
 * because graphql-js requires `subscribe` to produce the event stream.
 *
 * `rootAliases` maps each losing root type that was folded into a winning root
 * to that winner. Resolvers keyed by a losing root's name are applied to the
 * winner's fields, and also to the losing type itself if it was kept. The
 * subscription rule is decided per target: a bare function is `subscribe` on
 * the winning subscription root, and `resolve` on a kept losing type, which
 * is an ordinary type. Only a field missing on the winner is an unknown
 * field: a kept loser simply skips the fields it does not define (the ones the
 * winner gained from other sources). Where several keys target the same
 * winning root field, the losing roots apply first in the fold precedence of
 * `options.onTypeConflict`, and a key naming the winner applies last.
 */
function addResolversToSchema(
  schema: GraphQLSchema,
  resolvers: Resolvers,
  rootAliases: Map<string, string>,
  options?: MergeOptions
): GraphQLSchema {
  const typeMap = schema.getTypeMap();
  const subscriptionType = schema.getSubscriptionType();

  // Same precedence as the source resolvers: losing root types first, in fold
  // order, then every other key in its own order, so a key naming a winning
  // root overrides one naming a root that was folded into it.
  const aliasRank = new Map(
    orderedRootAliases(rootAliases, options).map((name, rank) => [name, rank])
  );
  const entries = Object.entries(resolvers).sort(
    ([a], [b]) =>
      (aliasRank.get(a) ?? aliasRank.size) - (aliasRank.get(b) ?? aliasRank.size)
  );

  for (const [typeName, typeResolvers] of entries) {
    const alias = rootAliases.get(typeName);
    const ownType = typeMap[typeName];
    const primaryType = alias !== undefined ? typeMap[alias] : ownType;

    if (!primaryType) {
      throw new Error(
        `Resolvers reference unknown type "${typeName}". Define it in one of the merged schemas first.`
      );
    }

    const targets = [primaryType];
    if (ownType && ownType !== primaryType) targets.push(ownType);

    for (const type of targets) {
      // Per target: a losing subscription root kept as an ordinary type is not
      // the schema's subscription type, so its resolvers must be `resolve`.
      const isSubscription = type === subscriptionType;

      if (!('getFields' in type)) {
        throw new Error(
          `Resolvers reference type "${typeName}", which has no fields to resolve.`
        );
      }

      const fields = (
        type as {
          getFields: () => Record<
            string,
            { resolve?: unknown; subscribe?: unknown }
          >;
        }
      ).getFields();

      for (const [fieldName, resolver] of Object.entries(typeResolvers)) {
        const field = fields[fieldName];

        if (!field && type !== primaryType) {
          continue;
        }
        if (!field) {
          throw new Error(
            `Resolvers reference unknown field "${typeName}.${fieldName}".`
          );
        }

        if (typeof resolver === 'function') {
          if (isSubscription) {
            field.subscribe = resolver;
          } else {
            field.resolve = resolver;
          }
        } else if (typeof resolver === 'object' && resolver !== null) {
          if ('resolve' in resolver) {
            field.resolve = resolver.resolve;
          }
          if ('subscribe' in resolver) {
            field.subscribe = resolver.subscribe;
          }
        } else {
          // `typeof null === 'object'`, so null has to be rejected explicitly —
          // otherwise the `in` checks above throw a bare TypeError.
          throw new Error(
            `Resolver for "${typeName}.${fieldName}" must be a function or a { resolve, subscribe } object.`
          );
        }
      }
    }
  }

  return schema;
}
