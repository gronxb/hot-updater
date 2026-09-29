import {
  DATABASE_VERSION_COLUMN,
  DatabaseSchemaError,
  type PhysicalColumn,
  type PhysicalColumnType,
  type PhysicalIndex,
  type PhysicalTable,
} from "@hot-updater/plugin-core/internal";

import type {
  AggregateDefinition,
  FieldDefinition,
  FieldType,
  ModelDefinition,
  ModuleSchema,
  ReferenceAction,
  TableDefinition,
} from "./schema";

export const SHARD_COLUMN = "_shard";
export const MAX_SHARDS = 64;

export interface SchemaModule {
  readonly id: string;
  readonly schema: ModuleSchema;
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
  readonly definition: ModelDefinition;
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

const columnType = (type: FieldType): PhysicalColumnType => type;

const tableName = (module: SchemaModule, model: string) =>
  module.namespace ? `${module.namespace}_${model}` : model;

const fieldColumn = (name: string, field: FieldDefinition): PhysicalColumn => ({
  name,
  type: columnType(field.type),
  nullable: field.required === false,
  ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
  ...(field.ascii ? { ascii: true as const } : {}),
});

const integer = (name: string): PhysicalColumn => ({
  name,
  type: "integer",
  nullable: false,
});

const fieldType = (
  model: ModelDefinition,
  name: string,
): { readonly type: FieldType; readonly multi: boolean } | undefined => {
  const field = model.fields[name];
  if (field !== undefined) return { type: field.type, multi: false };
  if (model.kind === "aggregate") return undefined;
  const derived = model.derived[name];
  return derived === undefined
    ? undefined
    : { type: derived.type, multi: derived.multi === true };
};

const metricsOf = (model: AggregateDefinition) => [
  ...model.counters,
  ...model.gauges,
  ...model.distinct,
];

/** Every problem in one module's declarations, as messages. */
const problemsOf = (
  module: SchemaModule,
  model: string,
  definition: ModelDefinition,
): string[] => {
  const problems: string[] = [];
  const at = `${module.id}.${model}`;
  const add = (message: string) => problems.push(`${at}: ${message}`);
  if (!NAME.test(model))
    add("model names use lowercase letters, digits, and _");
  const names = [
    ...Object.keys(definition.fields),
    ...(definition.kind === "table" ? Object.keys(definition.derived) : []),
    ...(definition.kind === "aggregate" ? metricsOf(definition) : []),
  ];
  for (const name of new Set(names)) {
    if (!NAME.test(name)) add(`field "${name}" must match ${NAME.source}`);
    if (names.indexOf(name) !== names.lastIndexOf(name)) {
      add(`field "${name}" is declared twice`);
    }
  }
  const keyFields = definition.key;
  if (keyFields.length === 0) add("key is empty");
  for (const name of keyFields) {
    const field = definition.fields[name];
    if (field === undefined) add(`key field "${name}" is not a declared field`);
    else if (field.required === false) add(`key field "${name}" is nullable`);
    else if (field.type === "json") add(`key field "${name}" is json`);
  }
  if (new Set(keyFields).size !== keyFields.length) add("key repeats a field");
  for (const [name, field] of Object.entries(definition.fields)) {
    if (
      field.maxLength !== undefined &&
      (field.type !== "string" ||
        !Number.isSafeInteger(field.maxLength) ||
        field.maxLength < 1)
    ) {
      add(`field "${name}" has an invalid maxLength`);
    }
    if (field.ascii && field.type !== "string") {
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
    const multi: string[] = [];
    for (const column of columns) {
      const type = fieldType(definition, column);
      if (type === undefined) {
        add(`index "${name}" names undeclared field "${column}"`);
      } else if (type.type === "json") {
        add(`index "${name}" names json field "${column}"`);
      } else if (type.multi) {
        multi.push(column);
        if (index.sort.includes(column)) {
          add(`index "${name}" sorts by multi-valued field "${column}"`);
        }
      }
    }
    if (multi.length > 1)
      add(`index "${name}" has more than one multi-valued field`);
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
  } else {
    const identity = Object.keys(definition.fields);
    if (keyFields.join("\u0000") !== identity.join("\u0000")) {
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
    if (
      !Number.isSafeInteger(definition.shards) ||
      definition.shards < 1 ||
      definition.shards > MAX_SHARDS
    ) {
      add(`shards must be 1–${MAX_SHARDS}`);
    }
  }
  return problems;
};

const problemsAcross = (
  module: SchemaModule,
  model: string,
  definition: ModelDefinition,
): string[] => {
  const problems: string[] = [];
  const add = (message: string) =>
    problems.push(`${module.id}.${model}: ${message}`);
  const table = (name: string): TableDefinition | undefined => {
    const target = module.schema[name];
    return target?.kind === "table" ? target : undefined;
  };
  for (const [name, index] of Object.entries(definition.indexes)) {
    if (index.root === undefined) continue;
    const root = table(index.root.model);
    if (root === undefined) {
      add(`index "${name}" is rooted at unknown table "${index.root.model}"`);
      continue;
    }
    const matches =
      root.key.length <= index.eq.length &&
      root.key.every(
        (field, position) =>
          fieldType(definition, index.eq[position]!)?.type ===
          root.fields[field]!.type,
      );
    if (!matches) {
      add(
        `index "${name}" eq must start with the key of "${index.root.model}"`,
      );
    }
  }
  if (definition.kind === "aggregate") return problems;
  for (const [name, field] of Object.entries(definition.fields)) {
    if (field.references === undefined) continue;
    const target = table(field.references.model);
    const targetKey =
      target?.key.length === 1 ? target.fields[target.key[0]!] : undefined;
    if (target === undefined || targetKey === undefined) {
      add(
        `field "${name}" references "${field.references.model}", which is not a single-key table of this module`,
      );
    } else if (targetKey.type !== field.type) {
      add(
        `field "${name}" and the key of "${field.references.model}" differ in type`,
      );
    }
    if (
      field.references.onDelete === "cascade" &&
      !Object.values(definition.indexes).some(
        (index) => index.eq.length === 1 && index.eq[0] === name,
      )
    ) {
      add(`cascade on "${name}" needs an index whose eq is exactly [${name}]`);
    }
  }
  return problems;
};

/** Rejects invalid module schemas at startup, listing every problem. */
export const validateSchema = (modules: readonly SchemaModule[]): void => {
  const problems: string[] = [];
  const names = new Map<string, string>();
  for (const module of modules) {
    for (const [model, definition] of Object.entries(module.schema)) {
      const name = tableName(module, model);
      const owner = names.get(name);
      if (owner !== undefined) {
        problems.push(
          `${module.id}.${model}: table "${name}" is also declared by ${owner}`,
        );
      }
      names.set(name, `${module.id}.${model}`);
      problems.push(
        ...problemsOf(module, model, definition),
        ...problemsAcross(module, model, definition),
      );
    }
  }
  if (problems.length > 0) {
    throw new DatabaseSchemaError(
      `Invalid database schema:\n- ${problems.join("\n- ")}`,
    );
  }
};

const indexesOf = (definition: ModelDefinition): PhysicalIndex[] => [
  ...Object.entries(definition.indexes).map(([name, index]) => ({
    name,
    eq: [...index.eq],
    sort: [...index.sort],
    ...(index.unique ? { unique: true as const } : {}),
  })),
  ...Object.entries(definition.fields)
    .filter(([, field]) => field.unique)
    .map(([name]) => ({ name, eq: [name], sort: [], unique: true as const })),
];

/** Validates the modules, then resolves them into physical tables with engine columns. */
export const resolveSchema = (
  modules: readonly SchemaModule[],
): ResolvedSchema => {
  validateSchema(modules);
  const references: ResolvedReference[] = [];
  for (const module of modules) {
    for (const [model, definition] of Object.entries(module.schema)) {
      if (definition.kind !== "table") continue;
      for (const [field, value] of Object.entries(definition.fields)) {
        if (value.references === undefined) continue;
        const table = tableName(module, model);
        references.push({
          table,
          field,
          target: tableName(module, value.references.model),
          onDelete: value.references.onDelete,
          ...(value.references.onDelete === "none"
            ? {}
            : { counter: `_refs_${table}_${field}` }),
        });
      }
    }
  }
  const models = new Map<string, ResolvedModel>();
  for (const module of modules) {
    for (const [model, definition] of Object.entries(module.schema)) {
      const name = tableName(module, model);
      const referencedBy = references.filter(
        (reference) => reference.target === name,
      );
      const columns: PhysicalColumn[] = Object.entries(definition.fields).map(
        ([field, value]) => fieldColumn(field, value),
      );
      if (definition.kind === "table") {
        for (const [field, derived] of Object.entries(definition.derived)) {
          columns.push({
            name: field,
            type: columnType(derived.type),
            nullable: true,
            ...(derived.multi ? { multi: true as const } : {}),
          });
        }
      } else {
        columns.push(integer(SHARD_COLUMN));
        for (const metric of [...definition.counters, ...definition.gauges]) {
          columns.push(integer(metric));
        }
        for (const metric of definition.distinct) {
          columns.push({ name: metric, type: "string", nullable: true });
        }
      }
      for (const reference of referencedBy) {
        if (reference.counter !== undefined)
          columns.push({ ...integer(reference.counter), default: 0 });
      }
      columns.push({ ...integer(DATABASE_VERSION_COLUMN), default: 0 });
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
        references: references.filter((reference) => reference.table === name),
        referencedBy,
        roots: new Map(
          Object.entries(definition.indexes).flatMap(([index, value]) =>
            value.root === undefined
              ? []
              : [[index, tableName(module, value.root.model)] as const],
          ),
        ),
      });
    }
  }
  return { models, tables: [...models.values()].map(({ table }) => table) };
};
