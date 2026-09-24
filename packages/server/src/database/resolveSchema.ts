import {
  DATABASE_VERSION_COLUMN,
  DatabaseSchemaError,
  type PhysicalColumn,
  type PhysicalIndex,
  type PhysicalTable,
} from "@hot-updater/plugin-core/internal";

import type {
  AggregateShape,
  ModelShape,
  ReferenceAction,
  SchemaShape,
} from "./definitions";

export const SHARD_COLUMN = "_shard";
export const MAX_SHARDS = 64;

export interface SchemaModule {
  readonly id: string;
  readonly schema: SchemaShape;
  /** Prefixes this module's table names; third-party plugins use their id. */
  readonly namespace?: string;
}

export interface ResolvedReference {
  /** The child table and the field that holds the parent key. */
  readonly table: string;
  readonly field: string;
  readonly target: string;
  readonly onDelete: ReferenceAction;
  /** The counter column on the parent; absent for `none`. */
  readonly counter?: string;
}

export interface ResolvedModel {
  readonly module: string;
  /** The model name as its module declares it. */
  readonly model: string;
  readonly table: PhysicalTable;
  readonly definition: ModelShape;
  readonly references: readonly ResolvedReference[];
  readonly referencedBy: readonly ResolvedReference[];
  /** Index name to the physical name of its root table. */
  readonly roots: ReadonlyMap<string, string>;
}

export interface ResolvedSchema {
  /** By physical table name. */
  readonly models: ReadonlyMap<string, ResolvedModel>;
  readonly tables: readonly PhysicalTable[];
}

const NAME = /^[a-z][a-z0-9_]*$/u;
const INDEX_NAME = /^[A-Za-z][A-Za-z0-9_]*$/u;

const tableName = (module: SchemaModule, model: string) =>
  module.namespace ? `${module.namespace}_${model}` : model;

const integer = (name: string, defaulted = false): PhysicalColumn => ({
  name,
  type: "integer",
  nullable: false,
  ...(defaulted ? { default: 0 } : {}),
});

/** A declared or derived field's type, and whether it holds several values. */
const fieldType = (model: ModelShape, name: string) => {
  const field =
    model.fields[name] ??
    (model.kind === "table" ? model.derived[name] : undefined);
  return (
    field && { type: field.type, multi: "multi" in field && !!field.multi }
  );
};

const metricsOf = (model: AggregateShape) => [
  ...model.counters,
  ...model.gauges,
  ...model.distinct,
];

/** Every problem in one model's declaration, its roots and references included. */
const problemsOf = (
  module: SchemaModule,
  model: string,
  definition: ModelShape,
): string[] => {
  const problems: string[] = [];
  const add = (message: string) =>
    problems.push(`${module.id}.${model}: ${message}`);
  const table = (name: string) => {
    const target = module.schema[name];
    return target?.kind === "table" ? target : undefined;
  };
  if (!NAME.test(model)) {
    add("model names use lowercase letters, digits, and _");
  }
  const names = [
    ...Object.keys(definition.fields),
    ...(definition.kind === "table"
      ? Object.keys(definition.derived)
      : metricsOf(definition)),
  ];
  for (const name of new Set(names)) {
    if (!NAME.test(name)) add(`field "${name}" must match ${NAME.source}`);
    if (names.indexOf(name) !== names.lastIndexOf(name)) {
      add(`field "${name}" is declared twice`);
    }
  }
  const { key } = definition;
  if (key.length === 0) add("key is empty");
  if (new Set(key).size !== key.length) add("key repeats a field");
  for (const name of key) {
    const field = definition.fields[name];
    if (field === undefined) add(`key field "${name}" is not a declared field`);
    else if (field.required === false) add(`key field "${name}" is nullable`);
    else if (field.type === "json") add(`key field "${name}" is json`);
  }
  for (const [name, { type, maxLength, ascii }] of Object.entries(
    definition.fields,
  )) {
    if (
      maxLength !== undefined &&
      (type !== "string" || !Number.isSafeInteger(maxLength) || maxLength < 1)
    ) {
      add(`field "${name}" has an invalid maxLength`);
    }
    if (ascii && type !== "string") {
      add(`field "${name}" is ascii but not a string`);
    }
  }
  for (const [name, index] of Object.entries(definition.indexes)) {
    const columns = [...index.eq, ...index.sort];
    if (!INDEX_NAME.test(name)) {
      add(`index "${name}" must match ${INDEX_NAME.source}`);
    }
    if (columns.length === 0) add(`index "${name}" has no fields`);
    if (index.unique && index.sort.length > 0) {
      add(`unique index "${name}" cannot sort`);
    }
    const multi = columns.filter((column) => {
      const type = fieldType(definition, column);
      if (type === undefined) {
        add(`index "${name}" names undeclared field "${column}"`);
      } else if (type.type === "json") {
        add(`index "${name}" names json field "${column}"`);
      } else if (type.multi && index.sort.includes(column)) {
        add(`index "${name}" sorts by multi-valued field "${column}"`);
      }
      return type?.type !== "json" && type?.multi;
    });
    if (multi.length > 1) {
      add(`index "${name}" has more than one multi-valued field`);
    }
    if (index.root === undefined) continue;
    const root = table(index.root.model);
    if (root === undefined) {
      add(`index "${name}" is rooted at unknown table "${index.root.model}"`);
    } else if (
      root.key.length > index.eq.length ||
      root.key.some(
        (field, position) =>
          fieldType(definition, index.eq[position]!)?.type !==
          root.fields[field]!.type,
      )
    ) {
      add(
        `index "${name}" eq must start with the key of "${index.root.model}"`,
      );
    }
  }
  if (definition.kind === "table") {
    for (const [name, derived] of Object.entries(definition.derived)) {
      if (typeof derived.compute !== "function") {
        add(`derived field "${name}" has no compute function`);
      }
      if (derived.multi && derived.type === "json") {
        add(`derived field "${name}" cannot be multi-valued json`);
      }
    }
    for (const [name, { type, references }] of Object.entries(
      definition.fields,
    )) {
      if (references === undefined) continue;
      const target = table(references.model);
      const targetKey =
        target?.key.length === 1 ? target.fields[target.key[0]!] : undefined;
      if (targetKey === undefined) {
        add(
          `field "${name}" references "${references.model}", which is not a single-key table of this module`,
        );
      } else if (targetKey.type !== type) {
        add(
          `field "${name}" and the key of "${references.model}" differ in type`,
        );
      }
      if (
        references.onDelete === "cascade" &&
        !Object.values(definition.indexes).some(
          ({ eq }) => eq.length === 1 && eq[0] === name,
        )
      ) {
        add(
          `cascade on "${name}" needs an index whose eq is exactly [${name}]`,
        );
      }
    }
    return problems;
  }
  const identity = Object.keys(definition.fields);
  if (key.join("\u0000") !== identity.join("\u0000")) {
    add(
      `key must list the identity fields in declaration order: ${identity.join(", ")}`,
    );
  }
  if (metricsOf(definition).length === 0) add("aggregate has no metrics");
  if (
    definition.distinct.length > 0 &&
    definition.counters.length + definition.gauges.length > 0
  ) {
    add("distinct sketches need an aggregate of their own");
  }
  const { shards } = definition;
  if (!Number.isSafeInteger(shards) || shards < 1 || shards > MAX_SHARDS) {
    add(`shards must be 1–${MAX_SHARDS}`);
  }
  return problems;
};

