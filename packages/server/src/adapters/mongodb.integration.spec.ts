import net from "node:net";
import path from "node:path";

import {
  createEngineDatabase,
  type DatabaseAdapter,
  HotUpdaterSchemaMigrationRequiredError,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import type { PhysicalTable } from "@hot-updater/plugin-core";
import {
  conformanceExpiring,
  releaseCatalogPartitionsTable,
  setupDatabaseAdapterConformanceSuite,
  setupKeyOrderTestSuite,
  setupDatabaseTestSuite,
  startHttpTestServer,
  insightsTestSuite,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { createBundleFixture } from "@hot-updater/test-utils";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInProcessCoreApi } from "../core/inProcess.testFixtures";
import { createHotUpdater } from "../index";
import { createInsightsModel, insights } from "../plugins/insights";
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

/**
 * Fixtures stamp rows with times near the epoch, so every row with retention
 * is already past its `_expireAt`. MongoDB's TTL monitor would delete those
 * rows on whichever 60-second pass lands inside a test. The suite asserts the
 * stamps and the TTL index, not the monitor, so it runs with the monitor off.
 */
const stopTtlMonitor = (client: MongoClient) =>
  client.db("admin").command({ setParameter: 1, ttlMonitorEnabled: false });

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
  await stopTtlMonitor(engine);
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

setupKeyOrderTestSuite({
  name: "mongodb (replica set)",
  createAdapter: async ({ table }) => {
    const adapter = createMongoAdapter({
      client: await connect("key_order"),
      tablePrefix: "p_",
    });
    await adapter.migrations!.apply([table]);
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
          createHotUpdater({
            database,
            storage: createReleaseCatalogTestStorage(),
            plugins: [insights()],
            clientAccess: "public",
          }).api.insights,
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

/**
 * A database a 1.2 prerelease migrated, without the partition collection,
 * with partitioning off: core's suites run as before, no call names the
 * collection, and MongoDB, which would create it on a first insert, still
 * has none afterwards.
 */
const PARTITIONS = "release_catalog_partitions";
const touches: string[] = [];
const refusingPartitions = (adapter: DatabaseAdapter): DatabaseAdapter =>
  new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const named = JSON.stringify(args, (_, item: unknown) =>
          typeof item === "bigint" ? String(item) : item,
        ).includes(`"name":"${PARTITIONS}"`);
        if (named) {
          touches.push(String(property));
          throw new Error(`${String(property)} touched ${PARTITIONS}`);
        }
        return value.apply(target, args);
      };
    },
  });
