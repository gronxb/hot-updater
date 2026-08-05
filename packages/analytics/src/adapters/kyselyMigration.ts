import { sql, type Kysely } from "kysely";

import {
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
  ANALYTICS_SCHEMA_KEY,
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSchemaCompatibilityError,
  AnalyticsSchemaNotReadyError,
  migrateAnalyticsSchema,
  type AnalyticsMigrationResult,
  type AnalyticsSchemaInspection,
  type AnalyticsSchemaMigrationStore,
} from "../provider/migration";
import { parseBundleEventPersistenceRow } from "../provider/rowParser";
import {
  ANALYTICS_SQL_COLUMNS,
  createAnalyticsV2Statements,
  migrateAnalyticsV1Statements,
  type KyselyAnalyticsDialect,
} from "./kyselyMigrationSql";
import { classifyKyselyAnalyticsSchema } from "./kyselySchema";
import { inspectKyselyAnalyticsCatalog } from "./kyselySchemaCatalog";

export type KyselyAnalyticsConfig<TDatabase extends object = object> = {
  readonly db: Kysely<TDatabase>;
  readonly dialect: KyselyAnalyticsDialect;
};

export interface KyselyAnalyticsMigrationStore extends AnalyticsSchemaMigrationStore {
  assertReady(): Promise<void>;
}

export class InvalidKyselyAnalyticsSettingError extends Error {
  readonly name = "InvalidKyselyAnalyticsSettingError";

  constructor(readonly key: string) {
    super(`Invalid Analytics schema setting: ${key}`);
  }
}

function isMissingSettingsTableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("private_hot_updater_settings") &&
    (message.includes("does not exist") ||
      message.includes("no such table") ||
      message.includes("doesn't exist") ||
      message.includes("not found"))
  );
}

async function getSetting<TDatabase extends object>(
  db: Kysely<TDatabase>,
  key: string,
): Promise<string | null> {
  try {
    const result = await sql<{ readonly value: unknown }>`
      select ${sql.ref("value")} from ${sql.table(
        "private_hot_updater_settings",
      )} where ${sql.ref("key")} = ${key} limit 1
    `.execute(db);
    const value = result.rows[0]?.value;
    if (value === undefined) return null;
    if (typeof value !== "string") {
      throw new InvalidKyselyAnalyticsSettingError(key);
    }
    return value;
  } catch (error) {
    if (isMissingSettingsTableError(error)) return null;
    throw error;
  }
}

async function inspect<TDatabase extends object>(
  config: KyselyAnalyticsConfig<TDatabase>,
): Promise<AnalyticsSchemaInspection> {
  const componentVersion = await getSetting(config.db, ANALYTICS_SCHEMA_KEY);
  const legacyVersion = await getSetting(config.db, "version");
  const catalog = await inspectKyselyAnalyticsCatalog(
    config.db,
    config.dialect,
  );
  return {
    componentVersion,
    fingerprint: classifyKyselyAnalyticsSchema(catalog, config.dialect)
      .fingerprint,
    legacyVersion,
  };
}

async function executeStatements<TDatabase extends object>(
  db: Kysely<TDatabase>,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db);
}

async function validateRows<TDatabase extends object>(
  db: Kysely<TDatabase>,
): Promise<void> {
  let receivedAtMs: number | undefined;
  let id: string | undefined;
  while (true) {
    const cursor =
      receivedAtMs === undefined || id === undefined
        ? sql``
        : sql`where (${sql.ref("received_at_ms")} > ${receivedAtMs} or (${sql.ref("received_at_ms")} = ${receivedAtMs} and ${sql.ref("id")} > ${id}))`;
    const result = await sql<unknown>`
      select ${sql.join(ANALYTICS_SQL_COLUMNS.map((column) => sql.ref(column)))}
      from ${sql.table("bundle_events")} ${cursor}
      order by ${sql.ref("received_at_ms")} asc, ${sql.ref("id")} asc
      limit 1000
    `.execute(db);
    const rows = result.rows.map(parseBundleEventPersistenceRow);
    const last = rows.at(-1);
    if (last === undefined) return;
    receivedAtMs = last.received_at_ms;
    id = last.id;
    if (rows.length < 1000) return;
  }
}

