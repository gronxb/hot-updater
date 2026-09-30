import net from "node:net";
import path from "node:path";

import type { PhysicalTable } from "@hot-updater/plugin-core/internal";
import {
  conformanceExpiring,
  setupDatabaseAdapterConformanceSuite,
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBundleFixture } from "../../../test-utils/src/databaseTestFixtures";
import { createDatabasePluginApis } from "../assembly/databasePlugins";
import { createInProcessCoreApi } from "../core/api";
import { HotUpdaterSchemaMigrationRequiredError } from "../database/fence";
import { toolingTargetOf } from "../db/coreDatabase";
import { createHotUpdater } from "../index";
import { createInsightsModel, insights } from "../plugins/insights";
import { insightsTestSuite } from "../plugins/insights/testing";
import { mongoAdapter } from "./mongodb";
import { createMongoAdapter } from "./mongodbAdapter";

assertDockerComposeAvailable(
  "MongoDB integration tests need Docker Compose and a running Docker daemon.",
);

const availablePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to allocate a MongoDB test port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const composeFile = path.resolve(
  import.meta.dirname,
  "../../../../examples-server/hono-mongodb/docker-compose.yml",
);
let environment: Record<string, string> | undefined;
const compose = (args: readonly string[]) =>
  execa("docker", ["compose", "-f", composeFile, ...args], {
    env: environment,
  });

let port: number;
const clients: MongoClient[] = [];
/** A client whose default database is `name`, on the replica set. */
const connect = async (name: string) => {
  const client = new MongoClient(
    `mongodb://127.0.0.1:${port}/${name}?replicaSet=rs0&directConnection=true`,
  );
  await client.connect();
  clients.push(client);
  return client;
};

let engine: MongoClient;
let suiteClient: MongoClient;

beforeAll(async () => {
  port = await availablePort();
  environment = {
    COMPOSE_PROJECT_NAME: `hot-updater-mongo-engine-${process.pid}`,
    HOT_UPDATER_E2E_MONGODB_PORT: String(port),
  };
  await compose(["up", "-d", "--wait"]);
  engine = await connect("engine");
  suiteClient = await connect("suite");
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  if (environment) await compose(["down", "-v", "--remove-orphans"]);
}, 60_000);

let tests = 0;
setupDatabaseAdapterConformanceSuite({
  name: "mongodb (replica set)",
  maxOps: 50,
  retention: "ttl",
  createAdapter: async ({ tables, nativePageSize }) => {
    tests += 1;
    const adapter = createMongoAdapter({
      client: engine,
      tablePrefix: `t${tests}_`,
      maxOps: 50,
      ...(nativePageSize === undefined ? {} : { batchSize: nativePageSize }),
    });
    await adapter.migrations!.apply(tables);
    return { adapter };
  },
});

/** What the suite runs: core and the Insights plugin. */
const suiteTarget = toolingTargetOf([insights()]);

setupDatabaseTestSuite({
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({
        ...options,
        plugins: [insights()],
        clientAccess: "public",
      }).handlers,
    ),
  plugins: [
    insightsTestSuite({
      createModel: (database) =>
        createInsightsModel(
          createDatabasePluginApis(database, [insights()]).insights,
        ),
    }),
  ],
  name: "mongoAdapter (replica set)",
  migrate: async () => {
    const migrator = mongoAdapter({ client: suiteClient }).createMigrator!(
      suiteTarget,
    );
    await (await migrator.migrateToLatest()).execute();
  },
  createDatabase: () => mongoAdapter({ client: suiteClient }),
  reset: async () => {
    for (const table of suiteTarget.schema.tables) {
      await suiteClient.db().collection(table.name).deleteMany({});
    }
  },
  dispose: () => undefined,
});

describe("mongoAdapter retention", () => {
  it("stamps each row with retention with _expireAt, which a TTL index deletes by", async () => {
    const client = await connect("retention");
    const adapter = createMongoAdapter({ client });
    const counted: PhysicalTable = {
      name: "counted",
      columns: [
        { name: "bucket", type: "integer", nullable: false },
        { name: "hits", type: "integer", nullable: false },
        { name: "_v", type: "integer", nullable: false },
      ],
      key: ["bucket"],
      indexes: [],
      retention: { column: "bucket", ms: 1_000 },
    };
    await adapter.migrations!.apply([conformanceExpiring, counted]);
    const expireAt = async (table: string, _id: unknown) =>
      (
        await client
          .db()
          .collection(table)
          .findOne({ _id } as never)
      )?._expireAt;
    const row = (id: string, at: number | null) => ({
      id,
      grp: "g",
      at,
      tags: ["t"],
      _v: 0,
    });

    expect(
      await adapter.write([
        { type: "insert", table: conformanceExpiring, row: row("a", 5_000) },
        { type: "insert", table: conformanceExpiring, row: row("b", null) },
        {
          type: "increment",
          table: counted,
          key: [7_000],
          by: { hits: 1 },
          init: { bucket: 7_000, hits: 0, _v: 0 },
        },
      ]),
    ).toEqual({ ok: true });
    expect(await expireAt(conformanceExpiring.name, "a")).toEqual(
      new Date(6_000),
    );
    expect(await expireAt(conformanceExpiring.name, "b")).toBeNull();
    expect(await expireAt(counted.name, 7_000)).toEqual(new Date(8_000));

    // A patch that moves the retention column moves the expiry with it.
    await adapter.write([
      {
        type: "patch",
        table: conformanceExpiring,
        key: ["a"],
        set: { at: 9_000 },
        guard: { v: 0 },
        previous: row("a", 5_000),
      },
    ]);
    expect(await expireAt(conformanceExpiring.name, "a")).toEqual(
      new Date(10_000),
    );
    const [found] = await adapter.get(conformanceExpiring, [["a"]]);
    expect(found).not.toHaveProperty("_expireAt");
    expect(
      await client.db().collection(conformanceExpiring.name).indexes(),
    ).toContainEqual(
      expect.objectContaining({
        name: "_expireAt",
        key: { _expireAt: 1 },
        expireAfterSeconds: 0,
      }),
    );
  });
});

describe("mongoAdapter migrations", () => {
  it("serves behind the fence only after db migrate, then has nothing to migrate", async () => {
    const client = await connect("fenced");
    const database = mongoAdapter({ client });
    const core = createInProcessCoreApi(database.adapter);
    await expect(core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    const migrator = database.createMigrator!();
    await (await migrator.migrateToLatest()).execute();
    await expect(migrator.migrateToLatest()).resolves.toMatchObject({
      operations: [],
    });
    await expect(migrator.getVersion()).resolves.toBe("1.0.0");

    const [result] = await core.deploy([
      {
        bundle: createBundleFixture("1"),
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.0",
        },
      },
    ]);
    const release = result!.release!;
    await expect(core.getRelease(release.id)).resolves.toEqual(release);
  });

  it("refuses a v0 database and a database from before the engine", async () => {
    const v0 = await connect("v0");
    await v0
      .db()
      .collection("private_hot_updater_settings")
      .insertOne({ key: "version", value: "0.21.0" });
    await expect(
      mongoAdapter({ client: v0 }).createMigrator!().migrateToLatest(),
    ).rejects.toThrow("cannot migrate schema 0.21.0 in place");

    const rc = await connect("rc");
    await rc
      .db()
      .collection("private_hot_updater_settings")
      .insertOne({ key: "schema.core", value: "1.0.0" });
    await expect(
      mongoAdapter({ client: rc }).createMigrator!().migrateToLatest(),
    ).rejects.toMatchObject({
      setting: { key: "schema.engine", expected: "1", found: null },
    });
  });
});
