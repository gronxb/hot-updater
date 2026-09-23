import {
  createLegacyDatabasePlugin,
  legacyFacadeSchema,
  legacyFacadeSettings,
} from "../database/legacyFacade";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { generateDrizzleEngineSchema } from "../db/engineDrizzleSchema";
import { createSettingsMigrator } from "../db/settingsMigrator";
import type {
  DatabaseAdapterWithCapabilities,
  ORMProvider,
  SchemaGenerator,
} from "../db/types";
import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import { drizzleExecutor } from "./drizzleExecutor";

export {
  DrizzleTransactionUnsupportedError,
  SUPPORTED_DRIZZLE_DRIVERS,
} from "./drizzleExecutor";

export type DrizzleProvider = Exclude<
  ORMProvider,
  "cockroachdb" | "mongodb" | "mssql"
>;

export interface DrizzleConfig {
  /** A Drizzle database, or a function that returns one on first use. */
  readonly db: unknown | (() => unknown | Promise<unknown>);
  readonly provider: DrizzleProvider;
  /** Ignored: Hot Updater reads through SQL; the schema file is for drizzle-kit. */
  readonly schema?: Record<string, unknown>;
  /** Ignored: transactions are required, and the first one checks the driver. */
  readonly transaction?: boolean;
}

/**
 * Hot Updater's database on a Drizzle instance: the storage engine through the
 * shared SQL core, behind today's `DatabasePlugin` until E2. `db generate`
 * writes the Drizzle schema drizzle-kit applies; `db migrate` then writes the
 * settings rows the schema fence checks.
 */
export const drizzleAdapter = (
  config: DrizzleConfig,
): DatabaseAdapterWithCapabilities => {
  const executor = drizzleExecutor(config.db, config.provider);
  return {
    ...createLegacyDatabasePlugin({
      name: "drizzle",
      adapter: createSqlAdapter({ executor }),
      fence: true,
    }),
    adapterName: "drizzle",
    provider: config.provider,
    generateSchema: (version: Parameters<SchemaGenerator>[0]) => {
      if (version !== "latest" && version !== HOT_UPDATER_SCHEMA_VERSION) {
        throw new Error(`Invalid version ${version}`);
      }
      return {
        code: generateDrizzleEngineSchema(config.provider, legacyFacadeSchema),
        path: "hot-updater-schema.ts",
      };
    },
    createMigrator: () =>
      createSettingsMigrator({
        adapterName: "drizzle",
        executor,
        settings: legacyFacadeSettings,
        applyTables: "`drizzle-kit push` (or your drizzle-kit migrations)",
      }),
  };
};
