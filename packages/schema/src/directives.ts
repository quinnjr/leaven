/**
 * @leaven-graphql/schema - Directive utilities
 *
 * Copyright 2026 Joseph Quinn
 * Licensed under the Apache License, Version 2.0
 */

import {
  GraphQLSchema,
  GraphQLDirective,
  DirectiveLocation,
  GraphQLString,
  GraphQLBoolean,
  GraphQLInt,
  type GraphQLFieldConfig,
  type ValueNode,
} from 'graphql';

/**
 * Directive configuration
 */
export interface DirectiveConfig {
  /** Directive name */
  name: string;
  /** Description */
  description?: string;
  /** Valid locations for the directive */
  locations: DirectiveLocation[];
  /** Arguments */
  args?: Record<string, { type: 'String' | 'Boolean' | 'Int'; description?: string; defaultValue?: unknown }>;
}

/**
 * Directive transformer function
 */
export type DirectiveTransformer = (
  schema: GraphQLSchema,
  directiveName: string
) => GraphQLSchema;

/**
 * Create a GraphQL directive
 */
export function createDirective(config: DirectiveConfig): GraphQLDirective {
  const args: Record<string, { type: typeof GraphQLString | typeof GraphQLBoolean | typeof GraphQLInt; description?: string; defaultValue?: unknown }> = {};

  if (config.args) {
    for (const [name, argConfig] of Object.entries(config.args)) {
      let type: typeof GraphQLString | typeof GraphQLBoolean | typeof GraphQLInt;
      switch (argConfig.type) {
        case 'Boolean':
          type = GraphQLBoolean;
          break;
        case 'Int':
          type = GraphQLInt;
          break;
        default:
          type = GraphQLString;
      }

      args[name] = {
        type,
        description: argConfig.description,
        defaultValue: argConfig.defaultValue,
      };
    }
  }

  return new GraphQLDirective({
    name: config.name,
    description: config.description,
    locations: config.locations,
    args,
  });
}

/**
 * Add a directive to a schema.
 *
 * `GraphQLSchema` is immutable, so this rebuilds the whole schema from
 * {@link GraphQLSchema.toConfig} — cost proportional to the schema size, paid
 * once per call. Installing several directives one at a time is therefore
 * O(directives × schema size); use {@link addDirectives} to pay it once.
 *
 * Returns the schema unchanged if a directive of the same name already exists,
 * which includes every spec directive (`@skip`, `@include`, `@deprecated`,
 * `@specifiedBy`).
 */
export function addDirective(
  schema: GraphQLSchema,
  directive: GraphQLDirective
): GraphQLSchema {
  const existingDirectives = schema.getDirectives();

  // Check if directive already exists
  const exists = existingDirectives.some((d) => d.name === directive.name);
  if (exists) {
    return schema;
  }

  return new GraphQLSchema({
    ...schema.toConfig(),
    directives: [...existingDirectives, directive],
  });
}

/**
 * Add several directives to a schema in a single rebuild.
 *
 * Equivalent to folding {@link addDirective} over `directives`, but rebuilds
 * the schema once instead of once per directive. Directives whose name already
 * exists on the schema — or that repeat within `directives` — are skipped, and
 * the schema is returned unchanged when nothing is left to add.
 */
export function addDirectives(
  schema: GraphQLSchema,
  directives: readonly GraphQLDirective[]
): GraphQLSchema {
  const existingDirectives = schema.getDirectives();
  const names = new Set(existingDirectives.map((d) => d.name));
  const additions: GraphQLDirective[] = [];

  for (const directive of directives) {
    if (names.has(directive.name)) continue;
    names.add(directive.name);
    additions.push(directive);
  }

  if (additions.length === 0) {
    return schema;
  }

  return new GraphQLSchema({
    ...schema.toConfig(),
    directives: [...existingDirectives, ...additions],
  });
}

/**
 * Apply directive transformers to a schema
 */
export function applyDirectives(
  schema: GraphQLSchema,
  transformers: Record<string, DirectiveTransformer>
): GraphQLSchema {
  let transformedSchema = schema;

  for (const [directiveName, transformer] of Object.entries(transformers)) {
    transformedSchema = transformer(transformedSchema, directiveName);
  }

  return transformedSchema;
}

