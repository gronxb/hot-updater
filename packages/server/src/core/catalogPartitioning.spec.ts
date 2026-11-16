import {
  createEngineDatabase,
  type DatabaseAdapter,
  DatabaseSnapshotUnsupportedError,
  type QueryRequest,
  type PhysicalTable,
  SETTINGS_TABLE,
  type SnapshotReader,
  type StoredRow,
} from "@hot-updater/plugin-core";
import {
  createBundleFixture,
  createReleaseCatalogTestStorage,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createHotUpdater } from "../createHotUpdaterCore";
import { createInProcessCoreApi } from "./inProcess.testFixtures";
import {
  appVersionScope,
  createWriteTestAdapter,
  releasePolicy,
  storedScope,
} from "./catalogWrites.testFixtures";
import {
  PARTITIONING_REQUEST_SETTING,
  PARTITIONING_REQUEST_TTL_MS,
  ReleaseCatalogPartitioningError,
  ReleaseCatalogPartitioningRequestError,
} from "./catalogPartitioning";

const PARTITIONS = "release_catalog_partitions";
const SWITCH = "catalog.partitioning";

const setting = async (adapter: DatabaseAdapter, key: string) => {
  const [row] = await adapter.get(SETTINGS_TABLE, [[key]]);
  return row?.value ?? null;
};

/**
 * The adapter, plus every partitions key a write ever sent, and which of
 * them `raw`, the store underneath every wrapper, still holds.
 */
const recording = (
  wrap: (adapter: DatabaseAdapter) => DatabaseAdapter = (adapter) => adapter,
) => {
  const { adapter: raw } = createWriteTestAdapter();
  const base = wrap(raw);
  const inserted: { table: PhysicalTable; key: [string, string, string] }[] =
    [];
  const adapter: DatabaseAdapter = Object.assign(Object.create(base), {
    async write(ops: Parameters<DatabaseAdapter["write"]>[0]) {
      for (const op of ops) {
        if (op.type === "insert" && op.table.name === PARTITIONS) {
          const row = op.row as StoredRow;
          inserted.push({
            table: op.table,
            key: [
              String(row.scope_key),
              String(row.epoch),
              String(row.lower_key),
            ],
          });
        }
      }
      return base.write(ops);
    },
  });
  /** Partition rows still stored under any key ever inserted. */
  const left = async () =>
    inserted.length === 0
      ? []
      : (
          await raw.get(
            inserted[0]!.table,
            inserted.map(({ key }) => key),
          )
        ).filter((row) => row !== null);
  return { adapter, inserted, left };
};

/** A store whose partitions table orders keys case-insensitively, as a locale collation does. */
const caseInsensitiveOrder = (base: DatabaseAdapter): DatabaseAdapter => {
  const fold = (row: StoredRow) =>
    `${String(row.epoch).toLowerCase()}\u0000${String(row.lower_key).toLowerCase()}`;
  const wrap = (query: DatabaseAdapter["query"]) =>
    async (table: PhysicalTable, request: QueryRequest) => {
      const rows = await query.call(base, table, request);
      if (table.name !== PARTITIONS) return rows;
      const all = await query.call(base, table, {
        ...request,
        lower: undefined,
        upper: undefined,
        limit: 500,
      });
      const sorted = [...all].sort((a, b) =>
        fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : 0,
      );
      return (request.order === "desc" ? sorted.reverse() : sorted).slice(
        0,
        request.limit,
      );
    };
  return Object.assign(Object.create(base), { query: wrap(base.query) });
};

/** A store whose role can't reach the partitions table, as a policy that predates it. */
const refusingPartitions = (base: DatabaseAdapter): DatabaseAdapter =>
  Object.assign(Object.create(base), {
    async get(table: PhysicalTable, keys: never) {
      if (table.name === PARTITIONS) throw new Error("AccessDeniedException");
      return base.get(table, keys);
    },
    async query(table: PhysicalTable, request: QueryRequest) {
      if (table.name === PARTITIONS) throw new Error("no such table");
      return base.query(table, request);
    },
    async write(ops: Parameters<DatabaseAdapter["write"]>[0]) {
      if (ops.some((op) => op.table.name === PARTITIONS)) {
        throw new Error("AccessDeniedException");
      }
      return base.write(ops);
    },
  });

/** A MongoDB-like adapter on a deployment without snapshot reads. */
const noSnapshots = (base: DatabaseAdapter): DatabaseAdapter =>
  Object.assign(Object.create(base), {
    async readSnapshot<T>(_read: (reader: SnapshotReader) => Promise<T>) {
      throw new DatabaseSnapshotUnsupportedError(
        "This MongoDB deployment can't read at a snapshot.",
      );
    },
  });

