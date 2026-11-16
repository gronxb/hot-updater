import net from "node:net";

import {
  DatabaseSnapshotConflictError,
  DatabaseSnapshotUnsupportedError,
  type DatabaseAdapter,
  type PhysicalTable,
  type ReleaseCatalogPartition,
  type SnapshotReader,
  type StoredRow,
  targetBaseCandidateKey,
  type WriteOp,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/protocol";
import {
  conformanceItems,
  createBundleFixture,
  createReleaseCatalogPartitionFixture,
  releaseCatalogPartitionsTable,
  setupDatabaseAdapterConformanceSuite,
} from "@hot-updater/test-utils";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { execa } from "execa";
import {
  type CommandStartedEvent,
  type CommandSucceededEvent,
  type Document,
  MongoClient,
  type Timestamp,
} from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInProcessCoreApi } from "../core/inProcess.testFixtures";
import { dockerPullFlags, failWithDocker } from "../docker.testFixtures";
import { createHotUpdaterHandlers } from "../handler";
import { mongoAdapter } from "./mongodb";
import { createMongoAdapter, MONGO_SNAPSHOT_RESTARTS } from "./mongodbAdapter";

assertDockerComposeAvailable(
  "MongoDB integration tests need Docker and a running Docker daemon.",
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Retries `attempt` each second until `deadline`, a `Date.now()` time, then
 * fails naming `what` and the last error.
 */
const until = async <T>(
  attempt: () => Promise<T>,
  what: string,
  deadline = Date.now() + 120_000,
) => {
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (Date.now() >= deadline) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Timed out waiting for ${what}: ${reason}`, {
          cause: error,
        });
      }
      await sleep(1000);
    }
  }
};

const containers: string[] = [];
const clients: MongoClient[] = [];
const track = (client: MongoClient) => {
  clients.push(client);
  return client;
};

/**
 * Starts `docker run` arguments as `container`, kept after it exits so its
 * logs explain a failed setup; `afterAll` removes it.
 */
const run = async (
  container: string,
  args: readonly string[],
  deadline: number,
) => {
  containers.push(container);
  await execa(
    "docker",
    ["run", "-d", ...dockerPullFlags(), "--name", container, ...args],
    { timeout: Math.max(deadline - Date.now(), 1000) },
  );
};

/**
 * Members listen on the same port inside the container and on the host, and
 * advertise 127.0.0.1, so the driver on the host dials every member as the
 * members dial each other. One container holds them all. Every wait ends by
 * `deadline`, which stays under the calling hook's timeout, so a stuck start
 * fails with the container's state and the members' logs.
 */
const startReplicaSet = async (
  image: string,
  name: string,
  ports: readonly number[],
  deadline = Date.now() + 240_000,
) => {
  const container = `hot-updater-${name}-${process.pid}`;
  const mongods = ports.map(
    (port, at) =>
      `mkdir -p /data/m${at} && mongod --replSet ${name} --port ${port} --bind_ip_all --dbpath /data/m${at} --logpath /data/m${at}.log --fork --setParameter enableTestCommands=1`,
  );
  const url = (database: string, query = "") =>
    `mongodb://${ports.map((port) => `127.0.0.1:${port}`).join(",")}/${database}?replicaSet=${name}${query}`;
  try {
    await run(
      container,
      [
        ...ports.flatMap((port) => ["-p", `127.0.0.1:${port}:${port}`]),
        image,
        "bash",
        "-c",
        `${mongods.join(" && ")} && tail -f /dev/null`,
      ],
      deadline,
    );
    const nodes = await Promise.all(
      ports.map((port) =>
        until(
          async () => {
            const client = new MongoClient(
              `mongodb://127.0.0.1:${port}/?directConnection=true&serverSelectionTimeoutMS=2000`,
            );
            try {
              await client.db("admin").command({ ping: 1 });
              return track(client);
            } catch (error) {
              await client.close();
              throw error;
            }
          },
          `${name} member on ${port}`,
          deadline,
        ),
      ),
    );
    await nodes[0]!.db("admin").command({
      replSetInitiate: {
        _id: name,
        members: ports.map((port, at) => ({
          _id: at,
          host: `127.0.0.1:${port}`,
          // The first member is the primary whenever it can be.
          priority: at === 0 ? 2 : 1,
          tags: { node: `n${at}` },
        })),
      },
    });
    await Promise.all(nodes.map((node) => node.close()));
    // Each attempt dials anew and gives up after 2 seconds without a
    // primary, not the driver's 30, so the deadline holds: a client whose
    // first connect failed stays closed.
    await until(
      async () => {
        const setup = new MongoClient(
          url("admin", "&serverSelectionTimeoutMS=2000"),
        );
        try {
          const hello = await setup.db("admin").command({ hello: 1 });
          if (!hello.isWritablePrimary || hello.hosts.length !== ports.length) {
            throw new Error("no primary yet");
          }
          // Every secondary is up, so a majority write never waits on a
          // member still starting.
          const status = await setup
            .db("admin")
            .command({ replSetGetStatus: 1 });
          const starting = (
            status.members as { name: string; stateStr: string }[]
          ).filter(
            (member) => !["PRIMARY", "SECONDARY"].includes(member.stateStr),
          );
          if (starting.length > 0) {
            throw new Error(
              `members still starting: ${starting.map((member) => `${member.name} ${member.stateStr}`).join(", ")}`,
            );
          }
          // And every member applies writes: one acknowledged by all.
          await setup
            .db("setup")
            .collection("ready")
            .insertOne(
              { at: new Date() },
              { writeConcern: { w: ports.length, wtimeoutMS: 10_000 } },
            );
        } finally {
          await setup.close();
        }
      },
      `${name} primary`,
      deadline,
    );
  } catch (error) {
    await failWithDocker(`Starting the ${name} replica set`, error, [
      ["ps", "-a", "--filter", `name=^${container}$`],
      ["logs", "--tail", "20", container],
      ["exec", container, "bash", "-c", "tail -n 20 /data/m*.log"],
    ]);
  }
  return { url, probe: track(new MongoClient(url("admin"))) };
};

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close().catch(() => {})));
  await Promise.all(
    containers.map((container) =>
      execa("docker", ["rm", "-f", container]).catch(() => undefined),
    ),
  );
}, 120_000);

