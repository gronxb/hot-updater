import type {
  UniversalComponentCheckSchema,
  UniversalComponentCheckExpression,
  UniversalComponentCheckValue,
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
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { SupabaseDatabaseError, throwSupabaseError } from "./supabaseResult";
import type { Database } from "./types";

const postgresIdentifierLimit = 63;
const settingsTable = "private_hot_updater_settings";

interface ComponentQueryResult {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

interface ComponentQuery extends PromiseLike<ComponentQueryResult> {
  eq(column: string, value: unknown): ComponentQuery;
  insert(values: UniversalComponentRow): ComponentQuery;
  limit(value: number): ComponentQuery;
  maybeSingle(): ComponentQuery;
  or(filters: string): ComponentQuery;
  order(
    column: string,
    options: { readonly ascending: boolean },
  ): ComponentQuery;
  range(from: number, to: number): ComponentQuery;
  select(columns: string): ComponentQuery;
  upsert(
    values: UniversalComponentRow,
    options: { readonly ignoreDuplicates: true; readonly onConflict: string },
  ): ComponentQuery;
}

interface ComponentClient {
  from(table: string): ComponentQuery;
}

const quoted = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const qualified = (table: string): string =>
  `${quoted("public")}.${quoted(table)}`;

const sqlLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const sqlValue = (value: UniversalComponentCheckValue): string => {
  if (typeof value === "string") return sqlLiteral(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
};

const postgresType = (column: UniversalComponentColumnSchema): string => {
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

const columnSql = (column: UniversalComponentColumnSchema): string =>
  [
    quoted(column.name),
    postgresType(column),
    column.nullable ? undefined : "NOT NULL",
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");

const checkExpressionSql = (
  expression: UniversalComponentCheckExpression,
  columns: ReadonlyMap<string, UniversalComponentColumnSchema>,
): string => {
  if ("expressions" in expression) {
    const operator = expression.op === "all" ? " AND " : " OR ";
    return `(${expression.expressions
      .map((item) => checkExpressionSql(item, columns))
      .join(operator)})`;
  }
  const column = columns.get(expression.column)!;
  const reference = quoted(column.name);
  switch (expression.op) {
    case "eq":
      return `(${reference} = ${sqlValue(expression.value)})`;
    case "in":
      return `(${reference} IN (${expression.values
        .map(sqlValue)
        .join(", ")}))`;
    case "gte":
      return `(${reference} >= ${expression.value})`;
    case "lte":
      return `(${reference} <= ${expression.value})`;
    case "integer":
      return `(${reference} = trunc(${reference}))`;
    case "is-not-null":
      return `(${reference} IS NOT NULL)`;
    case "is-null":
      return `(${reference} IS NULL)`;
    case "non-empty":
      return column.type === "uuid"
        ? `(${reference}::text <> '')`
        : `(${reference} <> '')`;
  }
};

const primaryKeyName = (table: UniversalComponentTableSchema): string =>
  `${table.name}_pkey`;

const storageChecks = (
  table: UniversalComponentTableSchema,
): readonly UniversalComponentCheckSchema[] =>
  (table.checks ?? []).filter(
    ({ enforcement }) => enforcement !== "validation",
  );

const tableDefinitionSql = (table: UniversalComponentTableSchema): string => {
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const primaryKey = table.columns.find((column) => column.primaryKey)!;
  return [
    ...table.columns.map(columnSql),
    `CONSTRAINT ${quoted(primaryKeyName(table))} PRIMARY KEY (${quoted(primaryKey.name)})`,
    ...storageChecks(table).map(
      (check) =>
        `CONSTRAINT ${quoted(check.name)} CHECK (${checkExpressionSql(check.expression, columns)})`,
    ),
  ].join(",\n      ");
};

const createTableSql = (
  table: UniversalComponentTableSchema,
  name = table.name,
  temporary = false,
): string =>
  `CREATE ${temporary ? "TEMP " : ""}TABLE ${temporary ? quoted(name) : qualified(name)} (\n      ${tableDefinitionSql(table)}\n    )${temporary ? " ON COMMIT DROP" : ""}`;

const createIndexSql = (
  table: UniversalComponentTableSchema,
  index: UniversalComponentIndexSchema,
): string =>
  `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoted(index.name)} ON ${qualified(table.name)} (${index.columns.map(quoted).join(", ")})`;

const expectedColumns = (
  table: UniversalComponentTableSchema,
): readonly unknown[] =>
  table.columns.map((column) => [
    column.name,
    postgresType(column),
    column.nullable !== true,
    column.primaryKey === true,
    "",
    "",
    null,
  ]);

const columnCatalogSql = (relation: string): string => `(
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
        WHERE relation.oid = to_regclass(${sqlLiteral(relation)})
          AND relation.relkind = 'r'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )`;

const constraintCatalogSql = (relation: string): string => `(
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
        WHERE constraint_definition.conrelid = to_regclass(${sqlLiteral(relation)})
      )`;

const indexCatalogSql = (relation: string): string => `(
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
              WHERE index_column.ordinality <= index_definition.indnkeyatts
            ), '[]'::jsonb),
            'has_expressions', index_definition.indexprs IS NOT NULL,
            'has_includes',
              index_definition.indnkeyatts <> index_definition.indnatts,
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
          WHERE table_relation.oid = to_regclass(${sqlLiteral(relation)})
            AND NOT index_definition.indisprimary
        ) AS catalog
      )`;

const expectedIndexes = (
  table: UniversalComponentTableSchema,
): readonly unknown[] =>
  [...(table.indexes ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((index) => ({
      columns: index.columns,
      has_expressions: false,
      has_includes: false,
      is_partial: false,
      is_ready: true,
      is_unique: index.unique === true,
      is_valid: true,
      method: "btree",
      name: index.name,
      opclasses_default: true,
      options_valid: true,
    }));

const exactTablePredicate = (
  table: UniversalComponentTableSchema,
  referenceTable: string,
): string => {
  const relation = `public.${table.name}`;
  return `(
        to_regclass(${sqlLiteral(relation)}) IS NOT NULL
        AND ${columnCatalogSql(relation)} = ${sqlLiteral(JSON.stringify(expectedColumns(table)))}::jsonb
        AND ${constraintCatalogSql(relation)} = ${constraintCatalogSql(`pg_temp.${referenceTable}`)}
        AND ${indexCatalogSql(relation)} = ${sqlLiteral(JSON.stringify(expectedIndexes(table)))}::jsonb
      )`;
};

const referenceTableName = (versionIndex: number, tableIndex: number): string =>
  `hot_updater_component_ref_${versionIndex}_${tableIndex}`;

const referenceBlock = (
  version: UniversalComponentSchemaVersion,
  versionIndex: number,
  target: string,
): readonly string[] => {
  const references = version.tables.map((table, tableIndex) => ({
    name: referenceTableName(versionIndex, tableIndex),
    table,
  }));
  return [
    ...references.map(({ name, table }) => createTableSql(table, name, true)),
    `${target} := ${references
      .map(({ name, table }) => exactTablePredicate(table, name))
      .join(" AND ")}`,
    ...references.map(({ name }) => `DROP TABLE pg_temp.${quoted(name)}`),
  ];
};

const sameCheck = (
  left: UniversalComponentCheckSchema,
  right: UniversalComponentCheckSchema,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const sameIndex = (
  left: UniversalComponentIndexSchema,
  right: UniversalComponentIndexSchema,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const transitionStatements = (
  previous: UniversalComponentSchemaVersion,
  next: UniversalComponentSchemaVersion,
  componentId: string,
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
      if (replacement === undefined || !sameIndex(index, replacement)) {
        statements.push(`DROP INDEX ${qualified(index.name)}`);
      }
    }
    for (const check of previousChecks.values()) {
      const replacement = nextChecks.get(check.name);
      if (replacement === undefined || !sameCheck(check, replacement)) {
        statements.push(
          `ALTER TABLE ${qualified(previousTable.name)} DROP CONSTRAINT ${quoted(check.name)}`,
        );
      }
    }
    previousTable.columns.forEach((previousColumn, columnIndex) => {
      const nextColumn = nextTable.columns[columnIndex]!;
      if (previousColumn.nullable !== true && nextColumn.nullable === true) {
        statements.push(
          `ALTER TABLE ${qualified(previousTable.name)} ALTER COLUMN ${quoted(previousColumn.name)} DROP NOT NULL`,
        );
      } else if (
        previousColumn.nullable === true &&
        nextColumn.nullable !== true
      ) {
        statements.push(
          `IF EXISTS (SELECT 1 FROM ${qualified(previousTable.name)} WHERE ${quoted(previousColumn.name)} IS NULL) THEN\n        RAISE EXCEPTION ${sqlLiteral(`Universal component ${componentId} cannot require ${previousTable.name}.${previousColumn.name}; stored rows contain null.`)};\n      END IF`,
          `ALTER TABLE ${qualified(previousTable.name)} ALTER COLUMN ${quoted(previousColumn.name)} SET NOT NULL`,
        );
      }
    });
    const columns = new Map(
      nextTable.columns.map((column) => [column.name, column]),
    );
    for (const check of nextChecks.values()) {
      const previousCheck = previousChecks.get(check.name);
      if (previousCheck === undefined || !sameCheck(previousCheck, check)) {
        statements.push(
          `ALTER TABLE ${qualified(nextTable.name)} ADD CONSTRAINT ${quoted(check.name)} CHECK (${checkExpressionSql(check.expression, columns)}) NOT VALID`,
          `ALTER TABLE ${qualified(nextTable.name)} VALIDATE CONSTRAINT ${quoted(check.name)}`,
        );
      }
    }
    for (const index of nextIndexes.values()) {
      const previousIndex = previousIndexes.get(index.name);
      if (previousIndex === undefined || !sameIndex(previousIndex, index)) {
        statements.push(createIndexSql(nextTable, index));
      }
    }
  });
  return statements;
};

const stateValueCondition = (
  expression: string,
  value: string | null,
): string =>
  value === null
    ? `${expression} IS NULL`
    : `${expression} = ${sqlLiteral(value)}`;

const migrationDecisionSql = (schema: UniversalComponentSchema): string => {
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
          stateValueCondition("component_version", markerVersion),
          stateValueCondition("physical_version", physicalVersion),
          stateValueCondition("discriminator_value", discriminatorValue),
        ].join(" AND ");
        const action =
          decision.kind === "create"
            ? "should_create := true;"
            : decision.kind === "ready"
              ? `source_version := ${sqlLiteral(decision.version)};`
              : `source_version := ${sqlLiteral(decision.fromVersion)};`;
        branches.push(
          `${branches.length === 0 ? "IF" : "ELSIF"} ${condition} THEN\n        ${action}`,
        );
      }
    }
  }
  return `${branches.join("\n      ")}\n      ELSE\n        RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} migration state is incompatible.`)};\n      END IF`;
};

const latestRowValidation = (
  schema: UniversalComponentSchema,
): readonly string[] => {
  const latest = getUniversalComponentLatestSchema(schema);
  return latest.tables.flatMap((table) => {
    const columns = new Map(
      table.columns.map((column) => [column.name, column]),
    );
    const invalid = [
      ...table.columns.flatMap((column) => {
        const reference = quoted(column.name);
        if (column.type === "integer") {
          return [
            `(${reference} IS NOT NULL AND (${reference} < -9007199254740991 OR ${reference} > 9007199254740991))`,
          ];
        }
        if (column.type === "float") {
          return [
            `(${reference} IS NOT NULL AND (${reference} = 'NaN'::double precision OR ${reference} = 'Infinity'::double precision OR ${reference} = '-Infinity'::double precision))`,
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
      `IF EXISTS (SELECT 1 FROM ${qualified(table.name)} WHERE ${invalid.join(" OR ")}) THEN\n        RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} contains invalid rows in ${table.name}.`)};\n      END IF`,
    ];
  });
};

