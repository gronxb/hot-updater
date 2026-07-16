import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { databaseBundleEventSupport } from "@hot-updater/plugin-core";
import { setupDatabaseAdapterTestSuite } from "@hot-updater/test-utils";
import { PGliteDialect } from "kysely-pglite-dialect";
import { expect, it } from "vitest";

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

it("does not advertise bundle event analytics support", async () => {
  // Given / When
  const adapter = postgres({ connectionString: "postgres://localhost/test" });

  // Then
  expect(adapter[databaseBundleEventSupport]).toBeUndefined();
  await adapter.onUnmount?.();
});

setupDatabaseAdapterTestSuite({
  name: "postgres database adapter v2",
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
