import type {
  UniversalComponentCheckExpression,
  UniversalComponentColumnSchema,
  UniversalComponentDataAdapter,
  UniversalComponentRow,
  UniversalComponentScalar,
  UniversalComponentSchema,
  UniversalComponentSchemaVersion,
  UniversalComponentTableSchema,
} from "@hot-updater/plugin-core";
import {
  getUniversalComponentLatestSchema,
  getUniversalComponentSchemaMarkerKey,
  getUniversalComponentTable,
  isUniversalComponentDataValue,
  resolveUniversalComponentMigrationState,
  UniversalComponentDataStateNotReadyError,
  UniversalComponentSchemaNotReadyError,
  validateUniversalComponentAppend,
  validateUniversalComponentGet,
  validateUniversalComponentOrderedScan,
  validateUniversalComponentRow,
} from "@hot-updater/plugin-core";

import type { D1Executor } from "./d1Implementation";

type D1Parameter = string;
type D1Statement = {
  readonly params: readonly D1Parameter[];
  readonly sql: string;
};

const settingsTable = "private_hot_updater_settings";

const quoted = (identifier: string): string => `"${identifier}"`;

const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const checkLiteral = (value: boolean | number | string): string => {
  if (typeof value === "boolean") return value ? "1" : "0";
  return typeof value === "number" ? String(value) : sqlLiteral(value);
};

const checkExpressionSql = (
  expression: UniversalComponentCheckExpression,
  nested = false,
): string => {
  switch (expression.op) {
    case "all": {
      const rendered = expression.expressions
        .map((item) => checkExpressionSql(item, true))
        .join(" AND ");
      return nested ? `(${rendered})` : rendered;
    }
    case "any": {
      const rendered = expression.expressions
        .map((item) => checkExpressionSql(item, true))
        .join(" OR ");
      return nested ? `(${rendered})` : rendered;
    }
    case "eq":
      return `${quoted(expression.column)} = ${checkLiteral(expression.value)}`;
    case "in":
      return `${quoted(expression.column)} IN (${expression.values.map(checkLiteral).join(", ")})`;
    case "gte":
      return `${quoted(expression.column)} >= ${String(expression.value)}`;
    case "lte":
      return `${quoted(expression.column)} <= ${String(expression.value)}`;
    case "integer":
      return `typeof(${quoted(expression.column)}) = 'integer'`;
    case "is-not-null":
      return `${quoted(expression.column)} IS NOT NULL`;
    case "is-null":
      return `${quoted(expression.column)} IS NULL`;
    case "non-empty":
      return `length(${quoted(expression.column)}) > 0`;
  }
};

const nullableConstraint = (
  column: UniversalComponentColumnSchema,
  expression: string,
): string =>
  column.nullable
    ? `(${quoted(column.name)} IS NULL OR (${expression}))`
    : expression;