const assertPostgresIdentifiers = (schema: UniversalComponentSchema): void => {
  for (const version of schema.versions) {
    const indexNames = new Set<string>();
    for (const table of version.tables) {
      const identifiers = [
        table.name,
        primaryKeyName(table),
        ...storageChecks(table).map(({ name }) => name),
        ...(table.indexes ?? []).map(({ name }) => name),
      ];
      if (
        identifiers.some(
          (identifier) => identifier.length > postgresIdentifierLimit,
        )
      ) {
        throw new TypeError(
          `Supabase universal component identifier exceeds ${postgresIdentifierLimit} bytes in ${schema.id}.`,
        );
      }
      for (const index of table.indexes ?? []) {
        if (indexNames.has(index.name)) {
          throw new TypeError(
            `Supabase universal component ${schema.id} repeats index ${index.name}.`,
          );
        }
        indexNames.add(index.name);
      }
    }
  }
};

const addSemicolons = (statements: readonly string[]): string =>
  statements.map((statement) => `      ${statement};`).join("\n");

const migrationBody = (schema: UniversalComponentSchema): string => {
  const latest = getUniversalComponentLatestSchema(schema);
  const markerKey = getUniversalComponentSchemaMarkerKey(schema);
  const matches = schema.versions.map((_, index) => `matches_${index}`);
  const allAbsent = schema.versions[0]!.tables.map(
    (table) => `to_regclass(${sqlLiteral(`public.${table.name}`)}) IS NULL`,
  ).join(" AND ");
  const settingsReference = "hot_updater_component_settings_ref";
  const settingsColumns = JSON.stringify([
    ["key", "text", true, true, "", "", null],
    ["value", "text", true, false, "", "", null],
  ]);
  const declarations = [
    "component_version text",
    "discriminator_value text",
    "physical_version text",
    "source_version text",
    "match_count integer := 0",
    "should_create boolean := false",
    ...matches.map((name) => `${name} boolean := false`),
  ];
  const statements: string[] = [
    `PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${sqlLiteral(`hot-updater.component-data.${schema.id}`)}, 0))`,
    `CREATE TABLE IF NOT EXISTS ${qualified(settingsTable)} (\n        ${quoted("key")} text NOT NULL,\n        ${quoted("value")} text NOT NULL,\n        CONSTRAINT ${quoted(`${settingsTable}_pkey`)} PRIMARY KEY (${quoted("key")})\n      )`,
    `CREATE TEMP TABLE ${quoted(settingsReference)} (\n        ${quoted("key")} text NOT NULL,\n        ${quoted("value")} text NOT NULL,\n        CONSTRAINT ${quoted(`${settingsTable}_pkey`)} PRIMARY KEY (${quoted("key")})\n      ) ON COMMIT DROP`,
    `IF ${columnCatalogSql(`public.${settingsTable}`)} <> ${sqlLiteral(settingsColumns)}::jsonb\n        OR ${constraintCatalogSql(`public.${settingsTable}`)} <> ${constraintCatalogSql(`pg_temp.${settingsReference}`)}\n        OR ${indexCatalogSql(`public.${settingsTable}`)} <> '[]'::jsonb THEN\n        RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} found an incompatible Hot Updater settings table.`)};\n      END IF`,
    `DROP TABLE pg_temp.${quoted(settingsReference)}`,
    `SELECT ${quoted("value")} INTO component_version\n      FROM ${qualified(settingsTable)}\n      WHERE ${quoted("key")} = ${sqlLiteral(markerKey)}\n      LIMIT 1`,
    ...(schema.unmarked === undefined
      ? []
      : [
          `SELECT ${quoted("value")} INTO discriminator_value\n      FROM ${qualified(settingsTable)}\n      WHERE ${quoted("key")} = ${sqlLiteral(schema.unmarked.discriminatorKey)}\n      LIMIT 1`,
        ]),
    ...schema.versions.flatMap((version, index) =>
      referenceBlock(version, index, matches[index]!),
    ),
    `IF component_version IS NOT NULL\n        AND component_version NOT IN (${schema.versions.map(({ version }) => sqlLiteral(version)).join(", ")}) THEN\n        RAISE EXCEPTION 'Unknown universal component schema version for ${schema.id}: %', component_version;\n      END IF`,
    `IF ${allAbsent} THEN\n        physical_version := NULL;\n      ELSE\n        match_count := ${matches.map((name) => `CASE WHEN ${name} THEN 1 ELSE 0 END`).join(" + ")};\n        IF match_count = 0 THEN\n          RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} has unsupported physical state.`)};\n        END IF;\n${[
      ...schema.versions,
    ]
      .reverse()
      .map((version, reverseIndex) => {
        const index = schema.versions.length - reverseIndex - 1;
        return `        ${reverseIndex === 0 ? "IF" : "ELSIF"} ${matches[index]} THEN\n          physical_version := ${sqlLiteral(version.version)};`;
      })
      .join("\n")}\n        END IF;\n      END IF`,
    migrationDecisionSql(schema),
    `IF should_create THEN\n${addSemicolons(
      latest.tables.flatMap((table) => [
        createTableSql(table),
        ...(table.indexes ?? []).map((index) => createIndexSql(table, index)),
      ]),
    )}\n        source_version := ${sqlLiteral(latest.version)};\n      END IF`,
    ...schema.versions.slice(0, -1).map((version, index) => {
      const next = schema.versions[index + 1]!;
      return `IF source_version = ${sqlLiteral(version.version)} THEN\n${addSemicolons(transitionStatements(version, next, schema.id))}\n        source_version := ${sqlLiteral(next.version)};\n      END IF`;
    }),
    ...referenceBlock(
      latest,
      schema.versions.length,
      matches[schema.versions.length - 1]!,
    ),
    `IF NOT ${matches[schema.versions.length - 1]} THEN\n        RAISE EXCEPTION ${sqlLiteral(`Universal component ${schema.id} final physical schema validation failed.`)};\n      END IF`,
    ...latestRowValidation(schema),
    ...latest.tables.flatMap((table) => [
      `ALTER TABLE ${qualified(table.name)} ENABLE ROW LEVEL SECURITY`,
      `REVOKE ALL PRIVILEGES ON TABLE ${qualified(table.name)} FROM PUBLIC, anon, authenticated`,
    ]),
    `ALTER TABLE ${qualified(settingsTable)} ENABLE ROW LEVEL SECURITY`,
    `REVOKE ALL PRIVILEGES ON TABLE ${qualified(settingsTable)} FROM PUBLIC, anon, authenticated`,
    `IF component_version IS DISTINCT FROM ${sqlLiteral(latest.version)} THEN\n        INSERT INTO ${qualified(settingsTable)} (${quoted("key")}, ${quoted("value")})\n        VALUES (${sqlLiteral(markerKey)}, ${sqlLiteral(latest.version)})\n        ON CONFLICT (${quoted("key")}) DO UPDATE\n        SET ${quoted("value")} = EXCLUDED.${quoted("value")};\n      END IF`,
  ];
  return `DECLARE\n  ${declarations.join(";\n  ")};\nBEGIN\n${addSemicolons(statements)}\nEND`;
};

