import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { createHotUpdater } from "@hot-updater/server";
import { builtInSchema, builtInSettings } from "@hot-updater/server/database";
import {
  createDatabaseCoreApi,
  createDatabasePluginApis,
  generateEngineSql,
  HotUpdaterSchemaMigrationRequiredError,
} from "@hot-updater/server/db";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";
import {
  setupDatabaseTestSuite,
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
    builtInSchema,
    builtInSettings,
  )
    .map((statement) => `${statement};`)
    .join("\n\n")}\n`;

/** Every data table; the settings rows stay across tests. */
const dataTables = builtInSchema.tables
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

setupDatabaseTestSuite({
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({
        ...options,
        plugins: [insights()],
        clientAccess: "public",
      }).handlers,
    ),
  createInsightsModel: (database) =>
    createInsightsModel(
      createDatabasePluginApis(database, [insights()]).insights,
    ),
  name: "postgres plugin",
  migrate: async () => {
    client = new PGlite();
    await client.exec(await fs.readFile(SQL_FILE, "utf8"));
  },
  createDatabase: () => postgres({ dialect: new PGliteDialect(client!) }),
  reset: async () => {
    await client!.exec(`TRUNCATE ${dataTables.join(", ")} CASCADE`);
  },
  dispose: async (database) => {
    await database.dispose?.();
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
    const pglite = new PGlite();
    const database = postgres({ dialect: new PGliteDialect(pglite) });
    const core = createDatabaseCoreApi(database);
    try {
      await expect(core.listChannels()).rejects.toBeInstanceOf(
        HotUpdaterSchemaMigrationRequiredError,
      );
      await pglite.exec(await fs.readFile(SQL_FILE, "utf8"));
      await expect(core.listChannels()).resolves.toEqual([]);
      expect(
        (
          await pglite.query(
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
      await database.dispose?.();
    }
  });
});
