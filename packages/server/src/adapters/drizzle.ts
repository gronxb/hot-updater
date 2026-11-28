import {
  createSqlAdapter,
  coreSettings,
  coreTarget,
  createEngineDatabase,
  createSettingsMigrator,
} from "@hot-updater/plugin-core";
import type {
  SchemaGenerator,
  SqlDialect,
  ToolingDatabase,
} from "@hot-updater/plugin-core";

import { generateDrizzleEngineSchema } from "../db/engineDrizzleSchema";
import { drizzleExecutor } from "./drizzleExecutor";
import { checkSqlProvider } from "./sqlProviders";

export {
  DrizzleTransactionUnsupportedError,
  SUPPORTED_DRIZZLE_DRIVERS,
} from "./drizzleExecutor";

export type DrizzleProvider = SqlDialect;

export interface DrizzleConfig {
  /** A Drizzle database, or a function that returns one on first use. */
  readonly db: unknown | (() => unknown | Promise<unknown>);
  readonly provider: DrizzleProvider;
}

/**
 * Hot Updater's database on a Drizzle instance: the storage engine through the
 * shared SQL core, fenced by the schema settings. `db generate` writes the
 * Drizzle schema drizzle-kit applies; `db migrate` then checks the tables,
 * sets the PostgreSQL collations drizzle-kit cannot read back, and writes the
 * settings rows the fence checks.
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
    generateSchema: ((version, _name, { schema } = coreTarget) => {
      if (version !== "latest" && version !== coreSettings["schema.core"]) {
        throw new Error(`Invalid version ${version}`);
      }
      return {
        code: generateDrizzleEngineSchema(provider, schema),
        path: "hot-updater-schema.ts",
      };
    }) satisfies SchemaGenerator,
    createMigrator: ({ schema, settings, ordered } = coreTarget) =>
      createSettingsMigrator({
        adapterName: "drizzle",
        executor,
        schema,
        settings,
        ordered,
        applyTables:
          provider === "mysql"
            ? "`npx drizzle-kit generate` and `npx drizzle-kit migrate`"
            : "`npx drizzle-kit push`",
        // drizzle-kit reads a PostgreSQL column's type without its
        // collation, so the generated schema leaves it out.
        collate: () => provider === "postgresql",
      }),
  };
};
