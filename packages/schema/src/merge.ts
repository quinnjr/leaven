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
  type DefinitionNode,
  type DocumentNode,
  type GraphQLFieldMap,
  type GraphQLScalarType,
  type InputObjectTypeDefinitionNode,
  type InterfaceTypeDefinitionNode,
  type NamedTypeNode,
  type ObjectTypeDefinitionNode,
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
 * not present in the merged schema. It is applied last and overrides any
 * re-attached source resolvers.
 *
 * Not preserved across the rebuild: custom internal enum values and the source
 * schemas' own type instances.
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
  const mergedSchema = buildMergedSchema(
    mergeSchemaDocuments(documents, options)
  );

  // Re-attach executable functions lost in the rebuild
  reattachExecutableFunctions(mergedSchema, schemas, options);

  // Apply resolvers if provided
  if (resolvers) {
    return addResolversToSchema(mergedSchema, resolvers);
  }

  return mergedSchema;
}

/**
 * Merge GraphQL schemas from SDL strings.
 *
 * `extend type ...` definitions are merged into their base definition;
 * duplicate base definitions follow {@link MergeOptions.onTypeConflict}.
 *
 * @throws If the optional `resolvers` argument names a type or field that is
 * not present in the merged schema.
 */
export function mergeSchemasFromStrings(
  typeDefs: string[],
  resolvers?: Resolvers,
  options?: MergeOptions
): GraphQLSchema {
  const documents = typeDefs.map((typeDef) => parse(typeDef));
  const schema = buildMergedSchema(
    mergeTypeDefinitionDocuments(documents, options)
  );

  if (resolvers) {
    return addResolversToSchema(schema, resolvers);
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
): DocumentNode {
  const entries = new Map<string, TypeEntry>();

  for (const document of documents) {
    for (const definition of document.definitions) {
      const name = definitionName(definition);

      if (!name) continue;

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
  }

  const definitions: DefinitionNode[] = [];

  for (const entry of entries.values()) {
    if (entry.base) {
      definitions.push(entry.base);
    }
    definitions.push(...entry.extensions);
  }

  return { kind: Kind.DOCUMENT, definitions };
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
 */
function mergeSchemaDocuments(
  documents: DocumentNode[],
  options?: MergeOptions
): DocumentNode {
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

  return { kind: Kind.DOCUMENT, definitions: [...merged.values()] };
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
  options?: MergeOptions
): void {
  const mergedTypeMap = merged.getTypeMap();

  // Later applications overwrite earlier ones. Under the default 'first'
  // conflict policy the first schema's functions should win, so apply the
  // sources in reverse order; under 'last', apply them in order.
  const ordered =
    options?.onTypeConflict === 'last' ? sources : [...sources].reverse();

  for (const source of ordered) {
    for (const [typeName, sourceType] of Object.entries(source.getTypeMap())) {
      if (typeName.startsWith('__')) continue;

      const mergedType = mergedTypeMap[typeName];

      if (!mergedType) {
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
 */
function addResolversToSchema(
  schema: GraphQLSchema,
  resolvers: Resolvers
): GraphQLSchema {
  const typeMap = schema.getTypeMap();

  for (const [typeName, typeResolvers] of Object.entries(resolvers)) {
    const type = typeMap[typeName];

    if (!type) {
      throw new Error(
        `Resolvers reference unknown type "${typeName}". Define it in one of the merged schemas first.`
      );
    }

    if (!('getFields' in type)) {
      throw new Error(
        `Resolvers reference type "${typeName}", which has no fields to resolve.`
      );
    }

    const fields = (
      type as {
        getFields: () => Record<string, { resolve?: unknown; subscribe?: unknown }>;
      }
    ).getFields();

    for (const [fieldName, resolver] of Object.entries(typeResolvers)) {
      const field = fields[fieldName];

      if (!field) {
        throw new Error(
          `Resolvers reference unknown field "${typeName}.${fieldName}".`
        );
      }

      if (typeof resolver === 'function') {
        field.resolve = resolver;
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

  return schema;
}