const columnSql = (column: UniversalComponentColumnSchema): string => {
  const type =
    column.type === "integer" || column.type === "boolean"
      ? "INTEGER"
      : column.type === "float"
        ? "REAL"
        : "TEXT";
  const logicalConstraint = (() => {
    switch (column.type) {
      case "boolean":
        return `${quoted(column.name)} IN (0, 1)`;
      case "json":
        return `json_valid(${quoted(column.name)})`;
      case "float":
      case "integer":
      case "string":
      case "uuid":
        return undefined;
    }
  })();
  return [
    quoted(column.name),
    type,
    column.primaryKey ? "PRIMARY KEY" : undefined,
    column.nullable ? undefined : "NOT NULL",
    logicalConstraint === undefined
      ? undefined
      : `CHECK (${nullableConstraint(column, logicalConstraint)})`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
};

const tableBodySql = (table: UniversalComponentTableSchema): string =>
  `(${[
    ...table.columns.map(columnSql),
    ...(table.checks ?? [])
      .filter((check) => check.enforcement !== "validation")
      .map(
        (check) =>
          `CONSTRAINT ${quoted(check.name)} CHECK (${checkExpressionSql(check.expression)})`,
      ),
  ].join(", ")})`;

const createVersionStatements = (
  version: UniversalComponentSchemaVersion,
): readonly D1Statement[] => {
  const statements: D1Statement[] = [];
  for (const table of version.tables) {
    statements.push({
      params: [],
      sql: `CREATE TABLE ${quoted(table.name)} ${tableBodySql(table)}`,
    });
    for (const index of table.indexes ?? []) {
      statements.push({
        params: [],
        sql: `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoted(index.name)} ON ${quoted(table.name)} (${index.columns.map(quoted).join(", ")})`,
      });
    }
  }
  return statements;
};

const markerStatement = (
  schema: UniversalComponentSchema,
  version: string,
): D1Statement => ({
  params: [],
  sql: `INSERT INTO ${settingsTable} (key, value) VALUES (${sqlLiteral(getUniversalComponentSchemaMarkerKey(schema))}, ${sqlLiteral(version)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
});

class D1UniversalComponentSchemaDriftError extends Error {
  readonly name = "D1UniversalComponentSchemaDriftError";

  constructor(
    componentId: string,
    detail: string,
    readonly reason: "index" | "physical-schema" = "physical-schema",
  ) {
    super(`Component ${componentId} has incompatible D1 schema: ${detail}`);
  }
}

class D1UniversalComponentStoredDataError extends Error {
  readonly name = "D1UniversalComponentStoredDataError";

  constructor(componentId: string, cause: unknown) {
    super(
      `Component ${componentId} has invalid D1 stored data: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

const recordValue = (
  value: unknown,
  key: string,
): string | number | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const property = Reflect.get(value, key);
  return typeof property === "string" || typeof property === "number"
    ? property
    : undefined;
};

const physicalColumnType = (
  column: UniversalComponentColumnSchema,
): "INTEGER" | "REAL" | "TEXT" =>
  column.type === "integer" || column.type === "boolean"
    ? "INTEGER"
    : column.type === "float"
      ? "REAL"
      : "TEXT";

const normalizeD1Definition = (value: string): string =>
  value
    .split(/('(?:''|[^'])*')/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replaceAll(/"([a-z_][a-z0-9_]*)"/gi, "$1")
        .replaceAll(/`([a-z_][a-z0-9_]*)`/gi, "$1")
        .replaceAll(/\[([a-z_][a-z0-9_]*)\]/gi, "$1")
        .replaceAll(/\s+/g, " ")
        .replaceAll(/\s*([(),])\s*/g, "$1")
        .toLowerCase();
    })
    .join("")
    .trim();

const validateD1Table = async (
  executor: D1Executor,
  schema: UniversalComponentSchema,
  table: UniversalComponentTableSchema,
): Promise<void> => {
  const actualColumns = await executor.query(
    `PRAGMA table_info(${quoted(table.name)})`,
    [],
  );
  if (actualColumns.length !== table.columns.length) {
    throw new D1UniversalComponentSchemaDriftError(
      schema.id,
      `table ${table.name} columns`,
    );
  }
  for (const [index, column] of table.columns.entries()) {
    const actual = actualColumns[index];
    if (
      recordValue(actual, "name") !== column.name ||
      String(recordValue(actual, "type") ?? "").toUpperCase() !==
        physicalColumnType(column) ||
      recordValue(actual, "notnull") !== (column.nullable ? 0 : 1) ||
      recordValue(actual, "pk") !== (column.primaryKey ? 1 : 0)
    ) {
      throw new D1UniversalComponentSchemaDriftError(
        schema.id,
        `column ${table.name}.${column.name}`,
      );
    }
  }
  const definitionRows = await executor.query(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [table.name],
  );
  const definition = recordValue(definitionRows[0], "sql");
  const bodyStart =
    typeof definition === "string" ? definition.indexOf("(") : -1;
  if (
    typeof definition !== "string" ||
    bodyStart < 0 ||
    normalizeD1Definition(definition.slice(bodyStart)) !==
      normalizeD1Definition(tableBodySql(table))
  ) {
    throw new D1UniversalComponentSchemaDriftError(
      schema.id,
      `table ${table.name} constraints`,
    );
  }
  const triggers = await executor.query(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL",
    [table.name],
  );
  if (triggers.length !== 0) {
    throw new D1UniversalComponentSchemaDriftError(
      schema.id,
      `table ${table.name} triggers`,
    );
  }

  const actualIndexes = await executor.query(
    `PRAGMA index_list(${quoted(table.name)})`,
    [],
  );
  const declaredIndexes = table.indexes ?? [];
  const explicitIndexes = actualIndexes.filter(
    (candidate) => recordValue(candidate, "origin") === "c",
  );
  if (
    explicitIndexes.length !== declaredIndexes.length ||
    explicitIndexes.some(
      (candidate) =>
        !declaredIndexes.some(
          (index) => index.name === recordValue(candidate, "name"),
        ),
    )
  ) {
    throw new D1UniversalComponentSchemaDriftError(
      schema.id,
      `table ${table.name} indexes`,
      "index",
    );
  }
  for (const index of declaredIndexes) {
    const actual = explicitIndexes.find(
      (candidate) => recordValue(candidate, "name") === index.name,
    );
    if (
      actual === undefined ||
      recordValue(actual, "unique") !== (index.unique ? 1 : 0) ||
      recordValue(actual, "partial") !== 0
    ) {
      throw new D1UniversalComponentSchemaDriftError(
        schema.id,
        `index ${index.name}`,
        "index",
      );
    }
    const indexedColumns = await executor.query(
      `PRAGMA index_info(${quoted(index.name)})`,
      [],
    );
    if (
      indexedColumns.length !== index.columns.length ||
      indexedColumns.some(
        (candidate, columnIndex) =>
          recordValue(candidate, "name") !== index.columns[columnIndex],
      )
    ) {
      throw new D1UniversalComponentSchemaDriftError(
        schema.id,
        `index ${index.name} columns`,
        "index",
      );
    }
  }
};

