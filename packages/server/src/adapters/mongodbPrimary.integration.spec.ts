import net from "node:net";

import {
  type DatabaseAdapter,
  type StoredRow,
  type WriteOp,
} from "@hot-updater/plugin-core";
import {
  conformanceItems,
  setupDatabaseAdapterConformanceSuite,
} from "@hot-updater/test-utils";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { type CommandStartedEvent, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInProcessCoreApi } from "../core/inProcess.testFixtures";
import { dockerPullFlags, failWithDocker } from "../docker.testFixtures";
import { mongoAdapter } from "./mongodb";
import { createMongoAdapter } from "./mongodbAdapter";

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

/** The finds a client sends. */
const monitor = (client: MongoClient) => {
  const finds: CommandStartedEvent[] = [];
  client.on("commandStarted", (event) => {
    if (event.commandName === "find") finds.push(event);
  });
  return {
    finds,
    clear: () => {
      finds.length = 0;
    },
  };
};

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

describe("MongoDB reads on a three-member replica set", () => {
  let set: Awaited<ReturnType<typeof startReplicaSet>>;
  /** A client configured to read secondaries, with a majority read concern. */
  const hostile = (database: string) => {
    const client = track(
      new MongoClient(
        set.url(
          database,
          "&readPreference=secondaryPreferred&readConcernLevel=majority",
        ),
        { monitorCommands: true },
      ),
    );
    return { client, events: monitor(client) };
  };
  const primaryAddress = async () =>
    String((await set.probe.db("admin").command({ hello: 1 })).primary);

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
    const adapter = createMongoAdapter({ client, tablePrefix: "r_" });
    await adapter.migrations!.apply([conformanceItems]);
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
      expect(events.finds.length).toBeGreaterThan(20);
      expect(new Set(events.finds.map((event) => event.address))).toEqual(
        new Set([primary]),
      );
    } finally {
      await lagging.db("admin").command({ fsyncUnlock: 1 });
    }
  });
});
