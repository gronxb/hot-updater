import type {
  UniversalComponentCheckExpression,
  UniversalComponentColumnSchema,
  UniversalComponentDataAdapter,
  UniversalComponentIndexSchema,
  UniversalComponentRow,
  UniversalComponentScalar,
  UniversalComponentSchema,
  UniversalComponentSchemaVersion,
  UniversalComponentTableSchema,
} from "@hot-updater/plugin-core";
import {
  getUniversalComponentLatestSchema,
  getUniversalComponentSchemaMarkerKey,
  getUniversalComponentSchemaVersion,
  getUniversalComponentTable,
  isUniversalComponentDataValue,
  resolveUniversalComponentMigrationState,
  UniversalComponentDataStateNotReadyError,
  UniversalComponentSchemaNotReadyError,
  validateUniversalComponentAppend,
  validateUniversalComponentOrderedScan,
  validateUniversalComponentRow,
} from "@hot-updater/plugin-core";
import { sql, type Kysely, type RawBuilder } from "kysely";

import type { Database } from "./types";

const settingsTable = "private_hot_updater_settings";
const validationPageSize = 1_000;

const quoted = (identifier: string): string => `"${identifier}"`;

const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const postgresLiteral = (
  column: UniversalComponentColumnSchema,
  value: boolean | number | string,
): string => {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return column.type === "float"
      ? `${String(value)}::double precision`
      : String(value);
  }
  const literal = sqlLiteral(value);
  return column.type === "uuid" ? `${literal}::uuid` : `${literal}::text`;
};

const checkExpressionSql = (
  expression: UniversalComponentCheckExpression,
  columns: ReadonlyMap<string, UniversalComponentColumnSchema>,
  parent?: "all" | "any",
): string => {
  if (expression.op === "all" || expression.op === "any") {
    const operator = expression.op === "all" ? " AND " : " OR ";
    const rendered = expression.expressions
      .map((item) => checkExpressionSql(item, columns, expression.op))
      .join(operator);
    return parent === "all" && expression.op === "any"
      ? `(${rendered})`
      : rendered;
  }
  if (!("column" in expression)) {
    throw new TypeError("Invalid universal component check expression");
  }
  const column = columns.get(expression.column)!;
  const name = quoted(column.name);
  switch (expression.op) {
    case "eq":
      return `${name} = ${postgresLiteral(column, expression.value)}`;
    case "in":
      return `${parent === undefined ? "" : "("}${name} = ANY (ARRAY[${expression.values
        .map((value) => postgresLiteral(column, value))
        .join(", ")}])${parent === undefined ? "" : ")"}`;
    case "gte":
      return `${name} >= ${postgresLiteral(column, expression.value)}`;
    case "lte":
      return `${name} <= ${postgresLiteral(column, expression.value)}`;
    case "integer":
      return column.type === "integer"
        ? `trunc(${name}::double precision) = ${name}::double precision`
        : `trunc(${name}) = ${name}`;
    case "is-not-null":
      return `${name} IS NOT NULL`;
    case "is-null":
      return `${name} IS NULL`;
    case "non-empty":
      return column.type === "uuid"
        ? `char_length(${name}::text) > 0`
        : `char_length(${name}) > 0`;
  }
};

const checkSql = (
  table: UniversalComponentTableSchema,
  check: NonNullable<UniversalComponentTableSchema["checks"]>[number],
): string => {
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  return `CONSTRAINT ${quoted(check.name)} CHECK (${checkExpressionSql(check.expression, columns)})`;
};

const expectedCheckDefinition = (
  table: UniversalComponentTableSchema,
  check: NonNullable<UniversalComponentTableSchema["checks"]>[number],
): string => {
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  return `CHECK (${checkExpressionSql(check.expression, columns)})`;
};