const validateD1Version = async (
  executor: D1Executor,
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
): Promise<void> => {
  for (const table of version.tables) {
    await validateD1Table(executor, schema, table);
  }
};

const inspectD1PhysicalVersion = async (
  executor: D1Executor,
  schema: UniversalComponentSchema,
): Promise<string | null> => {
  const tableNames = schema.versions[0]!.tables.map(({ name }) => name);
  const rows = await executor.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tableNames.map(() => "?").join(", ")})`,
    tableNames,
  );
  if (rows.length === 0) return null;
  if (rows.length !== tableNames.length) {
    throw new D1UniversalComponentSchemaDriftError(
      schema.id,
      "partial component tables",
    );
  }
  let lastDrift: D1UniversalComponentSchemaDriftError | undefined;
  for (const version of [...schema.versions].reverse()) {
    try {
      await validateD1Version(executor, schema, version);
      return version.version;
    } catch (error) {
      if (!(error instanceof D1UniversalComponentSchemaDriftError)) throw error;
      lastDrift = error;
    }
  }
  throw lastDrift!;
};

const encodeRow = (
  table: UniversalComponentTableSchema,
  row: UniversalComponentRow,
): readonly D1Parameter[] =>
  table.columns.map((column) => JSON.stringify(row[column.name]));

const parseValue = (
  column: UniversalComponentColumnSchema,
  value: unknown,
): UniversalComponentRow[string] => {
  if (value === null && column.nullable) return null;
  switch (column.type) {
    case "boolean":
      if (value === 0 || value === 1) return value === 1;
      break;
    case "float":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      break;
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return value;
      }
      break;
    case "json":
      if (typeof value !== "string") break;
      try {
        const parsed: unknown = JSON.parse(value);
        if (isUniversalComponentDataValue(parsed)) return parsed;
        break;
      } catch {
        break;
      }
    case "string":
      if (typeof value === "string") return value;
      break;
    case "uuid":
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
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

const validationPageSize = 500;

const validateStoredRows = async (
  executor: D1Executor,
  schema: UniversalComponentSchema,
  source: UniversalComponentSchemaVersion,
  versions: readonly UniversalComponentSchemaVersion[],
): Promise<void> => {
  for (const sourceTable of source.tables) {
    const primaryKey = sourceTable.columns.find((column) => column.primaryKey)!;
    let after: string | undefined;
    while (true) {
      const storedRows = await executor.query(
        `SELECT ${sourceTable.columns.map((column) => quoted(column.name)).join(", ")} FROM ${quoted(sourceTable.name)}${after === undefined ? "" : ` WHERE ${quoted(primaryKey.name)} > ?`} ORDER BY ${quoted(primaryKey.name)} ASC LIMIT ${validationPageSize}`,
        after === undefined ? [] : [after],
      );
      for (const storedRow of storedRows) {
        try {
          const row = parseRow(sourceTable, storedRow);
          for (const version of versions) {
            validateUniversalComponentRow(schema, {
              row,
              table: sourceTable.name,
              version: version.version,
            });
          }
          after = row[primaryKey.name] as string;
        } catch (error) {
          throw new D1UniversalComponentStoredDataError(schema.id, error);
        }
      }
      if (storedRows.length < validationPageSize) break;
    }
  }
};

const transitionStatements = (
  schema: UniversalComponentSchema,
  target: UniversalComponentSchemaVersion,
): readonly D1Statement[] => {
  const statements: D1Statement[] = [];
  for (const table of target.tables) {
    const temporaryTable = `_hot_updater_${schema.id.replaceAll("-", "_")}_${table.name}_${target.version.replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;
    statements.push(
      { params: [], sql: `DROP TABLE IF EXISTS ${quoted(temporaryTable)}` },
      {
        params: [],
        sql: `CREATE TABLE ${quoted(temporaryTable)} ${tableBodySql(table)}`,
      },
      {
        params: [],
        sql: `INSERT INTO ${quoted(temporaryTable)} (${table.columns.map((column) => quoted(column.name)).join(", ")}) SELECT ${table.columns.map((column) => quoted(column.name)).join(", ")} FROM ${quoted(table.name)}`,
      },
      { params: [], sql: `DROP TABLE ${quoted(table.name)}` },
      {
        params: [],
        sql: `ALTER TABLE ${quoted(temporaryTable)} RENAME TO ${quoted(table.name)}`,
      },
    );
    for (const index of table.indexes ?? []) {
      statements.push({
        params: [],
        sql: `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoted(index.name)} ON ${quoted(table.name)} (${index.columns.map(quoted).join(", ")})`,
      });
    }
  }
  return statements;
};