async function validateV2<TDatabase extends object>(
  config: KyselyAnalyticsConfig<TDatabase>,
): Promise<void> {
  const inspection = await inspect(config);
  if (inspection.fingerprint !== ANALYTICS_SCHEMA_FINGERPRINT_V2) {
    throw new AnalyticsSchemaCompatibilityError(inspection);
  }
  await validateRows(config.db);
}

export const createKyselyAnalyticsMigrationStore = <TDatabase extends object>(
  config: KyselyAnalyticsConfig<TDatabase>,
): KyselyAnalyticsMigrationStore => ({
  inspect: () => inspect(config),
  createV2: () =>
    executeStatements(config.db, createAnalyticsV2Statements(config.dialect)),
  async migrateV1ToV2(): Promise<void> {
    const statements = migrateAnalyticsV1Statements(config.dialect);
    if (config.dialect !== "mysql") {
      await executeStatements(config.db, statements);
      return;
    }
    const catalog = await inspectKyselyAnalyticsCatalog(
      config.db,
      config.dialect,
    );
    const resumeIndex = classifyKyselyAnalyticsSchema(
      catalog,
      config.dialect,
    ).mysqlResumeIndex;
    if (resumeIndex === null) {
      throw new AnalyticsSchemaCompatibilityError(await inspect(config));
    }
    await executeStatements(config.db, statements.slice(resumeIndex));
  },
  validateV2: () => validateV2(config),
  async writeComponentVersion(version): Promise<void> {
    if (config.dialect === "mysql") {
      await sql`
        insert into ${sql.table("private_hot_updater_settings")}
          (${sql.ref("key")}, ${sql.ref("value")})
        values (${ANALYTICS_SCHEMA_KEY}, ${version})
        on duplicate key update ${sql.ref("value")} = values(${sql.ref("value")})
      `.execute(config.db);
      return;
    }
    await sql`
      insert into ${sql.table("private_hot_updater_settings")}
        (${sql.ref("key")}, ${sql.ref("value")})
      values (${ANALYTICS_SCHEMA_KEY}, ${version})
      on conflict (${sql.ref("key")}) do update
        set ${sql.ref("value")} = excluded.${sql.ref("value")}
    `.execute(config.db);
  },
  async assertReady(): Promise<void> {
    const inspection = await inspect(config);
    if (
      inspection.componentVersion !== ANALYTICS_SCHEMA_VERSION ||
      inspection.fingerprint !== ANALYTICS_SCHEMA_FINGERPRINT_V2
    ) {
      throw new AnalyticsSchemaNotReadyError(inspection);
    }
    await validateV2(config);
  },
});

export const migrateKyselyAnalyticsSchema = async <TDatabase extends object>(
  config: KyselyAnalyticsConfig<TDatabase>,
): Promise<AnalyticsMigrationResult> => {
  if (config.dialect === "mysql") {
    return migrateAnalyticsSchema(createKyselyAnalyticsMigrationStore(config));
  }
  return config.db.transaction().execute((transaction) =>
    migrateAnalyticsSchema(
      createKyselyAnalyticsMigrationStore({
        db: transaction,
        dialect: config.dialect,
      }),
    ),
  );
};

/**
 * Full readiness is checked once. Warm operations use the component marker as
 * the invalidation signal; physical drift with marker `2` requires a new
 * persistence instance to detect.
 */
export const createKyselyAnalyticsReadiness = <TDatabase extends object>(
  config: KyselyAnalyticsConfig<TDatabase>,
): (() => Promise<void>) => {
  const store = createKyselyAnalyticsMigrationStore(config);
  let fullReadiness: Promise<void> | undefined;
  return async (): Promise<void> => {
    const existing = fullReadiness;
    if (existing === undefined) {
      const validation = store.assertReady();
      fullReadiness = validation;
      try {
        await validation;
      } catch (error) {
        fullReadiness = undefined;
        throw error;
      }
      return;
    }
    await existing;
    let componentVersion: string | null;
    try {
      componentVersion = await getSetting(config.db, ANALYTICS_SCHEMA_KEY);
    } catch (error) {
      fullReadiness = undefined;
      throw error;
    }
    if (componentVersion !== ANALYTICS_SCHEMA_VERSION) {
      fullReadiness = undefined;
      throw new AnalyticsSchemaNotReadyError({
        componentVersion,
        fingerprint: null,
        legacyVersion: null,
      });
    }
  };
};