/** The finds, getMores and killCursors a client sends, with their replies. */
const monitor = (client: MongoClient) => {
  const started: CommandStartedEvent[] = [];
  const replies = new Map<number, Document>();
  client.on("commandStarted", (event) => {
    if (["find", "getMore", "killCursors"].includes(event.commandName)) {
      started.push(event);
    }
  });
  client.on("commandSucceeded", (event: CommandSucceededEvent) => {
    replies.set(event.requestId, event.reply as Document);
  });
  return {
    started,
    /** The finds a snapshot session sent. */
    finds: () =>
      started.filter(
        (event) =>
          event.commandName === "find" &&
          (event.command.readConcern as { level?: string } | undefined)
            ?.level === "snapshot",
      ),
    plainFinds: () =>
      started.filter(
        (event) =>
          event.commandName === "find" &&
          (event.command.readConcern as { level?: string } | undefined)
            ?.level !== "snapshot",
      ),
    replyOf: (event: CommandStartedEvent) => replies.get(event.requestId),
    clear: () => {
      started.length = 0;
      replies.clear();
    },
  };
};

const sessionOf = (event: CommandStartedEvent) =>
  (
    event.command.lsid as { id?: { toString(format: string): string } }
  )?.id?.toString("hex") ?? null;
const atClusterTimeOf = (event: CommandStartedEvent) =>
  (event.command.readConcern as { atClusterTime?: Timestamp } | undefined)
    ?.atClusterTime;

const item = (id: string, values: Partial<StoredRow> = {}): StoredRow => ({
  id,
  grp: "g",
  score: 0,
  ratio: null,
  flag: false,
  label: null,
  tags: null,
  payload: null,
  note: null,
  slot: null,
  _v: 0,
  ...values,
});
const insert = (row: StoredRow): WriteOp => ({
  type: "insert",
  table: conformanceItems,
  row,
});
const patch = async (
  adapter: DatabaseAdapter,
  id: string,
  set: StoredRow,
): Promise<WriteOp> => {
  const [previous] = await adapter.get(conformanceItems, [[id]]);
  return {
    type: "patch",
    table: conformanceItems,
    key: [id],
    set,
    guard: { v: previous!._v as number },
    previous: previous!,
  };
};
/** A stored partition without one bundle's release, as a disable rewrites it. */
const withoutBundle = (
  partition: ReleaseCatalogPartition,
  bundleId: string,
): ReleaseCatalogPartition => {
  const catalog = JSON.parse(partition.payload);
  const kept: number[] = [];
  catalog.releaseDescriptors.forEach(
    (descriptor: { bundleId: string }, index: number) => {
      if (descriptor.bundleId !== bundleId) kept.push(index);
    },
  );
  const [segment] = catalog.segments;
  segment.releaseIndexes = segment.releaseIndexes
    .filter((index: number) => kept.includes(index))
    .map((index: number) => kept.indexOf(index));
  segment.rollbackReleaseIndexes = kept.map((_, index) => index);
  catalog.releaseDescriptors = kept.map(
    (index) => catalog.releaseDescriptors[index],
  );
  const payload = JSON.stringify(catalog);
  return {
    ...partition,
    byteSize: new TextEncoder().encode(payload).byteLength,
    payload,
  };
};

const ok = async (adapter: DatabaseAdapter, ops: readonly WriteOp[]) =>
  expect(await adapter.write(ops)).toEqual({ ok: true });