const lexicographicPredicate = (
  columns: readonly string[],
  values: readonly UniversalComponentScalar[],
  operator: ">" | "<",
): { readonly params: readonly D1Parameter[]; readonly sql: string } => {
  const params: D1Parameter[] = [];
  const terms = values.map((value, index) => {
    const equalities = columns.slice(0, index).map((column, equalIndex) => {
      params.push(JSON.stringify(values[equalIndex]));
      return `${quoted(column)} = json_extract(?, '$')`;
    });
    params.push(JSON.stringify(value));
    return `(${[
      ...equalities,
      `${quoted(columns[index]!)} ${operator} json_extract(?, '$')`,
    ].join(" AND ")})`;
  });
  return { params, sql: `(${terms.join(" OR ")})` };
};

const settingValue = async (
  executor: D1Executor,
  key: string,
): Promise<string | null> => {
  const rows = await executor.query(
    `SELECT value FROM ${settingsTable} WHERE key = ? LIMIT 1`,
    [key],
  );
  const row = rows[0];
  if (row === undefined) return null;
  if (typeof row !== "object" || row === null || !("value" in row)) {
    throw new TypeError("Invalid universal component setting");
  }
  const value = row.value;
  if (typeof value !== "string") {
    throw new TypeError("Invalid universal component setting");
  }
  return value;
};