const columnSql = (column: UniversalComponentColumnSchema): string => {
  const type =
    column.type === "boolean"
      ? "boolean"
      : column.type === "float"
        ? "double precision"
        : column.type === "integer"
          ? "bigint"
          : column.type === "json"
            ? "jsonb"
            : column.type === "uuid"
              ? "uuid"
              : "text";
  return [
    quoted(column.name),
    type,
    column.primaryKey ? "PRIMARY KEY" : undefined,
    column.nullable ? undefined : "NOT NULL",
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
};

const storageChecks = (table: UniversalComponentTableSchema) =>
  (table.checks ?? []).filter(
    ({ enforcement }) => enforcement !== "validation",
  );

const createVersionStatements = (
  version: UniversalComponentSchemaVersion,
): readonly string[] => {
  const statements: string[] = [];
  for (const table of version.tables) {
    statements.push(
      `CREATE TABLE ${quoted(table.name)} (${[
        ...table.columns.map(columnSql),
        ...storageChecks(table).map((check) => checkSql(table, check)),
      ].join(", ")})`,
    );
    for (const index of table.indexes ?? []) {
      statements.push(createIndexStatement(table, index));
    }
  }
  return statements;
};

const createIndexStatement = (
  table: UniversalComponentTableSchema,
  index: UniversalComponentIndexSchema,
): string =>
  `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoted(index.name)} ON ${quoted(table.name)} (${index.columns.map(quoted).join(", ")})`;

const markerStatement = (
  schema: UniversalComponentSchema,
  version: string,
): string =>
  `INSERT INTO ${settingsTable} (key, value) VALUES (${sqlLiteral(getUniversalComponentSchemaMarkerKey(schema))}, ${sqlLiteral(version)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

type PostgresColumn = {
  readonly default_definition: string | null;
  readonly generated: string;
  readonly identity: string;
  readonly name: string;
  readonly not_null: boolean;
  readonly primary_key: boolean;
  readonly type: string;
};

type PostgresIndex = {
  readonly columns: string[];
  readonly has_expressions: boolean;
  readonly included_columns: number;
  readonly is_live: boolean;
  readonly is_partial: boolean;
  readonly is_ready: boolean;
  readonly is_unique: boolean;
  readonly is_valid: boolean;
  readonly method: string;
  readonly name: string;
  readonly options: string;
  readonly opclasses_default: boolean;
};

type PostgresCheck = {
  readonly definition: string;
  readonly is_valid: boolean;
  readonly name: string;
};

type PostgresUnexpectedConstraint = {
  readonly name: string;
  readonly type: string;
};

type PostgresPrimaryKey = {
  readonly definition: string;
  readonly is_deferred: boolean;
  readonly is_deferrable: boolean;
  readonly is_valid: boolean;
  readonly name: string;
};

const expectedPostgresType = (
  column: UniversalComponentColumnSchema,
): string => {
  switch (column.type) {
    case "boolean":
      return "boolean";
    case "float":
      return "double precision";
    case "integer":
      return "bigint";
    case "json":
      return "jsonb";
    case "string":
      return "text";
    case "uuid":
      return "uuid";
  }
};

const normalizeCheckDefinition = (definition: string): string =>
  definition
    .split(/('(?:''|[^'])*')/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.toLowerCase().replaceAll(/[\s"]/g, ""),
    )
    .join("");

const tableColumns = async (
  db: Kysely<Database>,
  table: string,
): Promise<readonly PostgresColumn[]> =>
  (
    await sql<PostgresColumn>`
      SELECT
        attribute.attname AS name,
        attribute.attidentity AS identity,
        attribute.attgenerated AS generated,
        CASE
          WHEN default_definition.oid IS NULL THEN NULL
          ELSE pg_catalog.pg_get_expr(
            default_definition.adbin,
            default_definition.adrelid,
            true
          )
        END AS default_definition,
        pg_catalog.format_type(
          attribute.atttypid,
          attribute.atttypmod
        ) AS type,
        attribute.attnotnull AS not_null,
        COALESCE(
          primary_index.indisprimary
            AND attribute.attnum = ANY(primary_index.indkey),
          false
        ) AS primary_key
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
      LEFT JOIN pg_catalog.pg_index AS primary_index
        ON primary_index.indrelid = relation.oid
        AND primary_index.indisprimary
      LEFT JOIN pg_catalog.pg_attrdef AS default_definition
        ON default_definition.adrelid = relation.oid
        AND default_definition.adnum = attribute.attnum
      WHERE namespace.nspname = current_schema()
        AND relation.relname = ${table}
        AND relation.relkind IN ('r', 'p')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    `.execute(db)
  ).rows;

const tableIndexes = async (
  db: Kysely<Database>,
  table: string,
): Promise<readonly PostgresIndex[]> =>
  (
    await sql<PostgresIndex>`
      SELECT
        index_relation.relname AS name,
        index_definition.indisunique AS is_unique,
        index_definition.indisvalid AS is_valid,
        index_definition.indisready AS is_ready,
        index_definition.indislive AS is_live,
        index_definition.indpred IS NOT NULL AS is_partial,
        index_definition.indexprs IS NOT NULL AS has_expressions,
        index_definition.indnatts - index_definition.indnkeyatts
          AS included_columns,
        index_definition.indoption::text AS options,
        access_method.amname AS method,
        NOT EXISTS (
          SELECT 1
          FROM unnest(index_definition.indclass::oid[])
            AS index_class(oid)
          JOIN pg_catalog.pg_opclass AS operator_class
            ON operator_class.oid = index_class.oid
          WHERE NOT operator_class.opcdefault
        ) AS opclasses_default,
        array_agg(
          attribute.attname
          ORDER BY index_column.ordinality
        ) AS columns
      FROM pg_catalog.pg_class AS table_relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = table_relation.relnamespace
      JOIN pg_catalog.pg_index AS index_definition
        ON index_definition.indrelid = table_relation.oid
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_definition.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      JOIN LATERAL unnest(index_definition.indkey)
        WITH ORDINALITY AS index_column(attnum, ordinality)
        ON true
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = table_relation.oid
        AND attribute.attnum = index_column.attnum
      WHERE namespace.nspname = current_schema()
        AND table_relation.relname = ${table}
        AND NOT index_definition.indisprimary
      GROUP BY
        index_relation.relname,
        index_definition.indisunique,
        index_definition.indisvalid,
        index_definition.indisready,
        index_definition.indislive,
        index_definition.indpred,
        index_definition.indexprs,
        index_definition.indnatts,
        index_definition.indnkeyatts,
        index_definition.indoption,
        index_definition.indclass,
        access_method.amname
    `.execute(db)
  ).rows;

const tablePrimaryKeys = async (
  db: Kysely<Database>,
  table: string,
): Promise<readonly PostgresPrimaryKey[]> =>
  (
    await sql<PostgresPrimaryKey>`
      SELECT
        constraint_definition.conname AS name,
        pg_catalog.pg_get_constraintdef(
          constraint_definition.oid,
          true
        ) AS definition,
        constraint_definition.convalidated AS is_valid,
        constraint_definition.condeferrable AS is_deferrable,
        constraint_definition.condeferred AS is_deferred
      FROM pg_catalog.pg_constraint AS constraint_definition
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = constraint_definition.conrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relname = ${table}
        AND constraint_definition.contype = 'p'
    `.execute(db)
  ).rows;

const tableChecks = async (
  db: Kysely<Database>,
  table: string,
): Promise<readonly PostgresCheck[]> =>
  (
    await sql<PostgresCheck>`
      SELECT
        constraint_definition.conname AS name,
        pg_catalog.pg_get_constraintdef(
          constraint_definition.oid,
          true
        ) AS definition,
        constraint_definition.convalidated AS is_valid
      FROM pg_catalog.pg_constraint AS constraint_definition
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = constraint_definition.conrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relname = ${table}
        AND constraint_definition.contype = 'c'
      ORDER BY constraint_definition.conname
    `.execute(db)
  ).rows;

const unexpectedTableConstraints = async (
  db: Kysely<Database>,
  table: string,
): Promise<readonly PostgresUnexpectedConstraint[]> =>
  (
    await sql<PostgresUnexpectedConstraint>`
      SELECT
        constraint_definition.conname AS name,
        constraint_definition.contype AS type
      FROM pg_catalog.pg_constraint AS constraint_definition
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = constraint_definition.conrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relname = ${table}
        AND constraint_definition.contype NOT IN ('c', 'p')
      ORDER BY constraint_definition.conname
    `.execute(db)
  ).rows;

const physicalSchemaMismatch = async (
  db: Kysely<Database>,
  version: UniversalComponentSchemaVersion,
): Promise<string | null> => {
  for (const table of version.tables) {
    const columns = await tableColumns(db, table.name);
    if (columns.length !== table.columns.length) {
      return `table ${table.name} has ${columns.length} columns; expected ${table.columns.length}`;
    }
    for (const [position, column] of table.columns.entries()) {
      const actual = columns[position];
      if (actual === undefined || actual.name !== column.name) {
        return `table ${table.name} column ${position + 1} is ${actual?.name ?? "missing"}; expected ${column.name}`;
      }
      const expectedType = expectedPostgresType(column);
      if (actual.type !== expectedType) {
        return `column ${table.name}.${column.name} has type ${actual.type}; expected ${expectedType}`;
      }
      const expectedNotNull = column.nullable !== true;
      if (actual.not_null !== expectedNotNull) {
        return `column ${table.name}.${column.name} has not-null=${actual.not_null}; expected ${expectedNotNull}`;
      }
      const expectedPrimaryKey = column.primaryKey === true;
      if (actual.primary_key !== expectedPrimaryKey) {
        return `column ${table.name}.${column.name} has primary-key=${actual.primary_key}; expected ${expectedPrimaryKey}`;
      }
      if (
        actual.identity !== "" ||
        actual.generated !== "" ||
        actual.default_definition !== null
      ) {
        return `column ${table.name}.${column.name} has an unexpected identity, generated expression, or default`;
      }
    }

    const primaryKeys = await tablePrimaryKeys(db, table.name);
    const primaryKeyColumn = table.columns.find((column) => column.primaryKey)!;
    const primaryKey = primaryKeys[0];
    if (
      primaryKeys.length !== 1 ||
      primaryKey === undefined ||
      primaryKey.name !== primaryKeyName(table) ||
      normalizeCheckDefinition(primaryKey.definition) !==
        normalizeCheckDefinition(
          `PRIMARY KEY (${quoted(primaryKeyColumn.name)})`,
        ) ||
      !primaryKey.is_valid ||
      primaryKey.is_deferrable ||
      primaryKey.is_deferred
    ) {
      return `table ${table.name} primary key does not match its declaration`;
    }

    const indexes = await tableIndexes(db, table.name);
    const expectedIndexes = table.indexes ?? [];
    if (indexes.length !== expectedIndexes.length) {
      const missing = expectedIndexes.find(
        ({ name }) => !indexes.some((candidate) => candidate.name === name),
      );
      return missing === undefined
        ? `table ${table.name} has unexpected indexes`
        : `table ${table.name} is missing index ${missing.name}`;
    }
    for (const index of expectedIndexes) {
      const actual = indexes.find((candidate) => candidate.name === index.name);
      if (
        actual === undefined ||
        actual.is_unique !== (index.unique === true) ||
        !actual.is_valid ||
        !actual.is_ready ||
        !actual.is_live ||
        actual.is_partial ||
        actual.has_expressions ||
        actual.included_columns !== 0 ||
        actual.options.split(" ").some((option) => option !== "0") ||
        !actual.opclasses_default ||
        actual.method !== "btree" ||
        actual.columns.length !== index.columns.length ||
        actual.columns.some(
          (column, position) => column !== index.columns[position],
        )
      ) {
        return `index ${index.name} does not match its declaration`;
      }
    }

    const checks = await tableChecks(db, table.name);
    const expectedChecks = storageChecks(table);
    if (checks.length !== expectedChecks.length) {
      return `table ${table.name} checks do not match its declaration`;
    }
    for (const check of expectedChecks) {
      const actual = checks.find((candidate) => candidate.name === check.name);
      if (
        actual === undefined ||
        !actual.is_valid ||
        normalizeCheckDefinition(actual.definition) !==
          normalizeCheckDefinition(expectedCheckDefinition(table, check))
      ) {
        return `check ${check.name} does not match its declaration`;
      }
    }
    const unexpectedConstraints = await unexpectedTableConstraints(
      db,
      table.name,
    );
    if (unexpectedConstraints.length > 0) {
      return `table ${table.name} has unexpected constraint ${unexpectedConstraints[0]!.name}`;
    }
  }
  return null;
};

class PostgresUniversalComponentSchemaDriftError extends TypeError {
  readonly name = "PostgresUniversalComponentSchemaDriftError";

  constructor(
    componentId: string,
    detail: string,
    readonly reason: "index" | "physical-schema",
  ) {
    super(
      `Postgres physical schema for component ${componentId} is incompatible: ${detail}`,
    );
  }
}

class PostgresUniversalComponentStoredDataError extends TypeError {
  readonly name = "PostgresUniversalComponentStoredDataError";

  constructor(componentId: string, cause: unknown) {
    super(
      `Postgres stored data for component ${componentId} is incompatible: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

const schemaDrift = (
  schema: UniversalComponentSchema,
  message: string,
): never => {
  throw new PostgresUniversalComponentSchemaDriftError(
    schema.id,
    message,
    message.includes("index") ? "index" : "physical-schema",
  );
};

const assertPhysicalSchema = async (
  db: Kysely<Database>,
  schema: UniversalComponentSchema,
  version = getUniversalComponentLatestSchema(schema).version,
): Promise<void> => {
  const mismatch = await physicalSchemaMismatch(
    db,
    getUniversalComponentSchemaVersion(schema, version),
  );
  if (mismatch !== null) schemaDrift(schema, mismatch);
};

const hasAnyComponentTable = async (
  db: Kysely<Database>,
  schema: UniversalComponentSchema,
): Promise<boolean> => {
  const tableNames = new Set(
    schema.versions.flatMap((version) =>
      version.tables.map((table) => table.name),
    ),
  );
  for (const table of tableNames) {
    const result = await sql<{ readonly present: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = current_schema()
          AND relation.relname = ${table}
          AND relation.relkind IN ('r', 'p')
      ) AS present
    `.execute(db);
    if (result.rows[0]?.present === true) return true;
  }
  return false;
};

const inspectPhysicalVersion = async (
  db: Kysely<Database>,
  schema: UniversalComponentSchema,
): Promise<string | null> => {
  if (!(await hasAnyComponentTable(db, schema))) return null;
  for (const version of [...schema.versions].reverse()) {
    if ((await physicalSchemaMismatch(db, version)) === null) {
      return version.version;
    }
  }
  const latest = getUniversalComponentLatestSchema(schema);
  return schemaDrift(
    schema,
    (await physicalSchemaMismatch(db, latest)) ??
      "physical state does not match a declared version",
  );
};

const valueExpression = (
  column: UniversalComponentColumnSchema,
  value: unknown,
): RawBuilder<unknown> =>
  column.type === "json" && value !== null
    ? sql`${JSON.stringify(value)}::jsonb`
    : sql`${value}`;

const parseValue = (
  column: UniversalComponentColumnSchema,
  value: unknown,
): UniversalComponentRow[string] => {
  if (value === null && column.nullable) return null;
  switch (column.type) {
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "float":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      break;
    case "integer": {
      const numberValue = typeof value === "string" ? Number(value) : value;
      if (
        typeof numberValue === "number" &&
        Number.isSafeInteger(numberValue)
      ) {
        return numberValue;
      }
      break;
    }
    case "json":
      if (isUniversalComponentDataValue(value)) return value;
      break;
    case "string":
    case "uuid":
      if (typeof value === "string") return value;
      break;
  }
  throw new TypeError(`Invalid stored value for column ${column.name}`);
};

const parseRow = (
  table: UniversalComponentTableSchema,
  value: unknown,
): UniversalComponentRow => {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      `Invalid stored row for universal component table ${table.name}`,
    );
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    table.columns.map((column) => [
      column.name,
      parseValue(column, record[column.name]),
    ]),
  );
};

const validateStoredRows = async (
  db: Kysely<Database>,
  schema: UniversalComponentSchema,
  version: string,
): Promise<void> => {
  for (const table of getUniversalComponentSchemaVersion(schema, version)
    .tables) {
    const primaryKey = table.columns.find((column) => column.primaryKey)!;
    let cursor: string | undefined;
    while (true) {
      const result = await sql<unknown>`
        SELECT ${sql.join(table.columns.map((column) => sql.ref(column.name)))}
        FROM ${sql.table(table.name)}
        ${
          cursor === undefined
            ? sql``
            : sql`WHERE ${sql.ref(primaryKey.name)} > ${cursor}`
        }
        ORDER BY ${sql.ref(primaryKey.name)} ASC
        LIMIT ${validationPageSize}
      `.execute(db);
      const rows: UniversalComponentRow[] = [];
      for (const storedRow of result.rows) {
        try {
          const row = parseRow(table, storedRow);
          validateUniversalComponentRow(schema, {
            row,
            table: table.name,
            version,
          });
          rows.push(row);
        } catch (error) {
          throw new PostgresUniversalComponentStoredDataError(schema.id, error);
        }
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < validationPageSize) break;
      cursor = last[primaryKey.name] as string;
    }
  }
};

const combine = (
  expressions: readonly RawBuilder<boolean>[],
  operator: "and" | "or",
): RawBuilder<boolean> =>
  sql<boolean>`(${sql.join(expressions, sql.raw(` ${operator} `))})`;

const lexicographicPredicate = (
  columns: readonly string[],
  values: readonly UniversalComponentScalar[],
  operator: ">" | "<",
): RawBuilder<boolean> =>
  combine(
    values.map((value, index) =>
      combine(
        [
          ...columns
            .slice(0, index)
            .map(
              (column, equalIndex) =>
                sql<boolean>`${sql.ref(column)} = ${values[equalIndex]}`,
            ),
          operator === ">"
            ? sql<boolean>`${sql.ref(columns[index]!)} > ${value}`
            : sql<boolean>`${sql.ref(columns[index]!)} < ${value}`,
        ],
        "and",
      ),
    ),
    "or",
  );

const settingValue = async (
  db: Kysely<Database>,
  key: string,
): Promise<string | null> => {
  const result = await sql<{ readonly value: unknown }>`
    SELECT value
    FROM ${sql.table(settingsTable)}
    WHERE key = ${key}
    LIMIT 1
  `.execute(db);
  const value = result.rows[0]?.value;
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(`Invalid universal component setting: ${key}`);
  }
  return value;
};

const markerVersion = (
  db: Kysely<Database>,
  schema: UniversalComponentSchema,
): Promise<string | null> =>
  settingValue(db, getUniversalComponentSchemaMarkerKey(schema));

const sameDefinition = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const applyTransition = async (
  db: Kysely<Database>,
  schema: UniversalComponentSchema,
  previous: UniversalComponentSchemaVersion,
  next: UniversalComponentSchemaVersion,
): Promise<void> => {
  await validateStoredRows(db, schema, next.version);
  for (const [tableIndex, table] of next.tables.entries()) {
    const oldTable = previous.tables[tableIndex]!;
    const oldChecks = new Map(
      storageChecks(oldTable).map((check) => [check.name, check]),
    );
    const nextChecks = new Map(
      storageChecks(table).map((check) => [check.name, check]),
    );
    for (const check of storageChecks(oldTable)) {
      const replacement = nextChecks.get(check.name);
      if (replacement === undefined || !sameDefinition(check, replacement)) {
        await sql
          .raw(
            `ALTER TABLE ${quoted(table.name)} DROP CONSTRAINT ${quoted(check.name)}`,
          )
          .execute(db);
      }
    }
    for (const [columnIndex, column] of table.columns.entries()) {
      const oldColumn = oldTable.columns[columnIndex]!;
      if (oldColumn.nullable !== column.nullable) {
        await sql
          .raw(
            `ALTER TABLE ${quoted(table.name)} ALTER COLUMN ${quoted(column.name)} ${column.nullable ? "DROP" : "SET"} NOT NULL`,
          )
          .execute(db);
      }
    }
    for (const check of storageChecks(table)) {
      const oldCheck = oldChecks.get(check.name);
      if (oldCheck === undefined || !sameDefinition(oldCheck, check)) {
        await sql
          .raw(
            `ALTER TABLE ${quoted(table.name)} ADD ${checkSql(table, check)} NOT VALID`,
          )
          .execute(db);
        await sql
          .raw(
            `ALTER TABLE ${quoted(table.name)} VALIDATE CONSTRAINT ${quoted(check.name)}`,
          )
          .execute(db);
      }
    }

    const oldIndexes = new Map(
      (oldTable.indexes ?? []).map((index) => [index.name, index]),
    );
    const nextIndexes = new Map(
      (table.indexes ?? []).map((index) => [index.name, index]),
    );
    for (const index of oldTable.indexes ?? []) {
      const replacement = nextIndexes.get(index.name);
      if (replacement === undefined || !sameDefinition(index, replacement)) {
        await sql.raw(`DROP INDEX ${quoted(index.name)}`).execute(db);
      }
    }
    for (const index of table.indexes ?? []) {
      const oldIndex = oldIndexes.get(index.name);
      if (oldIndex === undefined || !sameDefinition(oldIndex, index)) {
        await sql.raw(createIndexStatement(table, index)).execute(db);
      }
    }
  }
  await assertPhysicalSchema(db, schema, next.version);
};

const advanceToLatest = async (
  db: Kysely<Database>,
  schema: UniversalComponentSchema,
  fromVersion: string,
): Promise<void> => {
  const fromIndex = schema.versions.findIndex(
    ({ version }) => version === fromVersion,
  );
  if (fromIndex < 0) {
    throw new UniversalComponentSchemaNotReadyError(
      schema.id,
      getUniversalComponentLatestSchema(schema).version,
      fromVersion,
    );
  }
  for (let index = fromIndex + 1; index < schema.versions.length; index += 1) {
    await applyTransition(
      db,
      schema,
      schema.versions[index - 1]!,
      schema.versions[index]!,
    );
  }
};

const artifactColumnSql = (column: UniversalComponentColumnSchema): string =>
  [
    quoted(column.name),
    expectedPostgresType(column),
    column.nullable ? undefined : "NOT NULL",
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");

const primaryKeyName = (table: UniversalComponentTableSchema): string =>
  `${table.name}_pkey`;

const artifactTableDefinitionSql = (
  table: UniversalComponentTableSchema,
): string => {
  const primaryKey = table.columns.find((column) => column.primaryKey)!;
  return [
    ...table.columns.map(artifactColumnSql),
    `CONSTRAINT ${quoted(primaryKeyName(table))} PRIMARY KEY (${quoted(primaryKey.name)})`,
    ...storageChecks(table).map((check) => checkSql(table, check)),
  ].join(",\n        ");
};

const artifactCreateTableStatement = (
  table: UniversalComponentTableSchema,
  name = table.name,
  temporary = false,
): string =>
  `CREATE ${temporary ? "TEMP " : ""}TABLE ${quoted(name)} (\n        ${artifactTableDefinitionSql(table)}\n      )${temporary ? " ON COMMIT DROP" : ""}`;

const artifactRelationSql = (relation: string): string =>
  relation.startsWith("pg_temp.")
    ? sqlLiteral(relation)
    : `pg_catalog.format('%I.%I', target_schema, ${sqlLiteral(relation)})`;

const artifactSettingsValidation = (
  schema: UniversalComponentSchema,
): string => `IF NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS settings_relation
          JOIN pg_catalog.pg_namespace AS settings_namespace
            ON settings_namespace.oid = settings_relation.relnamespace
          WHERE settings_namespace.nspname = target_schema
            AND settings_relation.relname = ${sqlLiteral(settingsTable)}
            AND settings_relation.relkind IN ('r', 'p')
            AND (
              SELECT count(*)
              FROM pg_catalog.pg_attribute AS settings_column
              WHERE settings_column.attrelid = settings_relation.oid
                AND settings_column.attnum > 0
                AND NOT settings_column.attisdropped
            ) = 2
            AND EXISTS (
              SELECT 1
              FROM pg_catalog.pg_attribute AS key_column
              WHERE key_column.attrelid = settings_relation.oid
                AND key_column.attname = 'key'
                AND key_column.attnotnull
                AND key_column.atttypid IN (
                  'text'::regtype,
                  'character varying'::regtype
                )
            )
            AND EXISTS (
              SELECT 1
              FROM pg_catalog.pg_attribute AS value_column
              WHERE value_column.attrelid = settings_relation.oid
                AND value_column.attname = 'value'
                AND value_column.attnotnull
                AND value_column.atttypid = 'text'::regtype
            )
            AND EXISTS (
              SELECT 1
              FROM pg_catalog.pg_index AS key_index
              JOIN pg_catalog.pg_attribute AS indexed_column
                ON indexed_column.attrelid = settings_relation.oid
                AND indexed_column.attnum = ANY(key_index.indkey)
              WHERE key_index.indrelid = settings_relation.oid
                AND indexed_column.attname = 'key'
                AND key_index.indisunique
                AND key_index.indisvalid
                AND key_index.indisready
                AND key_index.indislive
                AND key_index.indpred IS NULL
                AND key_index.indexprs IS NULL
                AND key_index.indnkeyatts = 1
                AND key_index.indnatts = 1
                AND NOT EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_constraint AS key_constraint
                  WHERE key_constraint.conindid = key_index.indexrelid
                    AND key_constraint.condeferrable
                )
            )
        ) THEN
          RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} found an incompatible Hot Updater settings table.`)};
        END IF`;