describe("enableReleaseCatalogPartitioning", () => {
  it("probes with the server's own store, sets the switch once, and leaves no probe row", async () => {
    const { adapter, left, inserted } = recording();
    const core = createInProcessCoreApi(adapter);
    await expect(core.getReleaseCatalogPartitioning()).resolves.toEqual({
      switch: "off",
      table: "present",
    });
    await expect(core.enableReleaseCatalogPartitioning()).resolves.toEqual({
      partitioning: "on",
      changed: true,
    });
    expect(inserted).toHaveLength(6);
    expect(inserted.every(({ key }) => key[0].startsWith("~probe/"))).toBe(
      true,
    );
    await expect(left()).resolves.toEqual([]);
    expect(await setting(adapter, SWITCH)).toBe("on");
    await expect(core.getReleaseCatalogPartitioning()).resolves.toEqual({
      switch: "on",
      table: "present",
    });
    // Idempotent: on stays on, and nothing is probed again.
    await expect(core.enableReleaseCatalogPartitioning()).resolves.toEqual({
      partitioning: "on",
      changed: false,
    });
    expect(inserted).toHaveLength(6);
  });

  it("sets the switch once under concurrent calls, each probing its own keys", async () => {
    const { adapter, inserted, left } = recording();
    const core = createInProcessCoreApi(adapter);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => core.enableReleaseCatalogPartitioning()),
    );
    expect(results.filter(({ changed }) => changed)).toHaveLength(1);
    expect(new Set(inserted.map(({ key }) => key[0])).size).toBe(
      inserted.length / 6,
    );
    await expect(left()).resolves.toEqual([]);
    expect(await setting(adapter, SWITCH)).toBe("on");
  });

  it("then converts an app-version scope on its next write", async () => {
    const { adapter, memory } = createWriteTestAdapter();
    const core = createInProcessCoreApi(adapter);
    const scopeKey = appVersionScope("production");
    await core.deploy([
      {
        bundle: createBundleFixture("1"),
        release: releasePolicy("production", "1.0.0"),
      },
    ]);
    expect((await storedScope(memory, scopeKey)).liveEpoch).toBeNull();
    await core.enableReleaseCatalogPartitioning();
    await core.deploy([
      {
        bundle: createBundleFixture("2"),
        release: releasePolicy("production", "2.0.0"),
      },
    ]);
    expect((await storedScope(memory, scopeKey)).liveEpoch).not.toBeNull();
  });

  it.each([
    [
      "a table the server can't read",
      refusingPartitions,
      "PARTITIONS_UNAVAILABLE",
    ],
    [
      "a table that orders keys case-insensitively",
      caseInsensitiveOrder,
      "PARTITIONS_KEY_ORDER",
    ],
    [
      "a deployment without snapshot reads",
      noSnapshots,
      "SNAPSHOT_UNSUPPORTED",
    ],
  ] as const)(
    "refuses %s and leaves the switch unset and no probe row",
    async (_, wrap, code) => {
      const { adapter, left } = recording(wrap);
      const core = createInProcessCoreApi(adapter);
      const refusal = core.enableReleaseCatalogPartitioning();
      await expect(refusal).rejects.toBeInstanceOf(
        ReleaseCatalogPartitioningError,
      );
      await expect(refusal).rejects.toMatchObject({ code });
      expect(await setting(adapter, SWITCH)).toBeNull();
      await expect(left()).resolves.toEqual([]);
    },
  );

  it("reports a table the server can't read as missing", async () => {
    const core = createInProcessCoreApi(
      refusingPartitions(createWriteTestAdapter().adapter),
    );
    await expect(core.getReleaseCatalogPartitioning()).resolves.toEqual({
      switch: "off",
      table: "missing",
    });
  });
});