describe("MongoDB snapshot reads on a three-member replica set", () => {
  let set: Awaited<ReturnType<typeof startReplicaSet>>;
  /**
   * A client configured against both rules: secondary reads, and a
   * majority read concern that would replace the snapshot one.
   */
  const hostile = (database: string, appName?: string) => {
    const client = track(
      new MongoClient(
        set.url(
          database,
          `&readPreference=secondaryPreferred&readConcernLevel=majority${appName ? `&appName=${appName}` : ""}`,
        ),
        { monitorCommands: true },
      ),
    );
    return { client, events: monitor(client) };
  };
  const primaryAddress = async () =>
    String((await set.probe.db("admin").command({ hello: 1 })).primary);
  let tables = 0;
  const adapterOn = async (
    client: MongoClient,
    options: { readonly batchSize?: number } = {},
    table: PhysicalTable = conformanceItems,
  ) => {
    tables += 1;
    const adapter = createMongoAdapter({
      client,
      tablePrefix: `s${tables}_`,
      ...options,
    });
    await adapter.migrations!.apply([table]);
    return adapter;
  };
  /** Enables `failCommand` on the primary for the commands of `appName`. */
  const failCommand = async (mode: Document | string, data: Document) => {
    const primary = track(
      new MongoClient(
        `mongodb://${await primaryAddress()}/?directConnection=true`,
      ),
    );
    await primary
      .db("admin")
      .command({ configureFailPoint: "failCommand", mode, data });
    return () =>
      primary
        .db("admin")
        .command({ configureFailPoint: "failCommand", mode: "off" });
  };

  beforeAll(async () => {
    const ports = await Promise.all([1, 2, 3].map(() => availablePort()));
    set = await startReplicaSet("mongo:7-jammy", "rs3", ports);
  }, 300_000);

  describe("adapter conformance through a client set to read secondaries", () => {
    let suite = 0;
    setupDatabaseAdapterConformanceSuite({
      name: "mongodb (three members, secondaryPreferred, majority)",
      maxOps: 50,
      retention: "ttl",
      writers: 8,
      createAdapter: async ({ tables, nativePageSize }) => {
        suite += 1;
        const { client } = hostile("conformance");
        const adapter = createMongoAdapter({
          client,
          tablePrefix: `c${suite}_`,
          maxOps: 50,
          ...(nativePageSize === undefined
            ? {}
            : { batchSize: nativePageSize }),
        });
        await adapter.migrations!.apply(tables);
        return { adapter };
      },
    });
  });

  it("reads on the primary with a secondary read preference, even from a lagging secondary", async () => {
    const { client, events } = hostile("routing");
    const adapter = await adapterOn(client);
    await ok(adapter, [insert(item("r", { score: 1 }))]);
    const database = mongoAdapter({ client });
    await (await database.createMigrator!().migrateToLatest()).execute();
    const primary = await primaryAddress();
    // Hold one secondary's replication; a majority write still commits on
    // the primary and the other secondary.
    const secondaries = (
      (await set.probe.db("admin").command({ hello: 1 })).hosts as string[]
    ).filter((host) => host !== primary);
    const lagging = track(
      new MongoClient(`mongodb://${secondaries[0]}/?directConnection=true`),
    );
    await lagging.db("admin").command({ fsync: 1, lock: true });
    try {
      await ok(adapter, [await patch(adapter, "r", { score: 2 })]);
      events.clear();
      for (let read = 0; read < 10; read += 1) {
        expect((await adapter.get(conformanceItems, [["r"]]))[0]?.score).toBe(
          2,
        );
        expect(
          (
            await adapter.query(conformanceItems, {
              index: "byGroup",
              eq: ["g"],
              order: "asc",
              limit: 10,
            })
          ).map((row) => row.score),
        ).toEqual([2]);
      }
      // The schema fence's settings read, and the migrator's own.
      await createInProcessCoreApi(database.adapter).listChannels();
      await expect(
        database.createMigrator!().migrateToLatest(),
      ).resolves.toMatchObject({ operations: [] });
      expect(events.plainFinds().length).toBeGreaterThan(20);
      expect(
        new Set(events.plainFinds().map((event) => event.address)),
      ).toEqual(new Set([primary]));
    } finally {
      await lagging.db("admin").command({ fsyncUnlock: 1 });
    }
  });

  it("migrates a byte-ordered table through a client set to read a secondary that has not replicated it", async () => {
    // The collation check reads the collection and its indexes; on a
    // secondary still behind the create, they don't exist yet.
    const primary = await primaryAddress();
    const { config } = await set.probe
      .db("admin")
      .command({ replSetGetConfig: 1 });
    const behind = (
      config.members as { host: string; tags: { node: string } }[]
    ).find((member) => member.host !== primary)!;
    const client = track(
      new MongoClient(
        set.url(
          "behind",
          `&readPreference=secondary&readPreferenceTags=node:${behind.tags.node}`,
        ),
      ),
    );
    const lagging = track(
      new MongoClient(`mongodb://${behind.host}/?directConnection=true`),
    );
    await lagging.db("admin").command({ fsync: 1, lock: true });
    try {
      const adapter = createMongoAdapter({ client });
      await adapter.migrations!.apply([releaseCatalogPartitionsTable]);
      await adapter.migrations!.apply([releaseCatalogPartitionsTable]);
    } finally {
      await lagging.db("admin").command({ fsyncUnlock: 1 });
    }
  });

  it("carries the first reply's cluster time on every later read, in finds without getMore", async () => {
    const { client, events } = hostile("monitoring");
    // Two documents a batch, so a page takes several finds.
    const adapter = await adapterOn(client, { batchSize: 2 });
    await ok(
      adapter,
      Array.from({ length: 7 }, (_, at) => insert(item(`m${at}`))),
    );
    events.clear();

    const read = await adapter.readSnapshot!(async (reader) => {
      // Two first reads at once: the second waits for the first's reply.
      const [first, page] = await Promise.all([
        reader.get(conformanceItems, [["m0"], ["m1"], ["m2"], ["missing"]]),
        reader.query(conformanceItems, {
          index: "byGroup",
          eq: ["g"],
          order: "asc",
          limit: 7,
        }),
      ]);
      return { first, page };
    });
    expect(read.first.map((row) => row?.id ?? null)).toEqual([
      "m0",
      "m1",
      "m2",
      null,
    ]);
    expect(read.page.map((row) => row.id)).toEqual(
      Array.from({ length: 7 }, (_, at) => `m${at}`),
    );

    const finds = events.finds();
    // 4 ids in batches of 2, and 7 rows in batches of 2.
    expect(finds.length).toBe(2 + 4);
    expect(
      events.started.some((event) => event.commandName === "getMore"),
    ).toBe(false);
    const [first, ...later] = finds;
    expect(first!.command.readConcern).toMatchObject({ level: "snapshot" });
    expect(atClusterTimeOf(first!)).toBeUndefined();
    const chosen = events.replyOf(first!)?.cursor?.atClusterTime as Timestamp;
    expect(chosen).toBeDefined();
    for (const event of later) {
      expect(event.command.readConcern).toMatchObject({ level: "snapshot" });
      expect(atClusterTimeOf(event)?.equals(chosen)).toBe(true);
    }
    // One session for every find, on the primary; cursors a short batch
    // left open are killed outside it.
    expect(new Set(finds.map(sessionOf)).size).toBe(1);
    expect(new Set(finds.map((event) => event.address))).toEqual(
      new Set([await primaryAddress()]),
    );
    const kills = events.started.filter(
      (event) => event.commandName === "killCursors",
    );
    expect(kills.length).toBeGreaterThan(0);
    expect(kills.map(sessionOf)).not.toContain(sessionOf(first!));
  });

  it("reads a page larger than one 16 MiB batch in several finds without getMore", async () => {
    const { client, events } = hostile("large");
    const adapter = await adapterOn(client);
    const note = "x".repeat(1024 * 1024);
    for (let at = 0; at < 30; at += 10) {
      await ok(
        adapter,
        Array.from({ length: 10 }, (_, offset) =>
          insert(item(`l${String(at + offset).padStart(2, "0")}`, { note })),
        ),
      );
    }
    events.clear();
    const rows = await adapter.readSnapshot!((reader) =>
      reader.query(conformanceItems, {
        index: "all",
        eq: [],
        order: "asc",
        limit: 30,
      }),
    );
    expect(rows.map((row) => row.id)).toEqual(
      Array.from({ length: 30 }, (_, at) => `l${String(at).padStart(2, "0")}`),
    );
    expect(rows.every((row) => row.note === note)).toBe(true);
    const finds = events.finds();
    expect(finds.length).toBeGreaterThan(1);
    expect(
      events.started.some((event) => event.commandName === "getMore"),
    ).toBe(false);
    const chosen = events.replyOf(finds[0]!)?.cursor
      ?.atClusterTime as Timestamp;
    for (const event of finds.slice(1)) {
      expect(atClusterTimeOf(event)?.equals(chosen)).toBe(true);
    }
  });

  it("continues a snapshot page past rows whose sort column is null, in both orders", async () => {
    // As core's ios_devices.byRegistration sorts by a nullable time.
    const sorted: PhysicalTable = {
      name: "nullable_sorted",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "grp", type: "string", nullable: false },
        { name: "at", type: "integer", nullable: true },
        { name: "_v", type: "integer", nullable: false },
      ],
      key: ["id"],
      indexes: [{ name: "byAt", eq: ["grp"], sort: ["at"] }],
    };
    const { client } = hostile("nullable");
    // One document a batch: every row after the first is a continuation.
    const adapter = await adapterOn(client, { batchSize: 1 }, sorted);
    const times = [null, 3, null, 1, 2, null, 2];
    await ok(
      adapter,
      times.map((at, position) => ({
        type: "insert",
        table: sorted,
        row: { id: `n${position}`, grp: "g", at, _v: 0 },
      })),
    );
    for (const order of ["asc", "desc"] as const) {
      const request = { index: "byAt", eq: ["g"], order, limit: 20 };
      const plain = await adapter.query(sorted, request);
      expect(plain).toHaveLength(times.length);
      await expect(
        adapter.readSnapshot!((reader) => reader.query(sorted, request)),
      ).resolves.toEqual(plain);
    }
  });

  it("never pairs a head with an older, majority-committed row written after it", async () => {
    const { client } = hostile("older-row");
    const adapter = await adapterOn(client);
    // The head names generation 5; nothing covers its range yet.
    await ok(adapter, [insert(item("head", { grp: "heads", score: 5 }))]);
    const covering = () =>
      adapter.query(conformanceItems, {
        index: "byGroup",
        eq: ["rows"],
        order: "desc",
        limit: 1,
      });
    let injected = false;
    const read = await adapter.readSnapshot!(async (reader) => {
      const [head] = await reader.get(conformanceItems, [["head"]]);
      if (!injected) {
        injected = true;
        // Between the two reads, a majority-committed row stamped 3, at or
        // below the head's 5, lands in the range: a stamp check accepts it.
        await ok(adapter, [insert(item("row", { grp: "rows", score: 3 }))]);
        expect((await covering()).map((row) => row.score)).toEqual([3]);
      }
      const rows = await reader.query(conformanceItems, {
        index: "byGroup",
        eq: ["rows"],
        order: "desc",
        limit: 1,
      });
      return { head: head!.score, rows: rows.map((row) => row.score) };
    });
    // The state the head was read in had no covering row.
    expect(read).toEqual({ head: 5, rows: [] });
  });

  it.each([
    ["SnapshotTooOld", { errorCode: 239 }],
    ["SnapshotUnavailable", { errorCode: 246 }],
    ["an election (InterruptedDueToReplStateChange)", { errorCode: 11602 }],
    ["a dropped connection", { closeConnection: true }],
  ])(
    "starts the whole read over on a fresh snapshot after %s",
    async (_name, failure) => {
      const appName = `restart-${Math.random().toString(36).slice(2, 8)}`;
      const { client, events } = hostile("restart", appName);
      const adapter = await adapterOn(client);
      await ok(adapter, [
        insert(item("a", { score: 1 })),
        insert(item("b", { score: 1 })),
      ]);
      events.clear();
      let runs = 0;
      let off: (() => Promise<unknown>) | undefined;
      try {
        const read = await adapter.readSnapshot!(async (reader) => {
          runs += 1;
          const [a] = await reader.get(conformanceItems, [["a"]]);
          if (runs === 1) {
            // Both rows move on, then the next read fails once.
            await ok(adapter, [
              await patch(adapter, "a", { score: 2 }),
              await patch(adapter, "b", { score: 2 }),
            ]);
            off = await failCommand(
              { times: 1 },
              { failCommands: ["find"], appName, ...failure },
            );
          }
          const [b] = await reader.get(conformanceItems, [["b"]]);
          return [a!.score, b!.score];
        });
        expect(runs).toBe(2);
        // The second run read one state, the newer one.
        expect(read).toEqual([2, 2]);
      } finally {
        await off?.();
      }
      // Two snapshots: each run's first read chose its own, later, time.
      const openers = events
        .finds()
        .filter((event) => atClusterTimeOf(event) === undefined);
      expect(openers).toHaveLength(2);
      const [before, after] = openers.map(
        (event) => events.replyOf(event)?.cursor?.atClusterTime as Timestamp,
      );
      expect(after!.greaterThan(before!)).toBe(true);
    },
  );

  describe("partitioned release catalogs through core", () => {
    let databases = 0;
    const scopeKeyOf = (channel: string) =>
      createReleaseCatalogScopeKey({
        channelKey: encodeChannelKey(channel),
        platform: "ios",
        strategy: "APP_VERSION",
      });
    /**
     * Core over a client set to read secondaries, seeded through today's
     * writer, with a hook that writes just before a snapshot opens: the
     * state a snapshot reread finds after the plain read of the head.
     */
    const seeded = async () => {
      databases += 1;
      const { client, events } = hostile(`catalog${databases}`);
      const database = mongoAdapter({ client });
      await (await database.createMigrator!().migrateToLatest()).execute();
      const hooks: {
        beforeSnapshot?: () => Promise<void>;
        /** Runs once, inside a snapshot, after a read of a partition page. */
        afterPartitionPage?: () => Promise<void>;
      } = {};
      const base = database.adapter;
      const adapter = Object.assign(Object.create(base), {
        readSnapshot: async <T>(
          read: (reader: SnapshotReader) => Promise<T>,
        ) => {
          const hook = hooks.beforeSnapshot;
          hooks.beforeSnapshot = undefined;
          await hook?.();
          return base.readSnapshot!((reader) =>
            read({
              get: (table, keys) => reader.get(table, keys),
              query: async (table, request) => {
                const rows = await reader.query(table, request);
                const during = hooks.afterPartitionPage;
                if (during && table.name === "release_catalog_partitions") {
                  hooks.afterPartitionPage = undefined;
                  await during();
                }
                return rows;
              },
            }),
          );
        },
      }) as DatabaseAdapter;
      const core = createInProcessCoreApi(adapter);
      let suffix = 100;
      for (const [channel, ranges] of [
        [
          "production",
          ["1.0.0", "1.0.0", ">=1.1.0 <2.0.0", "2.0.0", "3.0.0", ">=2.0.0"],
        ],
        ["beta", ["5.0.0", "6.0.0"]],
      ] as const) {
        for (const targetAppVersion of ranges) {
          suffix += 1;
          await core.deploy([
            {
              bundle: createBundleFixture(String(suffix)),
              release: {
                channel,
                enabled: true,
                fingerprintHash: null,
                message: null,
                shouldForceUpdate: false,
                targetAppVersion,
              },
            },
          ]);
        }
      }
      const fixture = createReleaseCatalogPartitionFixture(base);
      const check = async (version: string, channel = "production") => {
        const response = await createHotUpdaterHandlers({
          api: { core },
        }).client(
          new Request(
            `http://localhost/release-catalogs/app-version/ios/${encodeChannelKey(channel)}/${version}`,
          ),
        );
        return [response.status, await response.text()] as const;
      };
      return { check, core, events, fixture, hooks };
    };
    const versions = ["0.9.0", "1.0.0", "1.5.0", "2.0.0", "2.5.0", "3.0.0"];

    it("turns partitioning on after the probe reads its rows in one snapshot, and converts on the next write", async () => {
      const { core, fixture } = await seeded();
      await expect(core.enableReleaseCatalogPartitioning()).resolves.toEqual({
        partitioning: "on",
        changed: true,
      });
      await core.deploy([
        {
          bundle: createBundleFixture("900"),
          release: {
            channel: "production",
            enabled: true,
            fingerprintHash: null,
            message: null,
            shouldForceUpdate: false,
            targetAppVersion: "4.0.0",
          },
        },
      ]);
      const head = await fixture.readRow(scopeKeyOf("production"));
      expect(head.payload).toContain('"layout":"partitioned"');
    });

    it("refuses a partitions collection made by hand with a case-folding collation, and sets nothing", async () => {
      databases += 1;
      const { client } = hostile(`catalog${databases}`);
      const database = mongoAdapter({ client });
      await (await database.createMigrator!().migrateToLatest()).execute();
      await client.db().dropCollection("release_catalog_partitions");
      await client.db().createCollection("release_catalog_partitions", {
        collation: { locale: "en", strength: 2 },
      });
      const core = createInProcessCoreApi(database.adapter);
      await expect(core.enableReleaseCatalogPartitioning()).rejects.toMatchObject(
        { code: "PARTITIONS_KEY_ORDER" },
      );
      expect(await core.getReleaseCatalogPartitioning()).toMatchObject({
        switch: "off",
      });
      expect(
        await client
          .db()
          .collection("release_catalog_partitions")
          .countDocuments(),
      ).toBe(0);
    });

    it("answers as the compact row did, reading the head plainly, then the head and its row in one snapshot, without getMore", async () => {
      const { check, core, events, fixture } = await seeded();
      const before = await Promise.all(
        versions.map((version) => check(version)),
      );
      const rowBefore = await core.getReleaseCatalogRow(
        scopeKeyOf("production"),
      );
      // Compact scopes never open a snapshot.
      expect(events.finds()).toEqual([]);
      await fixture.partition(scopeKeyOf("production"));
      events.clear();
      expect(await check("1.5.0")).toEqual(before[2]);
      const plain = events
        .plainFinds()
        .filter((event) =>
          String(event.command.find).endsWith("release_catalogs"),
        );
      expect(plain).toHaveLength(1);
      const snapshot = events.finds();
      expect(snapshot.map((event) => String(event.command.find))).toEqual([
        expect.stringMatching(/release_catalogs$/),
        expect.stringMatching(/release_catalog_partitions$/),
      ]);
      // The second read carries the first reply's cluster time.
      expect(
        atClusterTimeOf(snapshot[1]!)?.equals(
          events.replyOf(snapshot[0]!)?.cursor?.atClusterTime as Timestamp,
        ),
      ).toBe(true);
      expect(snapshot[1]!.command.collation).toEqual({ locale: "simple" });
      expect(
        events.started.filter((event) => event.commandName === "getMore"),
      ).toEqual([]);
      expect(
        await Promise.all(versions.map((version) => check(version))),
      ).toEqual(before);
      expect(await core.getReleaseCatalogRow(scopeKeyOf("production"))).toEqual(
        rowBefore,
      );
    });

    it("answers the compact row a snapshot reread finds after a head (head to compact)", async () => {
      const { check, events, fixture, hooks } = await seeded();
      const { compact, rows } = await fixture.partition(
        scopeKeyOf("production"),
      );
      hooks.beforeSnapshot = async () => {
        await fixture.publishCompact(scopeKeyOf("production"), {
          catalogHash: "sha256:compact-next",
          generation: compact.generation + 1,
          payload: compact.payload,
        });
        await fixture.deleteRows(scopeKeyOf("production"), rows);
      };
      events.clear();
      const [status, body] = await check("1.0.0");
      expect(status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({
        catalogHash: "sha256:compact-next",
        generation: compact.generation + 1,
      });
      // The snapshot read the compact row, and no partition after it.
      expect(events.finds().map((event) => String(event.command.find))).toEqual(
        [expect.stringMatching(/release_catalogs$/)],
      );
    });

    it("assembles a scope a writer converted between the page and its snapshot (compact to head), and pages every scope", async () => {
      const { core, fixture, hooks } = await seeded();
      const before = await core.listReleaseCatalogs({ limit: 10 });
      await fixture.partition(scopeKeyOf("production"));
      hooks.beforeSnapshot = async () => {
        await fixture.partition(scopeKeyOf("beta"));
      };
      expect(await core.listReleaseCatalogs({ limit: 10 })).toEqual(before);
      expect((await fixture.readRow(scopeKeyOf("beta"))).payload).toContain(
        '"layout":"partitioned"',
      );
      // Pages of one row, both orders, with a write between them.
      for (const order of ["asc", "desc"] as const) {
        const pages = [];
        let after: string | undefined;
        for (;;) {
          const page = await core.listReleaseCatalogs({
            limit: 1,
            order,
            ...(after === undefined ? {} : { after }),
          });
          if (page.length === 0) break;
          pages.push(...page);
          after = page.at(-1)!.scope_key;
          hooks.beforeSnapshot = async () => {
            const beta = await fixture.readRow(scopeKeyOf("beta"));
            const old = await fixture.rows(scopeKeyOf("beta"));
            const epoch = crypto.randomUUID();
            await fixture.writeRows(
              scopeKeyOf("beta"),
              old.map((row) => ({ ...row, epoch })),
            );
            await fixture.publishHead(scopeKeyOf("beta"), {
              catalogHash: beta.catalog_hash,
              epoch,
              generation: beta.generation,
              remove: old,
            });
          };
        }
        hooks.beforeSnapshot = undefined;
        expect(pages).toEqual(order === "asc" ? before : [...before].reverse());
      }
    });

    it("unions one snapshot's rows when a write lands between two finds of one patch-base read", async () => {
      const { core, events, fixture, hooks } = await seeded();
      const { compact, epoch } = await fixture.partition(
        scopeKeyOf("production"),
      );
      const query = () =>
        core.findBaseBundleIds(
          targetBaseCandidateKey({
            appVersion: "*",
            channel: "production",
            fingerprintHash: null,
            platform: "ios",
          })!,
          createBundleFixture("999").id,
          100,
        );
      const before = await query();
      // ">=2.0.0" (bundle 106) sits in every row from 2.0.0 up. After the
      // snapshot's first partition page, it is disabled at G+1 in all of
      // them, committed with the head.
      const disabled = createBundleFixture("106").id;
      expect(before).toContain(disabled);
      hooks.afterPartitionPage = async () => {
        const holding = (await fixture.rows(scopeKeyOf("production"))).filter(
          (row) =>
            row.epoch === epoch && row.partition.payload.includes(disabled),
        );
        expect(holding.length).toBeGreaterThan(1);
        await fixture.publishHead(scopeKeyOf("production"), {
          catalogHash: "sha256:disabled",
          epoch,
          generation: compact.generation + 1,
          write: holding.map((row) => ({
            ...row,
            generation: compact.generation + 1,
            partition: withoutBundle(row.partition, disabled),
          })),
        });
      };
      events.clear();
      // G's union: the snapshot never sees the write.
      expect(await query()).toEqual(before);
      expect(hooks.afterPartitionPage).toBeUndefined();
      const finds = events.finds();
      expect(
        finds.filter((event) =>
          String(event.command.find).endsWith("release_catalog_partitions"),
        ).length,
      ).toBeGreaterThan(1);
      const time = events.replyOf(finds[0]!)?.cursor
        ?.atClusterTime as Timestamp;
      for (const event of finds.slice(1)) {
        expect(atClusterTimeOf(event)?.equals(time)).toBe(true);
      }
      expect(
        events.started.filter((event) => event.commandName === "getMore"),
      ).toEqual([]);
      // The next read sees G+1, without the disabled release.
      expect(await query()).not.toContain(disabled);
    });

    it("finds the patch bases the compact row did, in one snapshot", async () => {
      const { core, fixture } = await seeded();
      const query = (appVersion: string) =>
        core.findBaseBundleIds(
          targetBaseCandidateKey({
            appVersion,
            channel: "production",
            fingerprintHash: null,
            platform: "ios",
          })!,
          createBundleFixture("999").id,
          100,
        );
      const ranges = ["1.0.0", "1.5.0", "*", ">=1.0.0 <3.0.0"];
      const before = await Promise.all(ranges.map(query));
      expect(before.some((ids) => ids.length > 1)).toBe(true);
      await fixture.partition(scopeKeyOf("production"));
      expect(await Promise.all(ranges.map(query))).toEqual(before);
    });
  });

  it(`fails closed after ${MONGO_SNAPSHOT_RESTARTS} restarts, and never restarts for the read's own error`, async () => {
    const appName = `exhaust-${Math.random().toString(36).slice(2, 8)}`;
    const { client, events } = hostile("exhaust", appName);
    const adapter = await adapterOn(client);
    await ok(adapter, [insert(item("a"))]);
    events.clear();
    let runs = 0;
    const off = await failCommand("alwaysOn", {
      failCommands: ["find"],
      appName,
      errorCode: 246,
    });
    try {
      await expect(
        adapter.readSnapshot!(async (reader) => {
          runs += 1;
          return reader.get(conformanceItems, [["a"]]);
        }),
      ).rejects.toBeInstanceOf(DatabaseSnapshotConflictError);
    } finally {
      await off();
    }
    expect(runs).toBe(MONGO_SNAPSHOT_RESTARTS + 1);
    expect(events.finds()).toHaveLength(MONGO_SNAPSHOT_RESTARTS + 1);

    runs = 0;
    const own = new Error("the read's own");
    await expect(
      adapter.readSnapshot!(async (reader) => {
        runs += 1;
        await reader.get(conformanceItems, [["a"]]);
        throw own;
      }),
    ).rejects.toBe(own);
    expect(runs).toBe(1);
  });

  it("answers from one committed state across a real failover between reads", async () => {
    const { client } = hostile("failover");
    const adapter = await adapterOn(client);
    await ok(adapter, [
      insert(item("head", { score: 1 })),
      insert(item("row", { score: 1 })),
    ]);
    let runs = 0;
    const read = await adapter.readSnapshot!(async (reader) => {
      runs += 1;
      const [head] = await reader.get(conformanceItems, [["head"]]);
      if (runs === 1) {
        await set.probe
          .db("admin")
          .command({ replSetStepDown: 10, secondaryCatchUpPeriodSecs: 5 })
          .catch(() => undefined);
        // A write on the new primary moves both rows on.
        await until(
          async () =>
            ok(adapter, [
              await patch(adapter, "head", { score: 2 }),
              await patch(adapter, "row", { score: 2 }),
            ]),
          "a write on the new primary",
        );
      }
      const [row] = await reader.get(conformanceItems, [["row"]]);
      return [head!.score, row!.score];
    });
    // Either the first snapshot survived the election, or the read started
    // over after the write: never a mixture.
    expect([
      [1, 1],
      [2, 2],
    ]).toContainEqual(read);
  }, 120_000);
});