const artifactColumnCatalogSql = (relation: string): string => `(
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_array(
                attribute.attname,
                pg_catalog.format_type(
                  attribute.atttypid,
                  attribute.atttypmod
                ),
                attribute.attnotnull,
                COALESCE(
                  primary_index.indisprimary
                    AND attribute.attnum = ANY(primary_index.indkey),
                  false
                ),
                attribute.attidentity,
                attribute.attgenerated,
                CASE
                  WHEN default_definition.oid IS NULL THEN NULL
                  ELSE pg_catalog.pg_get_expr(
                    default_definition.adbin,
                    default_definition.adrelid,
                    true
                  )
                END
              )
              ORDER BY attribute.attnum
            ),
            '[]'::jsonb
          )
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
          LEFT JOIN pg_catalog.pg_index AS primary_index
            ON primary_index.indrelid = relation.oid
            AND primary_index.indisprimary
          LEFT JOIN pg_catalog.pg_attrdef AS default_definition
            ON default_definition.adrelid = relation.oid
            AND default_definition.adnum = attribute.attnum
          WHERE relation.oid = to_regclass(${artifactRelationSql(relation)})
            AND relation.relkind IN ('r', 'p')
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )`;

const artifactConstraintCatalogSql = (relation: string): string => `(
          SELECT COALESCE(
            jsonb_agg(
              jsonb_build_array(
                constraint_definition.conname,
                constraint_definition.contype,
                pg_catalog.pg_get_constraintdef(
                  constraint_definition.oid,
                  true
                ),
                constraint_definition.convalidated,
                constraint_definition.condeferrable,
                constraint_definition.condeferred
              )
              ORDER BY constraint_definition.conname
            ),
            '[]'::jsonb
          )
          FROM pg_catalog.pg_constraint AS constraint_definition
          WHERE constraint_definition.conrelid =
            to_regclass(${artifactRelationSql(relation)})
        )`;