const dollarTag = (body: string): string => {
  let suffix = 0;
  while (body.includes(`$hot_updater_component_${suffix}$`)) suffix += 1;
  return `$hot_updater_component_${suffix}$`;
};

const migrationArtifact = (schema: UniversalComponentSchema): string => {
  assertPostgresIdentifiers(schema);
  const latest = getUniversalComponentLatestSchema(schema);
  const body = migrationBody(schema);
  const tag = dollarTag(body);
  return `-- HotUpdater.component-data\n-- component: ${schema.id}\n-- target-version: ${JSON.stringify(latest.version)}\nBEGIN;\n\nDO ${tag}\n${body};\n${tag};\n\nCOMMIT;\n`;
};

const encodeFilterValue = (value: UniversalComponentScalar): string =>
  typeof value === "string"
    ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : String(value);

const lexicographicFilter = (
  columns: readonly string[],
  values: readonly UniversalComponentScalar[],
  operator: "gt" | "lt",
): string =>
  `or(${values
    .map((value, index) => {
      const terms = [
        ...columns
          .slice(0, index)
          .map(
            (column, equalIndex) =>
              `${column}.eq.${encodeFilterValue(values[equalIndex]!)}`,
          ),
        `${columns[index]!}.${operator}.${encodeFilterValue(value)}`,
      ];
      return terms.length === 1 ? terms[0] : `and(${terms.join(",")})`;
    })
    .join(",")})`;

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
      const parsed = typeof value === "string" ? Number(value) : value;
      if (typeof parsed === "number" && Number.isSafeInteger(parsed)) {
        return parsed;
      }
      break;
    }
    case "json":
      if (value !== null && isUniversalComponentDataValue(value)) {
        return value;
      }
      break;
    case "string":
    case "uuid":
      if (typeof value === "string") return value;
      break;
  }
  throw new TypeError(
    `Invalid stored value for universal component column ${column.name}`,
  );
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