describe("MongoDB 4.4, which has no snapshot reads", () => {
  let client: MongoClient;
  let url: (database: string, query?: string) => string;

  beforeAll(async () => {
    const port = await availablePort();
    const set = await startReplicaSet("mongo:4.4", "rs44", [port]);
    url = set.url;
    client = track(new MongoClient(url("legacy"), { monitorCommands: true }));
  }, 300_000);

  let suite = 0;
  setupDatabaseAdapterConformanceSuite({
    name: "mongodb 4.4 (replica set)",
    maxOps: 50,
    retention: "ttl",
    writers: 8,
    snapshots: false,
    createAdapter: async ({ tables, nativePageSize }) => {
      suite += 1;
      const adapter = createMongoAdapter({
        client,
        tablePrefix: `l${suite}_`,
        maxOps: 50,
        ...(nativePageSize === undefined ? {} : { batchSize: nativePageSize }),
      });
      await adapter.migrations!.apply(tables);
      return { adapter };
    },
  });

  it("serves core as before, sends no snapshot read, and refuses only a snapshot", async () => {
    const legacy = track(
      new MongoClient(url("core"), { monitorCommands: true }),
    );
    const events = monitor(legacy);
    const database = mongoAdapter({ client: legacy });
    await (await database.createMigrator!().migrateToLatest()).execute();
    const core = createInProcessCoreApi(database.adapter);
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
    // Every catalog read of a compact scope, as before: no snapshot.
    const scopeKey = createReleaseCatalogScopeKey({
      channelKey: encodeChannelKey("production"),
      platform: "ios",
      strategy: "APP_VERSION",
    });
    const response = await createHotUpdaterHandlers({ api: { core } }).client(
      new Request(
        `http://localhost/release-catalogs/app-version/ios/${encodeChannelKey("production")}/1.0.0`,
      ),
    );
    expect(response.status).toBe(200);
    expect(await core.getReleaseCatalogRow(scopeKey)).not.toBeNull();
    expect(await core.listReleaseCatalogs({ limit: 10 })).toHaveLength(1);
    expect(
      await core.findBaseBundleIds(
        targetBaseCandidateKey({
          appVersion: "1.0.0",
          channel: "production",
          fingerprintHash: null,
          platform: "ios",
        })!,
        createBundleFixture("9").id,
        5,
      ),
    ).toEqual([createBundleFixture("1").id]);
    await core.ready();
    expect(events.plainFinds().length).toBeGreaterThan(0);
    expect(events.finds()).toEqual([]);

    await expect(
      database.adapter.readSnapshot!((reader) =>
        reader.get(conformanceItems, [["a"]]),
      ),
    ).rejects.toBeInstanceOf(DatabaseSnapshotUnsupportedError);
    // Still serving afterwards.
    await expect(core.getRelease(release.id)).resolves.toEqual(release);

    // Partitioning needs the snapshot reads this deployment lacks: the
    // server refuses before it sets anything, and leaves no probe row.
    await expect(core.enableReleaseCatalogPartitioning()).rejects.toMatchObject(
      { code: "SNAPSHOT_UNSUPPORTED" },
    );
    expect(await core.getReleaseCatalogPartitioning()).toEqual({
      switch: "off",
      table: "present",
    });
    expect(
      await legacy.db().collection("release_catalog_partitions").countDocuments(),
    ).toBe(0);
    await expect(core.getRelease(release.id)).resolves.toEqual(release);
  });
});