let boundaryClient: MongoClient;
setupDatabaseTestSuite({
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({ ...options, clientAccess: "public" }).handlers,
    ),
  name: "mongoAdapter without release_catalog_partitions",
  migrate: async () => {
    boundaryClient = await connect("boundary");
    await (
      await mongoAdapter({ client: boundaryClient }).createMigrator!().migrateToLatest()
    ).execute();
    await boundaryClient.db().collection(PARTITIONS).drop();
  },
  createDatabase: () =>
    createEngineDatabase({
      name: "mongodb",
      adapter: refusingPartitions(
        createMongoAdapter({ client: boundaryClient }),
      ),
    }),
  reset: async () => {
    for (const table of toolingTargetOf([]).schema.tables) {
      if (table.name === PARTITIONS) continue;
      await boundaryClient.db().collection(table.name).deleteMany({});
    }
  },
  dispose: async () => {
    expect(touches).toEqual([]);
    expect(
      await boundaryClient.db().listCollections({ name: PARTITIONS }).toArray(),
    ).toEqual([]);
  },
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
    await expect(migrator.getVersion()).resolves.toBe("1.2.0");

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

  it("creates release_catalog_partitions with simple collation, refuses another, and migrates twice to the same collection", async () => {
    const client = await connect("partitions");
    const table = releaseCatalogPartitionsTable;
    const adapter = createMongoAdapter({ client, tablePrefix: "a_" });
    const describeCollection = async (name: string) => ({
      options: (
        await client.db().listCollections({ name }).toArray()
      )[0]?.options,
      indexes: (await client.db().collection(name).indexes()).map(
        ({ name, key, collation }) => ({ name, key, collation }),
      ),
    });
    await adapter.migrations!.apply([table]);
    const created = await describeCollection("a_release_catalog_partitions");
    expect(created).toEqual({
      options: {},
      indexes: [
        { name: "_id_", key: { _id: 1 }, collation: undefined },
        {
          name: "byScope",
          key: { scope_key: 1, epoch: 1, lower_key: 1 },
          collation: undefined,
        },
      ],
    });
    await adapter.migrations!.apply([table]);
    expect(await describeCollection("a_release_catalog_partitions")).toEqual(
      created,
    );

    // A collection made by hand with a locale collation, whose order and
    // equality are not the keys' bytes.
    await client.db().createCollection("b_release_catalog_partitions", {
      collation: { locale: "en", strength: 2 },
    });
    await expect(
      createMongoAdapter({ client, tablePrefix: "b_" }).migrations!.apply([
        table,
      ]),
    ).rejects.toThrow(
      'MongoDB collection b_release_catalog_partitions has collation {"locale":"en"',
    );
    // A simple collection with a locale index over the keys.
    await client.db().createCollection("c_release_catalog_partitions");
    await client
      .db()
      .collection("c_release_catalog_partitions")
      .createIndex(
        { scope_key: 1, epoch: 1, lower_key: 1 },
        { name: "byScope", collation: { locale: "en", strength: 2 } },
      );
    await expect(
      createMongoAdapter({ client, tablePrefix: "c_" }).migrations!.apply([
        table,
      ]),
    ).rejects.toThrow(
      "MongoDB index byScope on c_release_catalog_partitions has collation",
    );
  });

  it("gives a database a prerelease migrated the partition table by the release notes' mongosh step, run twice", async () => {
    const client = await connect("prerelease");
    const database = mongoAdapter({ client });
    await (await database.createMigrator!().migrateToLatest()).execute();
    // A 1.2 prerelease created every table but this one.
    await client.db().collection("release_catalog_partitions").drop();
    await expect(
      database.createMigrator!().migrateToLatest(),
    ).resolves.toMatchObject({ operations: [] });
    // The release notes' step, as mongosh runs it on the database.
    const step = async () => {
      const db = client.db();
      const name = "release_catalog_partitions";
      if ((await db.listCollections({ name }).toArray()).length === 0) {
        await db.createCollection(name, { collation: { locale: "simple" } });
      }
      await db
        .collection(name)
        .createIndex(
          { scope_key: 1, epoch: 1, lower_key: 1 },
          { name: "byScope", collation: { locale: "simple" } },
        );
    };
    await step();
    await step();
    // The same collection `db migrate` creates on a fresh database.
    const fresh = await connect("prerelease_fresh");
    await (
      await mongoAdapter({ client: fresh }).createMigrator!().migrateToLatest()
    ).execute();
    const shape = async (db: MongoClient) => ({
      options: (
        await db
          .db()
          .listCollections({ name: "release_catalog_partitions" })
          .toArray()
      )[0]?.options,
      indexes: (
        await db.db().collection("release_catalog_partitions").indexes()
      ).map(({ name, key, collation }) => ({ name, key, collation })),
    });
    expect(await shape(client)).toEqual(await shape(fresh));
    // And migrate accepts it.
    await createMongoAdapter({ client }).migrations!.apply([
      releaseCatalogPartitionsTable,
    ]);
  });

  it("refuses a v0 database", async () => {
    const v0 = await connect("v0");
    await v0
      .db()
      .collection("private_hot_updater_settings")
      .insertOne({ key: "version", value: "0.21.0" });
    await expect(
      mongoAdapter({ client: v0 }).createMigrator!().migrateToLatest(),
    ).rejects.toThrow("cannot migrate schema 0.21.0 in place");
  });
});
