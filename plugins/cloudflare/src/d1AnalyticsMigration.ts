import {
  ANALYTICS_SCHEMA_FINGERPRINT_V1,
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
  ANALYTICS_SCHEMA_KEY,
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSchemaCompatibilityError,
  AnalyticsSchemaNotReadyError,
  migrateAnalyticsSchema,
  parseBundleEventPersistenceRow,
  type AnalyticsMigrationResult,
  type AnalyticsSchemaInspection,
  type AnalyticsSchemaMigrationStore,
} from "@hot-updater/analytics/provider";

import {
  d1AnalyticsColumns,
  d1AnalyticsIndexes,
  d1AnalyticsMigrationTableV2,
  d1AnalyticsTableV1,
  d1AnalyticsTableV2,
  normalizeD1SchemaSql,
} from "./d1AnalyticsSchema";
import type { D1Executor } from "./d1Implementation";

export interface D1AnalyticsMigrationExecutor extends D1Executor {
  batch(statements: readonly string[]): Promise<void>;
}

type SchemaRow = {
  readonly name: string;
  readonly sql: string;
};

type SettingRow = {
  readonly key: string;
  readonly value: string;
};

class InvalidD1AnalyticsInspectionError extends Error {}

const parseStringProperty = (row: unknown, property: string): string => {
  if (typeof row !== "object" || row === null) {
    throw new InvalidD1AnalyticsInspectionError();
  }
  const value = Reflect.get(row, property);
  if (typeof value !== "string") {
    throw new InvalidD1AnalyticsInspectionError();
  }
  return value;
};

const parseSchemaRow = (row: unknown): SchemaRow => ({
  name: parseStringProperty(row, "name"),
  sql: parseStringProperty(row, "sql"),
});

const parseSettingRow = (row: unknown): SettingRow => ({
  key: parseStringProperty(row, "key"),
  value: parseStringProperty(row, "value"),
});

const settingValue = (
  rows: readonly SettingRow[],
  key: typeof ANALYTICS_SCHEMA_KEY | "version",
): string | null => rows.find((row) => row.key === key)?.value ?? null;

const readD1AnalyticsComponentVersion = async (
  executor: D1Executor,
): Promise<string | null> => {
  const settings = (
    await executor.query(
      `SELECT key, value FROM private_hot_updater_settings WHERE key = '${ANALYTICS_SCHEMA_KEY}'`,
      [],
    )
  ).map(parseSettingRow);
  return settingValue(settings, ANALYTICS_SCHEMA_KEY);
};

const d1AnalyticsColumnList = d1AnalyticsColumns.join(", ");
const expectedIndexes = new Set(d1AnalyticsIndexes.map(normalizeD1SchemaSql));

const fingerprintSchema = (
  tableSql: string,
  indexRows: readonly SchemaRow[],
): string => {
  if (
    indexRows.length !== expectedIndexes.size ||
    indexRows.some(({ sql }) => !expectedIndexes.has(normalizeD1SchemaSql(sql)))
  ) {
    return "analytics-schema-drift";
  }
  const normalizedTable = normalizeD1SchemaSql(tableSql);
  if (normalizedTable === normalizeD1SchemaSql(d1AnalyticsTableV1)) {
    return ANALYTICS_SCHEMA_FINGERPRINT_V1;
  }
  if (normalizedTable === normalizeD1SchemaSql(d1AnalyticsTableV2)) {
    return ANALYTICS_SCHEMA_FINGERPRINT_V2;
  }
  return "analytics-schema-drift";
};

const validateRows = async (executor: D1Executor): Promise<void> => {
  const rows = await executor.query(
    `SELECT ${d1AnalyticsColumnList} FROM bundle_events ORDER BY received_at_ms ASC, id ASC`,
    [],
  );
  rows.forEach(parseBundleEventPersistenceRow);
};

