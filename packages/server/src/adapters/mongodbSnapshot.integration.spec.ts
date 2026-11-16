import net from "node:net";

import {
  DatabaseSnapshotConflictError,
  DatabaseSnapshotUnsupportedError,
  type DatabaseAdapter,
  type StoredRow,
  type WriteOp,
} from "@hot-updater/plugin-core";
import {
  conformanceItems,
  createBundleFixture,
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
const until = async <T>(attempt: () => Promise<T>, what: string) => {
  let last: unknown;
  for (let tries = 0; tries < 120; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      last = error;
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for ${what}`, { cause: last });
};

const containers: string[] = [];
const clients: MongoClient[] = [];
const track = (client: MongoClient) => {
  clients.push(client);
  return client;
};

/**
 * Members listen on the same port inside the container and on the host, and
 * advertise 127.0.0.1, so the driver on the host dials every member as the
 * members dial each other. One container holds them all.
 */
const startReplicaSet = async (
  image: string,
  name: string,
  ports: readonly number[],
) => {
  const container = `hot-updater-${name}-${process.pid}`;
  const mongods = ports.map(
    (port, at) =>
      `mkdir -p /data/m${at} && mongod --replSet ${name} --port ${port} --bind_ip_all --dbpath /data/m${at} --logpath /data/m${at}.log --fork --setParameter enableTestCommands=1`,
  );
  await execa("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    ...ports.flatMap((port) => ["-p", `127.0.0.1:${port}:${port}`]),
    image,
    "bash",
    "-c",
    `${mongods.join(" && ")} && tail -f /dev/null`,
  ]);
  containers.push(container);
  const nodes = await Promise.all(
    ports.map((port) =>
      until(async () => {
        const client = new MongoClient(
          `mongodb://127.0.0.1:${port}/?directConnection=true&serverSelectionTimeoutMS=2000`,
        );
        try {
          await client.db("admin").command({ ping: 1 });
          return client;
        } catch (error) {
          await client.close();
          throw error;
        }
      }, `${name} member on ${port}`),
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
  const url = (database: string, query = "") =>
    `mongodb://${ports.map((port) => `127.0.0.1:${port}`).join(",")}/${database}?replicaSet=${name}${query}`;
  const probe = track(new MongoClient(url("admin")));
  await until(async () => {
    const hello = await probe.db("admin").command({ hello: 1 });
    if (!hello.isWritablePrimary || hello.hosts.length !== ports.length) {
      throw new Error("no primary yet");
    }
    // Every secondary is up, so a majority write never waits on a member
    // still starting.
    const status = await probe.db("admin").command({ replSetGetStatus: 1 });
    if (
      !(status.members as { stateStr: string }[]).every((member) =>
        ["PRIMARY", "SECONDARY"].includes(member.stateStr),
      )
    ) {
      throw new Error("members still starting");
    }
  }, `${name} primary`);
  return { url, probe };
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
  ) => {
    tables += 1;
    const adapter = createMongoAdapter({
      client,
      tablePrefix: `s${tables}_`,
      ...options,
    });
    await adapter.migrations!.apply([conformanceItems]);
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
      // The schema fence's settings read too.
      await createInProcessCoreApi(database.adapter).listChannels();
      expect(events.plainFinds().length).toBeGreaterThan(20);
      expect(
        new Set(events.plainFinds().map((event) => event.address)),
      ).toEqual(new Set([primary]));
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
    expect(events.plainFinds().length).toBeGreaterThan(0);
    expect(events.finds()).toEqual([]);

    await expect(
      database.adapter.readSnapshot!((reader) =>
        reader.get(conformanceItems, [["a"]]),
      ),
    ).rejects.toBeInstanceOf(DatabaseSnapshotUnsupportedError);
    // Still serving afterwards.
    await expect(core.getRelease(release.id)).resolves.toEqual(release);
  });
});