/** Rejects invalid module schemas at startup, listing every problem. */
export const validateSchema = (modules: readonly SchemaModule[]): void => {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  for (const module of modules) {
    for (const [model, definition] of Object.entries(module.schema)) {
      const name = tableName(module, model);
      const owner = owners.get(name);
      if (owner !== undefined) {
        problems.push(
          `${module.id}.${model}: table "${name}" is also declared by ${owner}`,
        );
      }
      owners.set(name, `${module.id}.${model}`);
      problems.push(...problemsOf(module, model, definition));
    }
  }
  if (problems.length > 0) {
    throw new DatabaseSchemaError(
      `Invalid database schema:\n- ${problems.join("\n- ")}`,
    );
  }
};

const indexesOf = (definition: ModelShape): PhysicalIndex[] => [
  ...Object.entries(definition.indexes).map(([name, index]) => ({
    name,
    eq: [...index.eq],
    sort: [...index.sort],
    ...(index.unique ? { unique: true as const } : {}),
  })),
  ...Object.entries(definition.fields).flatMap(([name, field]) =>
    field.unique ? [{ name, eq: [name], sort: [], unique: true as const }] : [],
  ),
];

/** Validates the modules, then resolves them into physical tables with engine columns. */
export const resolveSchema = (
  modules: readonly SchemaModule[],
): ResolvedSchema => {
  validateSchema(modules);
  const references = modules.flatMap((module) =>
    Object.entries(module.schema).flatMap(([model, definition]) =>
      definition.kind !== "table"
        ? []
        : Object.entries(definition.fields).flatMap(
            ([field, value]): ResolvedReference[] => {
              const to = value.references;
              if (to === undefined) return [];
              const table = tableName(module, model);
              const counter = `_refs_${table}_${field}`;
              return [
                {
                  table,
                  field,
                  target: tableName(module, to.model),
                  onDelete: to.onDelete,
                  ...(to.onDelete === "none" ? {} : { counter }),
                },
              ];
            },
          ),
    ),
  );
  const models = new Map<string, ResolvedModel>();
  for (const module of modules) {
    for (const [model, definition] of Object.entries(module.schema)) {
      const name = tableName(module, model);
      const referencedBy = references.filter(({ target }) => target === name);
      const columns: PhysicalColumn[] = Object.entries(definition.fields).map(
        ([field, { type, required, maxLength, ascii }]) => ({
          name: field,
          type,
          nullable: required === false,
          ...(maxLength === undefined ? {} : { maxLength }),
          ...(ascii ? { ascii } : {}),
        }),
      );
      if (definition.kind === "table") {
        for (const [field, { type, multi }] of Object.entries(
          definition.derived,
        )) {
          columns.push({
            name: field,
            type,
            nullable: true,
            ...(multi ? { multi } : {}),
          });
        }
      } else {
        columns.push(
          integer(SHARD_COLUMN),
          ...[...definition.counters, ...definition.gauges].map((metric) =>
            integer(metric),
          ),
          ...definition.distinct.map((metric) => ({
            name: metric,
            type: "string" as const,
            nullable: true,
          })),
        );
      }
      for (const { counter } of referencedBy) {
        if (counter !== undefined) columns.push(integer(counter, true));
      }
      columns.push(integer(DATABASE_VERSION_COLUMN, true));
      models.set(name, {
        module: module.id,
        model,
        definition,
        table: {
          name,
          columns,
          key:
            definition.kind === "aggregate"
              ? [...definition.key, SHARD_COLUMN]
              : [...definition.key],
          indexes: indexesOf(definition),
        },
        references: references.filter(({ table }) => table === name),
        referencedBy,
        roots: new Map(
          Object.entries(definition.indexes).flatMap(([index, { root }]) =>
            root === undefined
              ? []
              : [[index, tableName(module, root.model)] as const],
          ),
        ),
      });
    }
  }
  return { models, tables: [...models.values()].map(({ table }) => table) };
};
