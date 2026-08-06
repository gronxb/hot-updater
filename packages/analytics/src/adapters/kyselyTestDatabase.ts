import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";

export type KyselyTestDatabase = {
  readonly database: Kysely<object>;
  destroy(): Promise<void>;
};

export const createKyselyTestDatabase = (): KyselyTestDatabase => {
  const client = new PGlite();
  const database = new Kysely<object>({ dialect: new PGliteDialect(client) });
  return {
    database,
    async destroy(): Promise<void> {
      await database.destroy();
      await client.close();
    },
  };
};