describe("a standalone mongod, which has no snapshot reads", () => {
  let client: MongoClient;

  beforeAll(async () => {
    const port = await availablePort();
    const container = `hot-updater-standalone-${process.pid}`;
    const deadline = Date.now() + 240_000;
    client = track(new MongoClient(`mongodb://127.0.0.1:${port}/standalone`));
    try {
      await run(
        container,
        ["-p", `127.0.0.1:${port}:27017`, "mongo:7-jammy"],
        deadline,
      );
      await until(
        async () => {
          const setup = new MongoClient(
            `mongodb://127.0.0.1:${port}/?serverSelectionTimeoutMS=2000`,
          );
          try {
            await setup.db("admin").command({ ping: 1 });
          } finally {
            await setup.close();
          }
        },
        "standalone",
        deadline,
      );
    } catch (error) {
      await failWithDocker("Starting the standalone mongod", error, [
        ["ps", "-a", "--filter", `name=^${container}$`],
        ["logs", "--tail", "40", container],
      ]);
    }
  }, 300_000);

  it("reads as before, and refuses only a snapshot", async () => {
    const adapter = createMongoAdapter({ client, tablePrefix: "a_" });
    await adapter.migrations!.apply([conformanceItems]);
    // Standalone takes no transaction, so the rows go in directly.
    await client
      .db()
      .collection(`a_${conformanceItems.name}`)
      .insertMany(
        [item("a", { score: 1 }), item("b", { score: 2 })].map((row) => ({
          _id: row.id as never,
          ...Object.fromEntries(
            Object.entries(row).filter(([, value]) => value !== null),
          ),
        })),
      );
    expect(
      (await adapter.get(conformanceItems, [["b"], ["a"]])).map(
        (row) => row?.score,
      ),
    ).toEqual([2, 1]);
    expect(
      (
        await adapter.query(conformanceItems, {
          index: "byGroup",
          eq: ["g"],
          order: "desc",
          limit: 5,
        })
      ).map((row) => row.id),
    ).toEqual(["b", "a"]);
    await expect(
      adapter.readSnapshot!((reader) => reader.get(conformanceItems, [["a"]])),
    ).rejects.toBeInstanceOf(DatabaseSnapshotUnsupportedError);
  });
});