const inspectD1AnalyticsSchema = async (
  executor: D1Executor,
): Promise<AnalyticsSchemaInspection> => {
  const tableRows = (
    await executor.query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('bundle_events', 'private_hot_updater_settings') ORDER BY name",
      [],
    )
  ).map(parseSchemaRow);
  const hasSettingsTable = tableRows.some(
    ({ name }) => name === "private_hot_updater_settings",
  );
  const eventsTable = tableRows.find(({ name }) => name === "bundle_events");
  if (!hasSettingsTable) {
    return {
      componentVersion: null,
      fingerprint: "analytics-schema-drift",
      legacyVersion: null,
    };
  }
  const settings = (
    await executor.query(
      `SELECT key, value FROM private_hot_updater_settings WHERE key IN ('${ANALYTICS_SCHEMA_KEY}', 'version') ORDER BY key`,
      [],
    )
  ).map(parseSettingRow);
  const componentVersion = settingValue(settings, ANALYTICS_SCHEMA_KEY);
  const legacyVersion = settingValue(settings, "version");
  if (eventsTable === undefined) {
    return { componentVersion, fingerprint: null, legacyVersion };
  }
  const indexes = (
    await executor.query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bundle_events' AND sql IS NOT NULL ORDER BY name",
      [],
    )
  ).map(parseSchemaRow);
  const triggers = (
    await executor.query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'bundle_events' AND sql IS NOT NULL ORDER BY name",
      [],
    )
  ).map(parseSchemaRow);
  const fingerprint =
    triggers.length === 0
      ? fingerprintSchema(eventsTable.sql, indexes)
      : "analytics-schema-drift";
  return { componentVersion, fingerprint, legacyVersion };
};

const createD1AnalyticsMigrationStore = (
  executor: D1AnalyticsMigrationExecutor,
): AnalyticsSchemaMigrationStore => ({
  inspect: () => inspectD1AnalyticsSchema(executor),
  async createV2() {
    await executor.batch([d1AnalyticsTableV2, ...d1AnalyticsIndexes]);
  },
  async migrateV1ToV2() {
    await validateRows(executor);
    await executor.batch([
      d1AnalyticsMigrationTableV2,
      `INSERT INTO bundle_events_analytics_v2 (${d1AnalyticsColumnList}) SELECT ${d1AnalyticsColumnList} FROM bundle_events`,
      "DROP TABLE bundle_events",
      "ALTER TABLE bundle_events_analytics_v2 RENAME TO bundle_events",
      ...d1AnalyticsIndexes,
    ]);
  },
  async validateV2() {
    const inspection = await inspectD1AnalyticsSchema(executor);
    if (inspection.fingerprint !== ANALYTICS_SCHEMA_FINGERPRINT_V2) {
      throw new AnalyticsSchemaCompatibilityError(inspection);
    }
    await validateRows(executor);
  },
  async writeComponentVersion(version) {
    await executor.query(
      `INSERT INTO private_hot_updater_settings (key, value) VALUES ('${ANALYTICS_SCHEMA_KEY}', '${version}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [],
    );
  },
});

export const runD1AnalyticsMigration = (
  executor: D1AnalyticsMigrationExecutor,
): Promise<AnalyticsMigrationResult> =>
  migrateAnalyticsSchema(createD1AnalyticsMigrationStore(executor));

const validateD1AnalyticsReadiness = async (
  executor: D1Executor,
): Promise<AnalyticsSchemaInspection> => {
  const inspection = await inspectD1AnalyticsSchema(executor);
  if (
    inspection.componentVersion !== ANALYTICS_SCHEMA_VERSION ||
    inspection.fingerprint !== ANALYTICS_SCHEMA_FINGERPRINT_V2
  ) {
    throw new AnalyticsSchemaNotReadyError(inspection);
  }
  try {
    await validateRows(executor);
  } catch {
    throw new AnalyticsSchemaNotReadyError(inspection);
  }
  return inspection;
};

export const createD1AnalyticsReadinessChecker = (
  executor: D1Executor,
): (() => Promise<void>) => {
  let fullReadiness: Promise<AnalyticsSchemaInspection> | undefined;
  return async () => {
    const existing = fullReadiness;
    if (existing === undefined) {
      const validation = validateD1AnalyticsReadiness(executor);
      fullReadiness = validation;
      try {
        await validation;
      } catch (error) {
        fullReadiness = undefined;
        throw error;
      }
      return;
    }
    let readyInspection: AnalyticsSchemaInspection;
    try {
      readyInspection = await existing;
    } catch (error) {
      fullReadiness = undefined;
      throw error;
    }
    let componentVersion: string | null;
    try {
      componentVersion = await readD1AnalyticsComponentVersion(executor);
    } catch (error) {
      fullReadiness = undefined;
      throw error;
    }
    if (componentVersion !== ANALYTICS_SCHEMA_VERSION) {
      fullReadiness = undefined;
      throw new AnalyticsSchemaNotReadyError({
        ...readyInspection,
        componentVersion,
      });
    }
  };
};
