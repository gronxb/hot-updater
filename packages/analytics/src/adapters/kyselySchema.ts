import {
  ANALYTICS_SCHEMA_FINGERPRINT_V1,
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
} from "../provider/migration.js";
import {
  ANALYTICS_PHYSICAL_SCHEMA_V1,
  ANALYTICS_PHYSICAL_SCHEMA_V2,
  fingerprintAnalyticsPhysicalSchema,
  type AnalyticsPhysicalColumn,
  type AnalyticsPhysicalSchema,
} from "../provider/schemaFingerprint.js";
import {
  checksHaveExactDefinitions,
  v1CheckNames,
  v2CheckNames,
} from "./kyselyCheckDefinitions.js";
import type { KyselyAnalyticsDialect } from "./kyselyMigrationSql.js";
import type {
  KyselyAnalyticsCatalog,
  KyselyAnalyticsCatalogCheck,
} from "./kyselySchemaCatalog.js";

export type KyselyAnalyticsSchemaState = {
  readonly fingerprint: string | null;
  readonly mysqlResumeIndex: number | null;
};

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameNames(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    same([...actual].sort(), [...expected].sort()) &&
    new Set(actual).size === actual.length
  );
}

function orderedIndexes(
  catalog: KyselyAnalyticsCatalog,
): AnalyticsPhysicalSchema["indexes"] {
  const order = new Map(
    ANALYTICS_PHYSICAL_SCHEMA_V2.indexes.map(({ name }, index) => [
      name,
      index,
    ]),
  );
  return [...catalog.indexes]
    .sort(
      (left, right) =>
        (order.get(left.name) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.name) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(({ columns, name, unique }) => ({ name, columns, unique }));
}

function catalogCanBeFingerprinted(catalog: KyselyAnalyticsCatalog): boolean {
  return (
    same(catalog.primaryKey, ["id"]) &&
    catalog.foreignKeys.length === 0 &&
    catalog.invalidIndexes.length === 0 &&
    catalog.unexpectedConstraints.length === 0
  );
}

function fingerprint(
  catalog: KyselyAnalyticsCatalog,
  checks: AnalyticsPhysicalSchema["checks"],
): string | null {
  if (!catalogCanBeFingerprinted(catalog)) return "analytics-schema-drift";
  return fingerprintAnalyticsPhysicalSchema({
    checks,
    columns: catalog.columns ?? [],
    indexes: orderedIndexes(catalog),
  });
}

function splitChecks(checks: readonly KyselyAnalyticsCatalogCheck[]): {
  readonly disabled: readonly string[];
  readonly enabled: readonly string[];
} {
  return {
    disabled: checks
      .filter(({ enforced }) => !enforced)
      .map(({ name }) => name),
    enabled: checks.filter(({ enforced }) => enforced).map(({ name }) => name),
  };
}

function inspectExact(
  catalog: KyselyAnalyticsCatalog,
  dialect: KyselyAnalyticsDialect,
): string | null {
  if (!checksHaveExactDefinitions(catalog.checks, dialect)) {
    return "analytics-schema-drift";
  }
  const { disabled, enabled } = splitChecks(catalog.checks);
  if (disabled.length > 0) return "analytics-schema-drift";
  if (sameNames(enabled, v1CheckNames)) {
    return fingerprint(catalog, ANALYTICS_PHYSICAL_SCHEMA_V1.checks);
  }
  if (sameNames(enabled, v2CheckNames)) {
    return fingerprint(catalog, ANALYTICS_PHYSICAL_SCHEMA_V2.checks);
  }
  return "analytics-schema-drift";
}

const mysqlMixedColumns: readonly AnalyticsPhysicalColumn[] =
  ANALYTICS_PHYSICAL_SCHEMA_V1.columns.map((column) =>
    column.name === "from_bundle_id" ? { ...column, nullable: true } : column,
  );

function mysqlPhase(catalog: KyselyAnalyticsCatalog): number | null {
  if (
    !catalogCanBeFingerprinted(catalog) ||
    !checksHaveExactDefinitions(catalog.checks, "mysql")
  ) {
    return null;
  }
  const indexes = orderedIndexes(catalog);
  if (!same(indexes, ANALYTICS_PHYSICAL_SCHEMA_V2.indexes)) return null;
  const { disabled, enabled } = splitChecks(catalog.checks);
  const columns = catalog.columns ?? [];
  if (
    same(columns, ANALYTICS_PHYSICAL_SCHEMA_V1.columns) &&
    sameNames(enabled, v1CheckNames) &&
    disabled.length === 0
  ) {
    return 0;
  }
  if (
    same(columns, ANALYTICS_PHYSICAL_SCHEMA_V1.columns) &&
    sameNames(enabled, [v1CheckNames[1]]) &&
    sameNames(disabled, [v1CheckNames[0]])
  ) {
    return 1;
  }
  if (
    sameNames(disabled, v1CheckNames) &&
    enabled.length === 0 &&
    same(columns, ANALYTICS_PHYSICAL_SCHEMA_V1.columns)
  ) {
    return 2;
  }
  if (
    sameNames(disabled, v1CheckNames) &&
    enabled.length === 0 &&
    same(columns, mysqlMixedColumns)
  ) {
    return 3;
  }
  if (
    sameNames(disabled, v1CheckNames) &&
    same(columns, ANALYTICS_PHYSICAL_SCHEMA_V2.columns)
  ) {
    if (enabled.length === 0) return 4;
    if (sameNames(enabled, [v2CheckNames[0]])) return 5;
    if (sameNames(enabled, v2CheckNames.slice(0, 2))) return 6;
  }
  return null;
}

export function classifyKyselyAnalyticsSchema(
  catalog: KyselyAnalyticsCatalog | null,
  dialect: KyselyAnalyticsDialect,
): KyselyAnalyticsSchemaState {
  if (catalog === null) return { fingerprint: null, mysqlResumeIndex: null };
  if (dialect !== "mysql") {
    return {
      fingerprint: inspectExact(catalog, dialect),
      mysqlResumeIndex: null,
    };
  }

  const { disabled, enabled } = splitChecks(catalog.checks);
  const v2Fingerprint = fingerprint(
    catalog,
    ANALYTICS_PHYSICAL_SCHEMA_V2.checks,
  );
  const exactV2Checks = sameNames(enabled, v2CheckNames);
  const knownDisabledChecks =
    disabled.length === 0 || sameNames(disabled, v1CheckNames);
  if (
    exactV2Checks &&
    knownDisabledChecks &&
    checksHaveExactDefinitions(catalog.checks, "mysql") &&
    v2Fingerprint === ANALYTICS_SCHEMA_FINGERPRINT_V2
  ) {
    return { fingerprint: v2Fingerprint, mysqlResumeIndex: null };
  }

  const resumeIndex = mysqlPhase(catalog);
  if (resumeIndex !== null) {
    return {
      fingerprint: ANALYTICS_SCHEMA_FINGERPRINT_V1,
      mysqlResumeIndex: resumeIndex,
    };
  }
  return { fingerprint: "analytics-schema-drift", mysqlResumeIndex: null };
}