export const createD1UniversalComponentDataAdapter = (
  executor: D1Executor,
): UniversalComponentDataAdapter => {
  const readinessValidated = new WeakSet<UniversalComponentSchema>();
  return {
    artifacts(schema) {
      const latest = getUniversalComponentLatestSchema(schema);
      return [
        {
          contents: `${[
            ...createVersionStatements(latest),
            markerStatement(schema, latest.version),
          ]
            .map(({ sql }) => sql)
            .join(";\n\n")};\n`,
          path: `component-data/${schema.id}/d1-${latest.version}.sql`,
          targetVersion: latest.version,
        },
      ];
    },
    bind(schema) {
      const latest = getUniversalComponentLatestSchema(schema);
      const assertReady = async (): Promise<void> => {
        const actualVersion = await settingValue(
          executor,
          getUniversalComponentSchemaMarkerKey(schema),
        );
        if (actualVersion !== latest.version) {
          throw new UniversalComponentSchemaNotReadyError(
            schema.id,
            latest.version,
            actualVersion,
          );
        }
        if (!readinessValidated.has(schema)) {
          try {
            await validateD1Version(executor, schema, latest);
            await validateStoredRows(executor, schema, latest, [latest]);
          } catch (error) {
            if (error instanceof D1UniversalComponentSchemaDriftError) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                error.reason,
                { cause: error },
              );
            }
            if (error instanceof D1UniversalComponentStoredDataError) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "stored-data",
                { cause: error },
              );
            }
            throw error;
          }
          readinessValidated.add(schema);
        }
      };
      return {
        schema,
        assertReady,
        async append(input) {
          await assertReady();
          const table = validateUniversalComponentAppend(schema, input);
          const values = encodeRow(table, input.row);
          const columns = table.columns.map((column) => quoted(column.name));
          await executor.query(
            `INSERT INTO ${quoted(table.name)} (${columns.join(", ")}) VALUES (${columns.map(() => "json_extract(?, '$')").join(", ")})`,
            values,
          );
        },
        async create(input) {
          await assertReady();
          const table = validateUniversalComponentAppend(schema, input);
          const primaryKey = table.columns.find((column) => column.primaryKey)!;
          const values = encodeRow(table, input.row);
          const columns = table.columns.map((column) => quoted(column.name));
          const rows = await executor.query(
            `INSERT INTO ${quoted(table.name)} (${columns.join(", ")}) VALUES (${columns.map(() => "json_extract(?, '$')").join(", ")}) ON CONFLICT (${quoted(primaryKey.name)}) DO NOTHING RETURNING ${quoted(primaryKey.name)}`,
            values,
          );
          return rows.length === 0 ? "existing" : "created";
        },
        async get(input) {
          await assertReady();
          const table = validateUniversalComponentGet(schema, input);
          const primaryKey = table.columns.find((column) => column.primaryKey)!;
          const [storedRow] = await executor.query(
            `SELECT ${table.columns.map((column) => quoted(column.name)).join(", ")} FROM ${quoted(table.name)} WHERE ${quoted(primaryKey.name)} = json_extract(?, '$') LIMIT 1`,
            [JSON.stringify(input.primaryKey)],
          );
          if (storedRow === undefined) return null;
          try {
            const row = parseRow(table, storedRow);
            validateUniversalComponentRow(schema, {
              row,
              table: table.name,
              version: latest.version,
            });
            return row;
          } catch (error) {
            throw new UniversalComponentDataStateNotReadyError(
              schema.id,
              latest.version,
              "stored-data",
              { cause: error },
            );
          }
        },
        async orderedScan(input) {
          await assertReady();
          const scan = validateUniversalComponentOrderedScan(schema, input);
          const table = getUniversalComponentTable(schema, scan.table);
          const predicates: string[] = [];
          const params: D1Parameter[] = [];
          if (input.afterExclusive !== undefined) {
            const after = lexicographicPredicate(
              scan.columns,
              input.afterExclusive,
              ">",
            );
            predicates.push(after.sql);
            params.push(...after.params);
          }
          const before = lexicographicPredicate(
            scan.columns,
            input.beforePrefixExclusive,
            "<",
          );
          predicates.push(before.sql);
          params.push(...before.params, JSON.stringify(input.limit));
          const rows = await executor.query(
            `SELECT ${table.columns.map((column) => quoted(column.name)).join(", ")} FROM ${quoted(table.name)} WHERE ${predicates.join(" AND ")} ORDER BY ${scan.columns.map((column) => `${quoted(column)} ASC`).join(", ")} LIMIT json_extract(?, '$')`,
            params,
          );
          return rows.slice(0, input.limit).map((storedRow) => {
            try {
              const row = parseRow(table, storedRow);
              validateUniversalComponentRow(schema, {
                row,
                table: table.name,
                version: latest.version,
              });
              return row;
            } catch (error) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "stored-data",
                { cause: error },
              );
            }
          });
        },
      };
    },
    async migrate(schema) {
      readinessValidated.delete(schema);
      const latest = getUniversalComponentLatestSchema(schema);
      const marker = await settingValue(
        executor,
        getUniversalComponentSchemaMarkerKey(schema),
      );
      const physicalVersion = await inspectD1PhysicalVersion(executor, schema);
      const discriminatorValue =
        schema.unmarked === undefined
          ? null
          : await settingValue(executor, schema.unmarked.discriminatorKey);
      const decision = resolveUniversalComponentMigrationState(schema, {
        discriminatorValue,
        markerVersion: marker,
        physicalVersion,
      });
      if (decision.kind === "reject") {
        throw new D1UniversalComponentSchemaDriftError(
          schema.id,
          "migration state is not adoptable",
        );
      }
      if (decision.kind === "ready") {
        await validateStoredRows(executor, schema, latest, [latest]);
        readinessValidated.add(schema);
        return { changed: false, version: latest.version };
      }

      const statements: D1Statement[] = [];
      if (decision.kind === "create") {
        statements.push(...createVersionStatements(latest));
      } else {
        const sourceIndex = schema.versions.findIndex(
          ({ version }) => version === decision.fromVersion,
        );
        const source = schema.versions[sourceIndex]!;
        await validateStoredRows(
          executor,
          schema,
          source,
          schema.versions.slice(sourceIndex),
        );
        if (decision.kind === "migrate") {
          for (const target of schema.versions.slice(sourceIndex + 1)) {
            statements.push(...transitionStatements(schema, target));
          }
        }
      }
      statements.push(markerStatement(schema, latest.version));
      await executor.batch(statements);

      const migratedVersion = await settingValue(
        executor,
        getUniversalComponentSchemaMarkerKey(schema),
      );
      if (migratedVersion !== latest.version) {
        throw new UniversalComponentSchemaNotReadyError(
          schema.id,
          latest.version,
          migratedVersion,
        );
      }
      await validateD1Version(executor, schema, latest);
      await validateStoredRows(executor, schema, latest, [latest]);
      readinessValidated.add(schema);
      return { changed: true, version: latest.version };
    },
  };
};