const artifactIndexCatalogSql = (relation: string): string => `(
          SELECT COALESCE(
            jsonb_agg(catalog.entry ORDER BY catalog.entry ->> 'name'),
            '[]'::jsonb
          )
          FROM (
            SELECT jsonb_build_object(
              'columns', COALESCE((
                SELECT jsonb_agg(
                  attribute.attname
                  ORDER BY index_column.ordinality
                )
                FROM unnest(index_definition.indkey::smallint[])
                  WITH ORDINALITY AS index_column(attnum, ordinality)
                JOIN pg_catalog.pg_attribute AS attribute
                  ON attribute.attrelid = table_relation.oid
                  AND attribute.attnum = index_column.attnum
                WHERE index_column.ordinality <=
                  index_definition.indnkeyatts
              ), '[]'::jsonb),
              'has_expressions', index_definition.indexprs IS NOT NULL,
              'has_includes',
                index_definition.indnkeyatts <>
                  index_definition.indnatts,
              'is_live', index_definition.indislive,
              'is_partial', index_definition.indpred IS NOT NULL,
              'is_ready', index_definition.indisready,
              'is_unique', index_definition.indisunique,
              'is_valid', index_definition.indisvalid,
              'method', access_method.amname,
              'name', index_relation.relname,
              'opclasses_default', NOT EXISTS (
                SELECT 1
                FROM unnest(index_definition.indclass::oid[])
                  AS index_class(oid)
                JOIN pg_catalog.pg_opclass AS operator_class
                  ON operator_class.oid = index_class.oid
                WHERE NOT operator_class.opcdefault
              ),
              'options_valid', NOT EXISTS (
                SELECT 1
                FROM unnest(index_definition.indoption::smallint[])
                  AS index_option(value)
                WHERE index_option.value <> 0
              )
            ) AS entry
            FROM pg_catalog.pg_class AS table_relation
            JOIN pg_catalog.pg_index AS index_definition
              ON index_definition.indrelid = table_relation.oid
            JOIN pg_catalog.pg_class AS index_relation
              ON index_relation.oid = index_definition.indexrelid
            JOIN pg_catalog.pg_am AS access_method
              ON access_method.oid = index_relation.relam
            WHERE table_relation.oid = to_regclass(${artifactRelationSql(relation)})
              AND NOT index_definition.indisprimary
          ) AS catalog
        )`;