describe("a request token", () => {
  const setup = (base?: DatabaseAdapter) => {
    let now = 1_000_000;
    const adapter = base ?? createWriteTestAdapter().adapter;
    const core = createInProcessCoreApi(adapter, { now: () => now });
    return {
      adapter,
      core,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it("authorizes one enable, consumed in the write that sets the switch", async () => {
    const { adapter, core } = setup();
    const token = await core.issueReleaseCatalogPartitioningToken();
    // The token turns nothing on by itself, and only its hash is stored.
    expect(await setting(adapter, SWITCH)).toBeNull();
    expect(await setting(adapter, PARTITIONING_REQUEST_SETTING)).not.toContain(
      token,
    );
    await expect(
      core.enableReleaseCatalogPartitioning({ token }),
    ).resolves.toEqual({ partitioning: "on", changed: true });
    expect(await setting(adapter, PARTITIONING_REQUEST_SETTING)).toBeNull();
    // Replayed: refused, though the switch is on.
    await expect(
      core.enableReleaseCatalogPartitioning({ token }),
    ).rejects.toBeInstanceOf(ReleaseCatalogPartitioningRequestError);
  });

  it("answers an already-on switch unchanged, and still consumes the token", async () => {
    const { adapter, core } = setup();
    await core.enableReleaseCatalogPartitioning();
    const token = await core.issueReleaseCatalogPartitioningToken();
    await expect(
      core.enableReleaseCatalogPartitioning({ token }),
    ).resolves.toEqual({ partitioning: "on", changed: false });
    expect(await setting(adapter, PARTITIONING_REQUEST_SETTING)).toBeNull();
  });

  it("refuses an expired token and leaves the switch unset", async () => {
    const { adapter, core, advance } = setup();
    const token = await core.issueReleaseCatalogPartitioningToken();
    advance(PARTITIONING_REQUEST_TTL_MS);
    await expect(
      core.enableReleaseCatalogPartitioning({ token }),
    ).rejects.toBeInstanceOf(ReleaseCatalogPartitioningRequestError);
    expect(await setting(adapter, SWITCH)).toBeNull();
  });

  it("refuses a wrong, empty or missing token without consuming the stored one", async () => {
    const { adapter, core } = setup();
    for (const wrong of ["wrong", ""]) {
      await expect(
        core.enableReleaseCatalogPartitioning({ token: wrong }),
      ).rejects.toBeInstanceOf(ReleaseCatalogPartitioningRequestError);
    }
    const token = await core.issueReleaseCatalogPartitioningToken();
    await expect(
      core.enableReleaseCatalogPartitioning({ token: `${token}x` }),
    ).rejects.toBeInstanceOf(ReleaseCatalogPartitioningRequestError);
    expect(await setting(adapter, SWITCH)).toBeNull();
    await expect(
      core.enableReleaseCatalogPartitioning({ token }),
    ).resolves.toMatchObject({ changed: true });
  });

  it("is replaced by a newer token", async () => {
    const { core } = setup();
    const first = await core.issueReleaseCatalogPartitioningToken();
    const second = await core.issueReleaseCatalogPartitioningToken();
    await expect(
      core.enableReleaseCatalogPartitioning({ token: first }),
    ).rejects.toBeInstanceOf(ReleaseCatalogPartitioningRequestError);
    await expect(
      core.enableReleaseCatalogPartitioning({ token: second }),
    ).resolves.toMatchObject({ changed: true });
  });

  it("authorizes exactly one of concurrent calls", async () => {
    const { adapter, core } = setup();
    const token = await core.issueReleaseCatalogPartitioningToken();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        core.enableReleaseCatalogPartitioning({ token }),
      ),
    );
    const fulfilled = results.filter(({ status }) => status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(
          ReleaseCatalogPartitioningRequestError,
        );
      }
    }
    expect(await setting(adapter, SWITCH)).toBe("on");
  });

  it("is deleted when the server refuses, and the switch stays unset", async () => {
    const { adapter, core } = setup(
      refusingPartitions(createWriteTestAdapter().adapter),
    );
    const token = await core.issueReleaseCatalogPartitioningToken();
    await expect(
      core.enableReleaseCatalogPartitioning({ token }),
    ).rejects.toMatchObject({ code: "PARTITIONS_UNAVAILABLE" });
    expect(await setting(adapter, PARTITIONING_REQUEST_SETTING)).toBeNull();
    expect(await setting(adapter, SWITCH)).toBeNull();
    await expect(
      core.enableReleaseCatalogPartitioning({ token }),
    ).rejects.toBeInstanceOf(ReleaseCatalogPartitioningRequestError);
  });
});

describe("createHotUpdater's core", () => {
  it("has no enable: only the server's routes turn partitioning on", () => {
    const hotUpdater = createHotUpdater({
      clientAccess: "public",
      database: createEngineDatabase({
        adapter: createWriteTestAdapter().adapter,
        name: "memory",
      }),
      storage: createReleaseCatalogTestStorage(),
    });
    expect("enableReleaseCatalogPartitioning" in hotUpdater.core).toBe(false);
    expect(typeof hotUpdater.core.issueReleaseCatalogPartitioningToken).toBe(
      "function",
    );
  });
});
