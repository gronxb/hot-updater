import {
  builtInSchema,
  builtInSettings,
  createEngineDatabase,
} from "../database/builtInDatabase";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { generateDrizzleEngineSchema } from "../db/engineDrizzleSchema";
import { createSettingsMigrator } from "../db/settingsMigrator";
import type {
  ORMSQLProvider,
  SchemaGenerator,
  ToolingDatabase,
} from "../db/types";
import { drizzleExecutor } from "./drizzleExecutor";
import { checkSqlProvider } from "./sqlProviders";

export {
  DrizzleTransactionUnsupportedError,
  SUPPORTED_DRIZZLE_DRIVERS,
} from "./drizzleExecutor";

export type DrizzleProvider = ORMSQLProvider;

export interface DrizzleConfig {
  /** A Drizzle database, or a function that returns one on first use. */
  readonly db: unknown | (() => unknown | Promise<unknown>);
  readonly provider: DrizzleProvider;
  /** Ignored: Hot Updater reads through SQL; the schema file is for drizzle-kit. */
  readonly schema?: Record<string, unknown>;
}

/**
 * Hot Updater's database on a Drizzle instance: the storage engine through the
 * shared SQL core, fenced by the schema settings. `db generate` writes the
 * Drizzle schema drizzle-kit applies; `db migrate` then writes the settings
 * rows the fence checks.
 */
export const drizzleAdapter = (config: DrizzleConfig): ToolingDatabase => {
  const provider = checkSqlProvider("drizzleAdapter", config.provider);
  const executor = drizzleExecutor(config.db, provider);
  return {
    ...createEngineDatabase({
      name: "drizzle",
      adapter: createSqlAdapter({ executor }),
    }),
    provider,
    generateSchema: (version: Parameters<SchemaGenerator>[0]) => {
      if (version !== "latest" && version !== builtInSettings["schema.core"]) {
        throw new Error(`Invalid version ${version}`);
      }
      return {
        code: generateDrizzleEngineSchema(provider, builtInSchema),
        path: "hot-updater-schema.ts",
      };
    },
    createMigrator: () =>
      createSettingsMigrator({
        adapterName: "drizzle",
        executor,
        settings: builtInSettings,
        applyTables: "`drizzle-kit push` (or your drizzle-kit migrations)",
      }),
  };
};