const readinessPageSize = 1_000;
const physicalSchemaErrorCodes = new Set([
  "42P01",
  "42703",
  "PGRST204",
  "PGRST205",
]);

const throwComponentQueryError = (
  operation: string,
  error: PostgrestError | null,
  schema: UniversalComponentSchema,
  expectedVersion: string,
): void => {
  if (error === null) return;
  const cause = new SupabaseDatabaseError(operation, error);
  if (physicalSchemaErrorCodes.has(error.code)) {
    throw new UniversalComponentDataStateNotReadyError(
      schema.id,
      expectedVersion,
      "physical-schema",
      { cause },
    );
  }
  throw cause;
};

const validateStoredRow = (
  schema: UniversalComponentSchema,
  version: string,
  table: UniversalComponentTableSchema,
  storedRow: unknown,
): UniversalComponentRow => {
  try {
    const row = parseRow(table, storedRow);
    validateUniversalComponentRow(schema, {
      row,
      table: table.name,
      version,
    });
    return row;
  } catch (error) {
    throw new UniversalComponentDataStateNotReadyError(
      schema.id,
      version,
      "stored-data",
      { cause: error },
    );
  }
};

const markerVersion = async (
  client: ComponentClient,
  schema: UniversalComponentSchema,
): Promise<string | null> => {
  const { data, error } = await client
    .from(settingsTable)
    .select("value")
    .eq("key", getUniversalComponentSchemaMarkerKey(schema))
    .limit(1)
    .maybeSingle();
  throwSupabaseError("read universal component schema marker", error);
  if (data === null) return null;
  if (
    typeof data !== "object" ||
    typeof Reflect.get(data, "value") !== "string"
  ) {
    throw new TypeError("Invalid universal component schema marker");
  }
  return Reflect.get(data, "value") as string;
};