/**
 * Convert a directive argument AST value node into a plain JavaScript value
 */
function valueFromNode(value: ValueNode): unknown {
  switch (value.kind) {
    case 'StringValue':
    case 'BooleanValue':
    case 'EnumValue':
      return value.value;
    case 'IntValue':
      return parseInt(value.value, 10);
    case 'FloatValue':
      return parseFloat(value.value);
    case 'NullValue':
      return null;
    case 'ListValue':
      return value.values.map((item) => valueFromNode(item));
    case 'ObjectValue': {
      const result: Record<string, unknown> = {};
      for (const objectField of value.fields) {
        result[objectField.name.value] = valueFromNode(objectField.value);
      }
      return result;
    }
    case 'Variable':
      // Variables cannot appear in const positions such as SDL directives,
      // and cannot be resolved without runtime variable values. The argument
      // key is still present in the result, mapped to undefined.
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Get directive argument values from a field's AST node.
 *
 * Returns a record of argument name to plain JavaScript value for the named
 * directive, or `null` if the field has no AST node or the directive is not
 * present. String, Int, Float, Boolean, Null, Enum, List and Object values
 * are all converted (lists and objects recursively); variable references —
 * which cannot occur in valid SDL directive positions — map to `undefined`.
 *
 * Only the arguments written in the SDL are returned, converted from the raw
 * AST: the directive definition's `defaultValue`s are not applied, and values
 * are converted by their literal kind rather than coerced against the
 * declared argument types (an enum value comes back as its name string, and
 * a custom scalar's `parseLiteral` is never called). Omitted arguments are
 * absent from the result. Use graphql-js `getDirectiveValues(directive, node)`
 * when defaults and coercion matter.
 */
export function getDirectiveValues(
  field: GraphQLFieldConfig<unknown, unknown>,
  directiveName: string
): Record<string, unknown> | null {
  const astNode = field.astNode;

  if (!astNode?.directives) {
    return null;
  }

  const directive = astNode.directives.find((d) => d.name.value === directiveName);

  if (!directive) {
    return null;
  }

  const values: Record<string, unknown> = {};

  for (const arg of directive.arguments ?? []) {
    values[arg.name.value] = valueFromNode(arg.value);
  }

  return values;
}

/**
 * Passing this to {@link addDirective} is a no-op — do not use it to install
 * `@deprecated`.
 *
 * graphql-js already provides the spec `@deprecated` directive on every
 * schema, and {@link addDirective} returns the schema unchanged when a
 * directive of the same name exists. This value is a standalone replica of the
 * spec directive, kept for introspecting or comparing against the spec
 * definition (and as a fixture for the `addDirective` conflict path).
 *
 * Mirrors the spec's `@deprecated` directive, valid on field definitions,
 * argument definitions, input field definitions and enum values.
 */
export const specDeprecatedDirective = createDirective({
  name: 'deprecated',
  description: 'Marks an element as deprecated',
  locations: [
    DirectiveLocation.FIELD_DEFINITION,
    DirectiveLocation.ARGUMENT_DEFINITION,
    DirectiveLocation.INPUT_FIELD_DEFINITION,
    DirectiveLocation.ENUM_VALUE,
  ],
  args: {
    reason: {
      type: 'String',
      description: 'Reason for deprecation',
      defaultValue: 'No longer supported',
    },
  },
});

/**
 * Common directive: @auth
 */
export const authDirective = createDirective({
  name: 'auth',
  description: 'Requires authentication',
  locations: [DirectiveLocation.FIELD_DEFINITION, DirectiveLocation.OBJECT],
  args: {
    requires: {
      type: 'String',
      description: 'Required role or permission',
    },
  },
});

/**
 * Common directive: @cacheControl
 */
export const cacheControlDirective = createDirective({
  name: 'cacheControl',
  description: 'Cache control hints',
  locations: [DirectiveLocation.FIELD_DEFINITION, DirectiveLocation.OBJECT],
  args: {
    maxAge: {
      type: 'Int',
      description: 'Maximum age in seconds',
    },
    scope: {
      type: 'String',
      description: 'Cache scope (PUBLIC or PRIVATE)',
      defaultValue: 'PUBLIC',
    },
  },
});
