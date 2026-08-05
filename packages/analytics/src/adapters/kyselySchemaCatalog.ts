import { sql, type Kysely } from "kysely";

import type {
  AnalyticsPhysicalColumn,
  AnalyticsPhysicalIndex,
} from "../provider/schemaFingerprint.js";
import {
  type KyselyAnalyticsDialect,
  UnsupportedKyselyAnalyticsDialectError,
} from "./kyselyMigrationSql.js";
import {
  inspectMysqlAnalyticsCatalog,
  inspectPostgresAnalyticsCatalog,
  inspectSqliteAnalyticsCatalog,
} from "./kyselySchemaCatalogProviders.js";

export type KyselyAnalyticsCatalogCheck = {
  readonly definition: string;
  readonly enforced: boolean;
  readonly name: string;
};

export type KyselyAnalyticsCatalog = {
  readonly checks: readonly KyselyAnalyticsCatalogCheck[];
  readonly columns: readonly AnalyticsPhysicalColumn[] | null;
  readonly foreignKeys: readonly string[];
  readonly invalidIndexes: readonly string[];
  readonly indexes: readonly AnalyticsPhysicalIndex[];
  readonly primaryKey: readonly string[];
  readonly unexpectedConstraints: readonly string[];
};

const idColumns = new Set(["id", "from_bundle_id", "to_bundle_id"]);

function physicalType(
  dialect: KyselyAnalyticsDialect,
  name: string,
  dataType: string,
): AnalyticsPhysicalColumn["type"] | null {
  const normalized = dataType.toLowerCase();
  if (name === "received_at_ms") {
    const valid =
      (dialect === "sqlite" && normalized === "real") ||
      (dialect === "mysql" && normalized === "double") ||
      (dialect === "postgresql" &&
        (normalized === "float8" || normalized === "double precision"));
    return valid ? "number" : null;
  }
  if (idColumns.has(name)) {
    const valid =
      (dialect === "sqlite" && normalized === "text") ||
      (dialect === "mysql" && normalized === "char") ||
      (dialect === "postgresql" && normalized === "uuid");
    return valid ? "id" : null;
  }
  return normalized === "text" ? "string" : null;
}

async function inspectColumns<TDatabase extends object>(
  db: Kysely<TDatabase>,
  dialect: KyselyAnalyticsDialect,
): Promise<readonly AnalyticsPhysicalColumn[] | null> {
  const tables = await db.introspection.getTables();
  const currentSchema =
    dialect === "postgresql"
      ? (
          await sql<{
            readonly name: string;
          }>`select current_schema() as name`.execute(db)
        ).rows[0]?.name
      : undefined;
  const table = tables.find(
    ({ name, schema }) =>
      name === "bundle_events" &&
      (currentSchema === undefined || schema === currentSchema),
  );
  if (table === undefined) return null;
  const result: AnalyticsPhysicalColumn[] = [];
  for (const column of table.columns) {
    const type = physicalType(dialect, column.name, column.dataType);
    if (type === null) return [];
    result.push({ name: column.name, nullable: column.isNullable, type });
  }
  return result;
}

export async function inspectKyselyAnalyticsCatalog<TDatabase extends object>(
  db: Kysely<TDatabase>,
  dialect: KyselyAnalyticsDialect,
): Promise<KyselyAnalyticsCatalog | null> {
  let inspectCatalog: typeof inspectSqliteAnalyticsCatalog;
  switch (dialect) {
    case "sqlite":
      inspectCatalog = inspectSqliteAnalyticsCatalog;
      break;
    case "mysql":
      inspectCatalog = inspectMysqlAnalyticsCatalog;
      break;
    case "postgresql":
      inspectCatalog = inspectPostgresAnalyticsCatalog;
      break;
    default:
      throw new UnsupportedKyselyAnalyticsDialectError(String(dialect));
  }

  const physicalColumns = await inspectColumns(db, dialect);
  if (physicalColumns === null) return null;
  const catalog = await inspectCatalog(db);
  return { ...catalog, columns: physicalColumns };
}