export const createSupabaseUniversalComponentDataAdapter = (
  supabase: SupabaseClient<Database>,
): UniversalComponentDataAdapter => {
  const client = supabase as unknown as ComponentClient;
  return {
    artifacts(schema) {
      const latest = getUniversalComponentLatestSchema(schema);
      return [
        {
          contents: migrationArtifact(schema),
          path: `component-data/${schema.id}/supabase-${encodeURIComponent(latest.version)}.sql`,
          targetVersion: latest.version,
        },
      ];
    },
    bind(schema) {
      const latest = getUniversalComponentLatestSchema(schema);
      const expectedVersion = latest.version;
      let declaredTablesReady = false;
      const assertReady = async (): Promise<void> => {
        const actualVersion = await markerVersion(client, schema);
        if (actualVersion !== expectedVersion) {
          throw new UniversalComponentSchemaNotReadyError(
            schema.id,
            expectedVersion,
            actualVersion,
          );
        }
        if (declaredTablesReady) return;
        for (const table of latest.tables) {
          const primaryKey = table.columns.find((column) => column.primaryKey)!;
          let from = 0;
          while (true) {
            const { data, error } = await client
              .from(table.name)
              .select(table.columns.map(({ name }) => name).join(","))
              .order(primaryKey.name, { ascending: true })
              .range(from, from + readinessPageSize - 1);
            throwComponentQueryError(
              `inspect universal component table ${table.name}`,
              error,
              schema,
              expectedVersion,
            );
            if (!Array.isArray(data)) {
              throw new TypeError(
                `Invalid universal component table result: ${table.name}`,
              );
            }
            for (const row of data) {
              validateStoredRow(schema, expectedVersion, table, row);
            }
            if (data.length < readinessPageSize) break;
            from += data.length;
          }
        }
        declaredTablesReady = true;
      };
      return {
        schema,
        assertReady,
        async append(input) {
          await assertReady();
          validateUniversalComponentAppend(schema, input);
          const { error } = await client.from(input.table).insert(input.row);
          throwComponentQueryError(
            "append universal component row",
            error,
            schema,
            expectedVersion,
          );
        },
        async create(input) {
          await assertReady();
          const table = validateUniversalComponentAppend(schema, input);
          const primaryKey = table.columns.find((column) => column.primaryKey)!;
          const { data, error } = await client
            .from(table.name)
            .upsert(input.row, {
              ignoreDuplicates: true,
              onConflict: primaryKey.name,
            })
            .select(primaryKey.name);
          throwComponentQueryError(
            "create universal component row",
            error,
            schema,
            expectedVersion,
          );
          if (!Array.isArray(data)) {
            throw new TypeError("Invalid universal component create result");
          }
          return data.length === 0 ? "existing" : "created";
        },
        async get(input) {
          await assertReady();
          const table = validateUniversalComponentGet(schema, input);
          const primaryKey = table.columns.find((column) => column.primaryKey)!;
          const { data, error } = await client
            .from(table.name)
            .select(table.columns.map(({ name }) => name).join(","))
            .eq(primaryKey.name, input.primaryKey)
            .maybeSingle();
          throwComponentQueryError(
            "get universal component row",
            error,
            schema,
            expectedVersion,
          );
          if (data === null) return null;
          return validateStoredRow(schema, expectedVersion, table, data);
        },
        async orderedScan(input) {
          await assertReady();
          const scan = validateUniversalComponentOrderedScan(schema, input);
          const table = getUniversalComponentTable(schema, scan.table);
          const filters = [
            ...(input.afterExclusive === undefined
              ? []
              : [
                  lexicographicFilter(scan.columns, input.afterExclusive, "gt"),
                ]),
            lexicographicFilter(
              scan.columns,
              input.beforePrefixExclusive,
              "lt",
            ),
          ];
          let query = client
            .from(scan.table)
            .select(table.columns.map(({ name }) => name).join(","))
            .or(
              filters.length === 1 ? filters[0]! : `and(${filters.join(",")})`,
            );
          for (const column of scan.columns) {
            query = query.order(column, { ascending: true });
          }
          const { data, error } = await query.limit(input.limit);
          throwComponentQueryError(
            "scan universal component rows",
            error,
            schema,
            expectedVersion,
          );
          if (!Array.isArray(data)) {
            throw new TypeError("Invalid universal component scan result");
          }
          return data
            .slice(0, input.limit)
            .map((row) =>
              validateStoredRow(schema, latest.version, table, row),
            );
        },
      };
    },
  };
};
