import type { Kysely } from "kysely";

import {
  createLegacyDatabasePlugin,
  legacyFacadeSchema,
  legacyFacadeSettings,
} from "../database/legacyFacade";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { createEngineSqlMigrator } from "../db/engineSqlMigrator";
import type {
  DatabaseAdapterWithCapabilities,
  ORMSQLProvider,
  RelationMode,
} from "../db/types";
import { kyselyExecutor } from "./kyselyExecutor";

export { kyselyExecutor } from "./kyselyExecutor";

type KyselySQLProvider = Exclude<ORMSQLProvider, "mssql">;

export type { RelationMode, KyselySQLProvider as SQLProvider };

export interface KyselyAdapterConfig<TDatabase extends object = object> {
  readonly db: Kysely<TDatabase>;
  readonly provider: KyselySQLProvider;
  /** `fumadb` leaves out database foreign keys; the engine keeps references either way. */
  readonly relationMode?: RelationMode;
}

/**
 * Hot Updater's database on a Kysely instance: the storage engine through the
 * shared SQL core, behind today's `DatabasePlugin` until E2. CockroachDB runs
 * as PostgreSQL until E2 removes it.
 */
export const kyselyAdapter = <TDatabase extends object>(
  config: KyselyAdapterConfig<TDatabase>,
): DatabaseAdapterWithCapabilities => {
  const executor = kyselyExecutor(
    config.db as unknown as Kysely<object>,
    config.provider === "cockroachdb" ? "postgresql" : config.provider,
  );
  const adapter = createSqlAdapter({ executor });
  return {
    ...createLegacyDatabasePlugin({ name: "kysely", adapter, fence: true }),
    adapterName: "kysely",
    provider: config.provider,
    createMigrator: () =>
      createEngineSqlMigrator({
        adapterName: "kysely",
        executor,
        schema: legacyFacadeSchema,
        settings: legacyFacadeSettings,
        foreignKeys: config.relationMode !== "fumadb",
      }),
  };
};
