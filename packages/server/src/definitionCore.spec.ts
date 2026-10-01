import { PGlite } from "@electric-sql/pglite";
import {
  createEngineDatabase,
  createKvAdapter,
  type DatabaseAdapter,
  type Deployment,
  type EngineDatabase,
  HotUpdaterSchemaMigrationRequiredError,
  migrateCoreSchema,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import {
  createBundleEventRowFixture,
  createBundleFixture,
  createMemoryKeyValueStore,
} from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { kyselyAdapter } from "./adapters/kysely";
import { createHotUpdater } from "./createHotUpdaterCore";
import { apiKeys } from "./plugins/api-keys";
import { insights } from "./plugins/insights";
import { createMigrator } from "./tooling.testFixtures";

/*
 * The CLI and the console write through the definition's core, the path the
 * server's own writes take: these pin what that path does on a SQL database
 * and on a key-value one.
 */

const DAY = 24 * 60 * 60 * 1000;

const deployment = (suffix: string): Deployment => ({
  bundle: createBundleFixture(suffix),
  release: {
    channel: "production",
    enabled: true,
    fingerprintHash: null,
    message: null,
    shouldForceUpdate: false,
    targetAppVersion: "*",
  },
});

/** The definition the CLI loads, on `database`, running Insights and API keys. */
const definitionOn = (database: EngineDatabase) =>
  createHotUpdater({ database, plugins: [insights(), apiKeys()] });

/** The fence's message for a database that lacks both plugins' migrations. */
const migrationRequired = (database: string) =>
  `The tables of plugins "insights" and "apiKeys" are not migrated on ${database}: schema settings "schema.insights" is missing; expected "${insights().schemaVersion}", and "schema.apiKeys" is missing; expected "${apiKeys().schemaVersion}". Run \`hot-updater db migrate\`. A managed server runs only its provider's plugins, and rerunning \`hot-updater init --provider <provider>\` applies the provider's migrations. Run \`hot-updater db\` commands in the server's project: they load the server file named on the command line, or src/hotUpdater.* or src/db.*, and don't read hot-updater.config.ts.`;

/** The same database without `prune`, so writing through it takes no retention lease. */
const withoutPruning = (database: EngineDatabase): EngineDatabase => ({
  ...database,
  adapter: { ...database.adapter, prune: undefined } as DatabaseAdapter,
});

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

describe("definition.core on a SQL database (PGlite)", () => {
  const sqlDatabase = () => {
    const client = new PGlite();
    const db = new Kysely<object>({ dialect: new PGliteDialect(client) });
    disposers.push(async () => {
      await db.destroy();
      await client.close();
    });
    return { client, database: kyselyAdapter({ db, provider: "postgresql" }) };
  };

  const migrate = async (
    hotUpdater: Parameters<typeof createMigrator>[0],
  ): Promise<void> => {
    const result = await createMigrator(hotUpdater).migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();
  };

  it("stops a write until the plugins' migration runs, naming them and the fix", async () => {
    const { database } = sqlDatabase();
    // Core's tables only, as before the definition listed its plugins.
    await migrate(createHotUpdater({ database, clientAccess: "public" }));
    const hotUpdater = definitionOn(database);

    const refused = hotUpdater.core.deploy([deployment("1")]);
    await expect(refused).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    await expect(refused).rejects.toMatchObject({
      plugins: ["insights", "apiKeys"],
      message: migrationRequired("kysely"),
    });

    await migrate(hotUpdater);
    await expect(hotUpdater.core.deploy([deployment("1")])).resolves.toEqual([
      expect.objectContaining({ release: expect.anything() }),
    ]);
  });

  it("deletes an expired Insights row before the write that finds the retention pass due", async () => {
    const { client, database } = sqlDatabase();
    const hotUpdater = definitionOn(database);
    await migrate(hotUpdater);
    // An event received long before Insights' retention, stored without
    // taking the retention lease.
    await definitionOn(withoutPruning(database)).api.insights.recordEvent(
      createBundleEventRowFixture("1", Date.now() - 400 * DAY),
    );
    const expiring = toolingTargetOf([insights()])
      .schema.tables.filter(({ retention }) => retention !== undefined)
      .map(({ name }) => name);
    const rows = async () => {
      let count = 0;
      for (const name of expiring) {
        const { rows } = await client.query<{ n: number }>(
          `select count(*)::int as n from "${name}"`,
        );
        count += rows[0]!.n;
      }
      return count;
    };
    expect(await rows()).toBeGreaterThan(0);

    await hotUpdater.core.deploy([deployment("2")]);

    expect(await rows()).toBe(0);
  });
});

describe("definition.core on a key-value database", () => {
  /** A key-value database as DynamoDB's: its store expires rows itself, and aggregates batch through a log. */
  const kvDatabase = () => {
    const kv = createKvAdapter({ store: createMemoryKeyValueStore() });
    const written: string[] = [];
    const deleted: string[] = [];
    const recording: DatabaseAdapter = {
      ...kv,
      async write(ops) {
        for (const op of ops) {
          (op.type === "delete" ? deleted : written).push(op.table.name);
        }
        return kv.write(ops);
      },
    };
    return {
      kv,
      written,
      deleted,
      database: createEngineDatabase({
        name: "kv",
        adapter: recording,
        aggregateBatching: {},
      }),
    };
  };

  it("stops a write until the plugins' migration runs, naming them and the fix", async () => {
    const { kv, database } = kvDatabase();
    await migrateCoreSchema(kv, "kv");
    const hotUpdater = definitionOn(database);

    await expect(hotUpdater.core.deploy([deployment("1")])).rejects.toThrow(
      migrationRequired("kv"),
    );

    await migrateCoreSchema(kv, "kv", [insights(), apiKeys()]);
    await expect(hotUpdater.core.deploy([deployment("1")])).resolves.toEqual([
      expect.objectContaining({ release: expect.anything() }),
    ]);
  });

  it("writes only core's rows: no retention pass, which the store's expiry replaces, and no batching log", async () => {
    const { kv, database, written, deleted } = kvDatabase();
    await migrateCoreSchema(kv, "kv", [insights(), apiKeys()]);
    const hotUpdater = definitionOn(database);

    await hotUpdater.core.deploy([deployment("1")]);

    const core = new Set(
      toolingTargetOf([]).schema.tables.map(({ name }) => name),
    );
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((name) => !core.has(name))).toEqual([]);
    expect(deleted).toEqual([]);
  });
});