const artifactExpectedIndexes = (
  table: UniversalComponentTableSchema,
): readonly unknown[] =>
  [...(table.indexes ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((index) => ({
      columns: index.columns,
      has_expressions: false,
      has_includes: false,
      is_live: true,
      is_partial: false,
      is_ready: true,
      is_unique: index.unique === true,
      is_valid: true,
      method: "btree",
      name: index.name,
      opclasses_default: true,
      options_valid: true,
    }));

const artifactExactTablePredicate = (
  table: UniversalComponentTableSchema,
  referenceTable: string,
): string => `(
          to_regclass(${artifactRelationSql(table.name)}) IS NOT NULL
          AND ${artifactColumnCatalogSql(table.name)} =
            ${artifactColumnCatalogSql(`pg_temp.${referenceTable}`)}
          AND ${artifactConstraintCatalogSql(table.name)} =
            ${artifactConstraintCatalogSql(`pg_temp.${referenceTable}`)}
          AND ${artifactIndexCatalogSql(table.name)} =
            ${sqlLiteral(JSON.stringify(artifactExpectedIndexes(table)))}::jsonb
        )`;

const artifactReferenceTableName = (
  versionIndex: number,
  tableIndex: number,
): string => `hot_updater_component_ref_${versionIndex}_${tableIndex}`;

const artifactReferenceBlock = (
  version: UniversalComponentSchemaVersion,
  versionIndex: number,
  target: string,
): readonly string[] => {
  const references = version.tables.map((table, tableIndex) => ({
    name: artifactReferenceTableName(versionIndex, tableIndex),
    table,
  }));
  return [
    ...references.map(({ name, table }) =>
      artifactCreateTableStatement(table, name, true),
    ),
    `${target} := ${references
      .map(({ name, table }) => artifactExactTablePredicate(table, name))
      .join(" AND ")}`,
    ...references.map(({ name }) => `DROP TABLE pg_temp.${quoted(name)}`),
  ];
};

const artifactTransitionStatements = (
  previous: UniversalComponentSchemaVersion,
  next: UniversalComponentSchemaVersion,
): readonly string[] => {
  const statements: string[] = [];
  previous.tables.forEach((previousTable, tableIndex) => {
    const nextTable = next.tables[tableIndex]!;
    const previousChecks = new Map(
      storageChecks(previousTable).map((check) => [check.name, check]),
    );
    const nextChecks = new Map(
      storageChecks(nextTable).map((check) => [check.name, check]),
    );
    const previousIndexes = new Map(
      (previousTable.indexes ?? []).map((index) => [index.name, index]),
    );
    const nextIndexes = new Map(
      (nextTable.indexes ?? []).map((index) => [index.name, index]),
    );

    for (const index of previousIndexes.values()) {
      const replacement = nextIndexes.get(index.name);
      if (replacement === undefined || !sameDefinition(index, replacement)) {
        statements.push(`DROP INDEX ${quoted(index.name)}`);
      }
    }
    for (const check of previousChecks.values()) {
      const replacement = nextChecks.get(check.name);
      if (replacement === undefined || !sameDefinition(check, replacement)) {
        statements.push(
          `ALTER TABLE ${quoted(previousTable.name)} DROP CONSTRAINT ${quoted(check.name)}`,
        );
      }
    }
    previousTable.columns.forEach((previousColumn, columnIndex) => {
      const nextColumn = nextTable.columns[columnIndex]!;
      if (previousColumn.nullable !== nextColumn.nullable) {
        statements.push(
          `ALTER TABLE ${quoted(previousTable.name)} ALTER COLUMN ${quoted(previousColumn.name)} ${nextColumn.nullable ? "DROP" : "SET"} NOT NULL`,
        );
      }
    });
    for (const check of nextChecks.values()) {
      const previousCheck = previousChecks.get(check.name);
      if (
        previousCheck === undefined ||
        !sameDefinition(previousCheck, check)
      ) {
        statements.push(
          `ALTER TABLE ${quoted(nextTable.name)} ADD ${checkSql(nextTable, check)} NOT VALID`,
          `ALTER TABLE ${quoted(nextTable.name)} VALIDATE CONSTRAINT ${quoted(check.name)}`,
        );
      }
    }
    for (const index of nextIndexes.values()) {
      const previousIndex = previousIndexes.get(index.name);
      if (
        previousIndex === undefined ||
        !sameDefinition(previousIndex, index)
      ) {
        statements.push(createIndexStatement(nextTable, index));
      }
    }
  });
  return statements;
};

const artifactStateCondition = (
  expression: string,
  value: string | null,
): string =>
  value === null
    ? `${expression} IS NULL`
    : `${expression} = ${sqlLiteral(value)}`;

const artifactMigrationDecisionSql = (
  schema: UniversalComponentSchema,
): string => {
  const versions = schema.versions.map(({ version }) => version);
  const discriminatorValues = schema.unmarked?.knownValues ?? [null];
  const branches: string[] = [];
  for (const markerVersion of [null, ...versions]) {
    for (const physicalVersion of [null, ...versions]) {
      for (const discriminatorValue of discriminatorValues) {
        const decision = resolveUniversalComponentMigrationState(schema, {
          discriminatorValue,
          markerVersion,
          physicalVersion,
        });
        if (decision.kind === "reject") continue;
        const condition = [
          artifactStateCondition("component_version", markerVersion),
          artifactStateCondition("physical_version", physicalVersion),
          artifactStateCondition("discriminator_value", discriminatorValue),
        ].join(" AND ");
        const action =
          decision.kind === "create"
            ? "should_create := true;"
            : decision.kind === "ready"
              ? `source_version := ${sqlLiteral(decision.version)};`
              : `source_version := ${sqlLiteral(decision.fromVersion)};`;
        branches.push(
          `${branches.length === 0 ? "IF" : "ELSIF"} ${condition} THEN\n          ${action}`,
        );
      }
    }
  }
  return `${branches.join("\n        ")}\n        ELSE\n          RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} migration state is incompatible.`)};\n        END IF`;
};

const artifactRowValidation = (
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
): readonly string[] =>
  version.tables.flatMap((table) => {
    const columns = new Map(
      table.columns.map((column) => [column.name, column]),
    );
    const invalid = [
      ...table.columns.flatMap((column) => {
        const reference = quoted(column.name);
        if (column.type === "integer") {
          return [
            `(${reference} < -9007199254740991 OR ${reference} > 9007199254740991)`,
          ];
        }
        if (column.type === "float") {
          return [
            `(${reference} = 'NaN'::double precision OR ${reference} = 'Infinity'::double precision OR ${reference} = '-Infinity'::double precision)`,
          ];
        }
        if (column.primaryKey && column.type === "string") {
          return [`(${reference} = '' OR position('/' in ${reference}) > 0)`];
        }
        return [];
      }),
      ...(table.checks ?? []).map(
        ({ expression }) =>
          `NOT COALESCE((${checkExpressionSql(expression, columns)}), FALSE)`,
      ),
    ];
    if (invalid.length === 0) return [];
    return [
      `IF EXISTS (SELECT 1 FROM ${quoted(table.name)} WHERE ${invalid.join(" OR ")}) THEN\n          RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} contains invalid rows in ${table.name}@${version.version}.`)};\n        END IF`,
    ];
  });

