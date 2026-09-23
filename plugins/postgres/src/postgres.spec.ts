import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { createHotUpdater } from "@hot-updater/server";
import {
  legacyFacadeSchema,
  legacyFacadeSettings,
} from "@hot-updater/server/database";
import {
  generateEngineSql,
  HotUpdaterSchemaMigrationRequiredError,
} from "@hot-updater/server/db";
import {
  setupDatabasePluginTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it } from "vitest";

import { postgres } from "./postgres";

const SQL_FILE = path.resolve("plugins/postgres/sql/bundles.sql");

/** The checked-in schema: the shared SQL schema, generated, never hand-edited. */
const expectedSql = () =>
  `-- HotUpdater.schema\n\n${generateEngineSql(
    "postgresql",
    legacyFacadeSchema,
    legacyFacadeSettings,
  )
    .map((statement) => `${statement};`)
    .join("\n\n")}\n`;

/** Every data table; the settings rows stay across tests. */
const dataTables = legacyFacadeSchema.tables
  .flatMap((table) => [
    table.name,
    ...table.indexes
      .filter((index) =>
        index.eq.some(
          (column) => table.columns.find(({ name }) => name === column)?.multi,
        ),
      )
      .map((index) => `${table.name}__${index.name}`),
  ])
  .map((name) => `"${name}"`);

let client: PGlite | undefined;

setupDatabasePluginTestSuite({
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({ ...options, clientAccess: { type: "public" } })
        .handlers,
    ),
  name: "postgres plugin",
  migrate: async () => {
    client = new PGlite();
    await client.exec(await fs.readFile(SQL_FILE, "utf8"));
  },
  createPlugin: () => postgres({ dialect: new PGliteDialect(client!) }),
  reset: async () => {
    await client!.exec(`TRUNCATE ${dataTables.join(", ")} CASCADE`);
  },
  dispose: async (plugin) => {
    await plugin.dispose?.();
    client = undefined;
  },
});

describe("postgres plugin schema", () => {
  it("checks in exactly the generated SQL schema as its only SQL file", async () => {
    if (process.env.HOT_UPDATER_UPDATE_SQL === "1") {
      await fs.writeFile(SQL_FILE, expectedSql());
    }
    const files = await fs.readdir(path.dirname(SQL_FILE));
    expect(files.filter((file) => file.endsWith(".sql"))).toEqual([
      "bundles.sql",
    ]);
    // Regenerate with HOT_UPDATER_UPDATE_SQL=1 after the schema changes.
    expect(await fs.readFile(SQL_FILE, "utf8")).toBe(expectedSql());
  });

  it("refuses a database without the schema settings, then serves once they exist", async () => {
    const database = new PGlite();
    const plugin = postgres({ dialect: new PGliteDialect(database) });
    try {
      await expect(plugin.models.channels.list({})).rejects.toBeInstanceOf(
        HotUpdaterSchemaMigrationRequiredError,
      );
      await database.exec(await fs.readFile(SQL_FILE, "utf8"));
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
      expect(
        (
          await database.query(
            "SELECT key, value FROM private_hot_updater_settings ORDER BY key",
          )
        ).rows,
      ).toEqual([
        { key: "schema.apiKeys", value: "1.0.0" },
        { key: "schema.core", value: "1.0.0" },
        { key: "schema.engine", value: "1" },
        { key: "schema.insights", value: "1.0.0" },
      ]);
    } finally {
      await plugin.dispose?.();
    }
  });
});
