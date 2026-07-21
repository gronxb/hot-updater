import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { databaseAnalyticsSupport } from "@hot-updater/plugin-core";
import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
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

it("advertises Analytics support", async () => {
  // Given / When
  const plugin = postgres({ connectionString: "postgres://localhost/test" });

  // Then
  expect(plugin[databaseAnalyticsSupport]).toBe(true);
  await plugin.onUnmount?.();
});

setupDatabasePluginTestSuite({
  name: "postgres fixed-model database plugin",
  migrate: async () => {
    client = new PGlite();
    const schema = await fs.readFile(
      path.resolve("plugins/postgres/sql/bundles.sql"),
      "utf8",
    );
    await client.exec(schema);
  },
  createPlugin: () => postgres({ dialect: new PGliteDialect(getClient()) }),
  reset: async () => {
    await getClient().exec("DELETE FROM bundle_patches; DELETE FROM bundles;");
  },
  dispose: async (plugin) => {
    await plugin.onUnmount?.();
    client = undefined;
  },
});
