import type { Kysely } from "kysely";

import {
  builtInTarget,
  createEngineDatabase,
} from "../database/builtInDatabase";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { createEngineSqlMigrator } from "../db/engineSqlMigrator";
import type { ORMSQLProvider, ToolingDatabase } from "../db/types";
import { kyselyExecutor } from "./kyselyExecutor";
import { checkSqlProvider } from "./sqlProviders";

export { kyselyExecutor } from "./kyselyExecutor";

export type { ORMSQLProvider as SQLProvider };

export interface KyselyAdapterConfig<TDatabase extends object = object> {
  readonly db: Kysely<TDatabase>;
  readonly provider: ORMSQLProvider;
}

/**
 * Hot Updater's database on a Kysely instance: the storage engine through the
 * shared SQL core, fenced by the schema settings. `db migrate` and
 * `db generate --sql` apply the engine's SQL schema.
 */
export const kyselyAdapter = <TDatabase extends object>(
  config: KyselyAdapterConfig<TDatabase>,
): ToolingDatabase => {
  const provider = checkSqlProvider("kyselyAdapter", config.provider);
  const executor = kyselyExecutor(
    config.db as unknown as Kysely<object>,
    provider,
  );
  return {
    ...createEngineDatabase({
      name: "kysely",
      adapter: createSqlAdapter({ executor }),
    }),
    provider,
    createMigrator: ({ schema, settings } = builtInTarget) =>
      createEngineSqlMigrator({
        adapterName: "kysely",
        executor,
        schema,
        settings,
      }),
  };
};