const artifactStatements = (statements: readonly string[]): string =>
  statements.map((statement) => `        ${statement};`).join("\n");

const artifactMigrationBody = (schema: UniversalComponentSchema): string => {
  const latest = getUniversalComponentLatestSchema(schema);
  const markerKey = getUniversalComponentSchemaMarkerKey(schema);
  const matches = schema.versions.map((_, index) => `matches_${index}`);
  const allAbsent = schema.versions[0]!.tables.map(
    (table) => `to_regclass(${artifactRelationSql(table.name)}) IS NULL`,
  ).join(" AND ");
  const declarations = [
    "target_schema text := current_schema()",
    "component_version text",
    "discriminator_value text",
    "physical_version text",
    "source_version text",
    "should_create boolean := false",
    ...matches.map((name) => `${name} boolean := false`),
  ];
  const statements: string[] = [
    `PERFORM pg_catalog.set_config(
          'search_path',
          pg_catalog.format('%I, pg_catalog, pg_temp', target_schema),
          true
        )`,
    `PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${sqlLiteral(markerKey)}, 0))`,
    `CREATE TABLE IF NOT EXISTS ${quoted(settingsTable)} (
          ${quoted("key")} text NOT NULL,
          ${quoted("value")} text NOT NULL,
          CONSTRAINT ${quoted(`${settingsTable}_pkey`)}
            PRIMARY KEY (${quoted("key")})
        )`,
    artifactSettingsValidation(schema),
    `SELECT value INTO component_version\n        FROM ${quoted(settingsTable)}\n        WHERE key = ${sqlLiteral(markerKey)}\n        LIMIT 1`,
    ...(schema.unmarked === undefined
      ? []
      : [
          `SELECT value INTO discriminator_value\n        FROM ${quoted(settingsTable)}\n        WHERE key = ${sqlLiteral(schema.unmarked.discriminatorKey)}\n        LIMIT 1`,
        ]),
    ...schema.versions.flatMap((version, index) =>
      artifactReferenceBlock(version, index, matches[index]!),
    ),
    `IF ${allAbsent} THEN\n          physical_version := NULL;\n        ELSE\n${[
      ...schema.versions,
    ]
      .reverse()
      .map((version, reverseIndex) => {
        const index = schema.versions.length - reverseIndex - 1;
        return `          ${reverseIndex === 0 ? "IF" : "ELSIF"} ${matches[index]} THEN\n            physical_version := ${sqlLiteral(version.version)};`;
      })
      .join(
        "\n",
      )}\n          ELSE\n            RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} has unsupported physical state.`)};\n          END IF;\n        END IF`,
    artifactMigrationDecisionSql(schema),
    `IF should_create THEN\n${artifactStatements(
      latest.tables.flatMap((table) => [
        artifactCreateTableStatement(table),
        ...(table.indexes ?? []).map((index) =>
          createIndexStatement(table, index),
        ),
      ]),
    )}\n          source_version := ${sqlLiteral(latest.version)};\n        END IF`,
    ...schema.versions.slice(0, -1).map((version, index) => {
      const next = schema.versions[index + 1]!;
      return `IF source_version = ${sqlLiteral(version.version)} THEN\n${artifactStatements(
        [
          ...artifactRowValidation(schema, version),
          ...artifactRowValidation(schema, next),
          ...artifactTransitionStatements(version, next),
        ],
      )}\n          source_version := ${sqlLiteral(next.version)};\n        END IF`;
    }),
    ...artifactReferenceBlock(
      latest,
      schema.versions.length,
      matches[schema.versions.length - 1]!,
    ),
    `IF NOT ${matches[schema.versions.length - 1]} THEN\n          RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} final physical schema validation failed.`)};\n        END IF`,
    ...artifactRowValidation(schema, latest),
    `IF component_version IS DISTINCT FROM ${sqlLiteral(latest.version)} THEN\n          INSERT INTO ${quoted(settingsTable)} (key, value)\n          VALUES (${sqlLiteral(markerKey)}, ${sqlLiteral(latest.version)})\n          ON CONFLICT (key) DO UPDATE\n          SET value = EXCLUDED.value;\n        END IF`,
  ];
  return `DECLARE\n    ${declarations.join(";\n    ")};\nBEGIN\n${artifactStatements(statements)}\nEND`;
};

