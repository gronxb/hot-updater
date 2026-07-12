import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { setupDatabaseAdapterTestSuite } from "@hot-updater/test-utils";
import { PGliteDialect } from "kysely-pglite-dialect";

import { postgres } from "./postgres";

class PostgresTestStateError extends Error {
  readonly name = "PostgresTestStateError";
}

let client: PGlite | undefined;

const getClient = (): PGlite => {
  if (client === undefined) {
    throw new PostgresTestStateError();
  }
  return client;
};

setupDatabaseAdapterTestSuite({
  name: "postgres database adapter v2",
  capabilities: { transaction: true },
  migrate: async () => {
    client = new PGlite();
    const schema = await fs.readFile(
      path.resolve("plugins/postgres/sql/bundles.sql"),
      "utf8",
    );
    await client.exec(schema);
  },
  createAdapter: () => postgres({ dialect: new PGliteDialect(getClient()) }),
  reset: async () => {
    await getClient().exec(
      "DELETE FROM bundle_patches; DELETE FROM bundles; DELETE FROM channels;",
    );
  },
  dispose: async (adapter) => {
    await adapter.onUnmount?.();
    client = undefined;
  },
});