const artifactDollarTag = (body: string): string => {
  let suffix = 0;
  while (body.includes(`$hot_updater_component_${suffix}$`)) suffix += 1;
  return `$hot_updater_component_${suffix}$`;
};

const migrationArtifact = (schema: UniversalComponentSchema): string => {
  const latest = getUniversalComponentLatestSchema(schema);
  const body = artifactMigrationBody(schema);
  const tag = artifactDollarTag(body);
  return `-- HotUpdater.component-data\n-- component: ${schema.id}\n-- target-version: ${JSON.stringify(latest.version)}\nBEGIN;\n\nDO ${tag}\n${body};\n${tag};\n\nCOMMIT;\n`;
};

export const createPostgresUniversalComponentDataAdapter = (
  db: Kysely<Database>,
): UniversalComponentDataAdapter => {
  const physicallyReady = new WeakMap<UniversalComponentSchema, boolean>();
  return {
    artifacts(schema) {
      const latest = getUniversalComponentLatestSchema(schema);
      return [
        {
          contents: migrationArtifact(schema),
          path: `component-data/${schema.id}/postgres-${encodeURIComponent(latest.version)}.sql`,
          targetVersion: latest.version,
        },
      ];
    },
    bind(schema) {
      const expectedVersion = getUniversalComponentLatestSchema(schema).version;
      const assertReady = async (): Promise<void> => {
        const actualVersion = await markerVersion(db, schema);
        if (actualVersion !== expectedVersion) {
          throw new UniversalComponentSchemaNotReadyError(
            schema.id,
            expectedVersion,
            actualVersion,
          );
        }
        if (physicallyReady.get(schema) === true) return;
        try {
          await assertPhysicalSchema(db, schema);
          await validateStoredRows(db, schema, expectedVersion);
        } catch (error) {
          if (error instanceof PostgresUniversalComponentSchemaDriftError) {
            throw new UniversalComponentDataStateNotReadyError(
              schema.id,
              expectedVersion,
              error.reason,
              { cause: error },
            );
          }
          if (error instanceof PostgresUniversalComponentStoredDataError) {
            throw new UniversalComponentDataStateNotReadyError(
              schema.id,
              expectedVersion,
              "stored-data",
              { cause: error },
            );
          }
          throw error;
        }
        physicallyReady.set(schema, true);
      };
      return {
        schema,
        assertReady,
        async append(input) {
          await assertReady();
          const table = validateUniversalComponentAppend(schema, input);
          await sql`
          INSERT INTO ${sql.table(table.name)}
          (${sql.join(table.columns.map((column) => sql.ref(column.name)))})
          VALUES (${sql.join(
            table.columns.map((column) =>
              valueExpression(column, input.row[column.name]),
            ),
          )})
          `.execute(db);
        },
        async orderedScan(input) {
          await assertReady();
          const scan = validateUniversalComponentOrderedScan(schema, input);
          const table = getUniversalComponentTable(schema, scan.table);
          const predicates = [
            ...(input.afterExclusive === undefined
              ? []
              : [
                  lexicographicPredicate(
                    scan.columns,
                    input.afterExclusive,
                    ">",
                  ),
                ]),
            lexicographicPredicate(
              scan.columns,
              input.beforePrefixExclusive,
              "<",
            ),
          ];
          const result = await sql<UniversalComponentRow>`
          SELECT ${sql.join(
            table.columns.map((column) => sql.ref(column.name)),
          )}
          FROM ${sql.table(table.name)}
          WHERE ${combine(predicates, "and")}
          ORDER BY ${sql.join(
            scan.columns.map((column) => sql`${sql.ref(column)} ASC`),
          )}
          LIMIT ${input.limit}
          `.execute(db);
          return result.rows.slice(0, input.limit).map((row) => {
            try {
              const parsed = parseRow(table, row);
              validateUniversalComponentRow(schema, {
                row: parsed,
                table: table.name,
                version: expectedVersion,
              });
              return parsed;
            } catch (error) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                expectedVersion,
                "stored-data",
                { cause: error },
              );
            }
          });
        },
      };
    },
    async migrate(schema) {
      physicallyReady.delete(schema);
      const latest = getUniversalComponentLatestSchema(schema);
      const expectedVersion = latest.version;
      return db.transaction().execute(async (transaction) => {
        const markerKey = getUniversalComponentSchemaMarkerKey(schema);
        await sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${markerKey}, 0))
      `.execute(transaction);

        const actualVersion = await markerVersion(transaction, schema);
        const physicalVersion = await inspectPhysicalVersion(
          transaction,
          schema,
        );
        const discriminatorValue =
          schema.unmarked === undefined
            ? null
            : await settingValue(transaction, schema.unmarked.discriminatorKey);
        const decision = resolveUniversalComponentMigrationState(schema, {
          discriminatorValue,
          markerVersion: actualVersion,
          physicalVersion,
        });
        if (decision.kind === "reject") {
          return schemaDrift(schema, "migration state is not adoptable");
        }
        if (decision.kind === "ready") {
          await validateStoredRows(transaction, schema, expectedVersion);
          return { changed: false, version: expectedVersion };
        }

        if (decision.kind === "create") {
          for (const statement of createVersionStatements(latest)) {
            await sql.raw(statement).execute(transaction);
          }
        } else {
          await validateStoredRows(transaction, schema, decision.fromVersion);
          if (decision.kind === "migrate") {
            await advanceToLatest(transaction, schema, decision.fromVersion);
          }
        }
        await validateStoredRows(transaction, schema, expectedVersion);
        await assertPhysicalSchema(transaction, schema, expectedVersion);
        await sql
          .raw(markerStatement(schema, expectedVersion))
          .execute(transaction);
        const migratedVersion = await markerVersion(transaction, schema);
        if (migratedVersion !== expectedVersion) {
          throw new UniversalComponentSchemaNotReadyError(
            schema.id,
            expectedVersion,
            migratedVersion,
          );
        }
        return { changed: true, version: expectedVersion };
      });
    },
  };
};
