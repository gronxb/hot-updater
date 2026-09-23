import {
  createMemoryAdapter,
  type DatabaseAdapter,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { createDatabaseEngine, type HotUpdaterTransaction } from "./database";
import { DatabaseQueryError } from "./engineReads";
import type { RetryOptions } from "./engineTransaction";
import {
  DatabaseAmbiguousCommitError,
  DatabaseConflictError,
  DatabaseConstraintError,
  DatabaseTransactionError,
} from "./errors";
import { resolveSchema } from "./resolveSchema";
import { defineTable } from "./schema";

const channels = defineTable(
  { name: { type: "string", maxLength: 32 } },
  { key: ["name"] },
);

const bundles = defineTable(
  {
    id: { type: "string", maxLength: 36 },
    channel: {
      type: "string",
      maxLength: 32,
      references: { model: "channels", onDelete: "restrict" },
    },
    hash: { type: "string", maxLength: 64, unique: true },
    note: { type: "string", required: false },
  },
  { key: ["id"], indexes: { byChannel: { eq: ["channel"], sort: ["id"] } } },
);

const patches = defineTable(
  {
    id: { type: "string", maxLength: 80 },
    bundle_id: {
      type: "string",
      maxLength: 36,
      references: { model: "bundles", onDelete: "cascade" },
    },
    base_bundle_id: {
      type: "string",
      maxLength: 36,
      references: { model: "bundles", onDelete: "cascade" },
    },
  },
  {
    key: ["id"],
    indexes: {
      byBundle: { eq: ["bundle_id"], sort: ["id"] },
      byBase: { eq: ["base_bundle_id"], sort: ["id"] },
    },
  },
);

const catalogs = defineTable(
  {
    id: { type: "string", maxLength: 36 },
    latest: { type: "string", maxLength: 36, required: false },
  },
  { key: ["id"] },
);

const releases = defineTable(
  {
    catalog_id: { type: "string", maxLength: 36 },
    id: { type: "string", maxLength: 36 },
  },
  {
    key: ["catalog_id", "id"],
    indexes: {
      byCatalog: {
        eq: ["catalog_id"],
        sort: ["id"],
        root: { model: "catalogs" },
      },
      all: { eq: [], sort: ["id"] },
    },
  },
);

const counters = defineTable(
  {
    id: { type: "string", maxLength: 36 },
    value: { type: "integer" },
    on_call: { type: "boolean" },
  },
  { key: ["id"] },
);

const core = {
  id: "core",
  schema: { channels, bundles, patches, catalogs, releases, counters },
} as const;
const schema = resolveSchema([core]);
const table = (name: string) => schema.models.get(name)!.table;

type Tx = HotUpdaterTransaction<typeof core.schema>;
type Fault = WriteResult | "throw" | undefined;

const setup = async (
  options: {
    readonly maxOps?: number;
    readonly retry?: RetryOptions;
    readonly seed?: false;
  } = {},
) => {
  const memory = createMemoryAdapter(
    options.maxOps === undefined ? {} : { maxOps: options.maxOps },
  );
  await memory.migrations?.apply(schema.tables);
  const faults: { inject?: (ops: readonly WriteOp[]) => Fault } = {};
  const writes: (readonly WriteOp[])[] = [];
  const adapter: DatabaseAdapter = {
    ...memory,
    async write(ops) {
      writes.push(ops);
      const fault = faults.inject?.(ops);
      if (fault === "throw") throw new Error("connection reset");
      return fault ?? memory.write(ops);
    },
  };
  const engine = createDatabaseEngine({
    adapter,
    schema,
    verify: true,
    retry: options.retry ?? { attempts: 8, baseDelayMs: 0, maxDelayMs: 1 },
  });
  const db = engine.database(core);
  if (options.seed === false) return { memory, faults, writes, db };
  await db.transaction(async (tx) => {
    tx.create("channels", { name: "prod" });
    for (const id of ["b0", "b1", "b2"]) {
      tx.create("bundles", { id, channel: "prod", hash: `h-${id}` });
    }
    tx.create("patches", { id: "p1", bundle_id: "b1", base_bundle_id: "b0" });
    tx.create("patches", { id: "p2", bundle_id: "b2", base_bundle_id: "b1" });
    tx.create("catalogs", { id: "c1" });
    tx.create("counters", { id: "c", value: 0, on_call: true });
    tx.create("counters", { id: "d1", value: 0, on_call: true });
    tx.create("counters", { id: "d2", value: 0, on_call: true });
  });
  writes.length = 0;
  return { memory, faults, writes, db };
};

/** Fails the next write once with `fault`. */
const failOnce = (fault: Fault) => {
  let used = false;
  return () => {
    if (used) return undefined;
    used = true;
    return fault;
  };
};

/** Resolves for everyone once `parties` callers have arrived. */
const barrier = (parties: number) => {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived === parties) open();
    return all;
  };
};

const reasonOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "committed",
    (error: unknown) =>
      error instanceof DatabaseConstraintError ? error.reason : error,
  );

describe("engine transactions", () => {
  it("coalesces writes to one guarded op per key and skips a lone read", async () => {
    const { db, writes } = await setup();
    const seen = await db.transaction(async (tx) => {
      const row = (await tx.findOne("counters", { id: "c" }))!;
      tx.update("counters", row, { value: row.value + 1 });
      tx.update("counters", row, { value: row.value + 2 });
      return row.value;
    });
    expect(seen).toBe(0);
    expect(writes).toEqual([
      [
        expect.objectContaining({
          type: "patch",
          key: ["c"],
          set: { value: 2 },
          guard: { v: 0 },
        }),
      ],
    ]);
    await expect(db.findOne("counters", { id: "c" })).resolves.toMatchObject({
      value: 2,
      _v: 1,
    });

    writes.length = 0;
    await db.transaction((tx) => tx.findOne("counters", { id: "c" }));
    expect(writes).toEqual([]);
  });

  it("injects a guard failure at every op and applies the rerun exactly once", async () => {
    const run = async (tx: Tx) => {
      await tx.findOne("channels", { name: "prod" });
      const catalog = (await tx.findOne("catalogs", { id: "c1" }))!;
      tx.update("catalogs", catalog, { latest: "r1" });
      tx.create("releases", { catalog_id: "c1", id: "r1" });
      tx.create("patches", { id: "p3", bundle_id: "b2", base_bundle_id: "b0" });
    };
    const probe = await setup();
    await probe.db.transaction(run);
    const ops = probe.writes[0]!;
    expect(ops.map(({ type, table }) => `${type} ${table.name}`)).toEqual([
      "insert releases",
      "insert patches",
      "patch catalogs",
      "increment bundles",
      "increment bundles",
      "check channels",
    ]);

    for (const failedOp of ops.keys()) {
      const { db, faults } = await setup();
      faults.inject = failOnce({ ok: false, failedOp });
      let runs = 0;
      await db.transaction(async (tx) => {
        runs += 1;
        await run(tx);
      });
      expect(runs, `failedOp ${failedOp}`).toBe(2);
      await expect(db.findOne("bundles", { id: "b2" })).resolves.toMatchObject({
        _refs_patches_bundle_id: 2,
      });
      await expect(db.findOne("bundles", { id: "b0" })).resolves.toMatchObject({
        _refs_patches_base_bundle_id: 2,
      });
      await expect(db.findOne("catalogs", { id: "c1" })).resolves.toMatchObject(
        { latest: "r1", _v: 1 },
      );
    }
  });

  it("reruns transient failures, reports ambiguous commits, and stops at the budget", async () => {
    const bump = async (tx: Tx) => {
      const row = (await tx.findOne("counters", { id: "c" }))!;
      tx.update("counters", row, { value: row.value + 1 });
    };
    const transient = await setup();
    transient.faults.inject = failOnce({ ok: false, retry: true });
    await transient.db.transaction(bump);
    expect(transient.writes).toHaveLength(2);

    const ambiguous = await setup();
    ambiguous.faults.inject = failOnce("throw");
    let runs = 0;
    await expect(
      ambiguous.db.transaction(async (tx) => {
        runs += 1;
        await bump(tx);
      }),
    ).rejects.toThrow(DatabaseAmbiguousCommitError);
    expect(runs).toBe(1);

    const exhausted = await setup({
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    });
    exhausted.faults.inject = () => ({ ok: false, failedOp: 0 });
    await expect(exhausted.db.transaction(bump)).rejects.toThrow(
      DatabaseConflictError,
    );
    expect(exhausted.writes).toHaveLength(3);
    await expect(
      exhausted.db.findOne("counters", { id: "c" }),
    ).resolves.toMatchObject({ value: 0 });
  });

  it("loses no increment across 32 concurrent read-modify-write writers", async () => {
    const { db } = await setup({
      retry: { attempts: 200, baseDelayMs: 1, maxDelayMs: 4 },
    });
    const arrive = barrier(32);
    let runs = 0;
    await Promise.all(
      Array.from({ length: 32 }, () => {
        let first = true;
        return db.transaction(async (tx) => {
          runs += 1;
          const row = (await tx.findOne("counters", { id: "c" }))!;
          if (first) {
            first = false;
            await arrive();
          }
          tx.update("counters", row, { value: row.value + 1 });
        });
      }),
    );
    await expect(db.findOne("counters", { id: "c" })).resolves.toMatchObject({
      value: 32,
      _v: 32,
    });
    expect(runs).toBeGreaterThanOrEqual(32 + 31);
  });

  it("counts blind reference increments from 32 writers without reruns", async () => {
    const { db } = await setup();
    let runs = 0;
    await Promise.all(
      Array.from({ length: 32 }, (_, writer) =>
        db.transaction(async (tx) => {
          runs += 1;
          tx.create("bundles", {
            id: `n${writer}`,
            channel: "prod",
            hash: `h-n${writer}`,
          });
        }),
      ),
    );
    expect(runs).toBe(32);
    await expect(
      db.findOne("channels", { name: "prod" }),
    ).resolves.toMatchObject({ _refs_bundles_channel: 35 });
  });

  it("has exactly one winner per contested key", async () => {
    const { db } = await setup();
    const blind = await Promise.all(
      Array.from({ length: 32 }, (_, writer) =>
        reasonOf(
          db.transaction(async (tx) => {
            tx.create("counters", { id: "k", value: writer, on_call: false });
          }),
        ),
      ),
    );
    expect(blind.filter((reason) => reason === "committed")).toHaveLength(1);
    expect(blind.filter((reason) => reason === "exists")).toHaveLength(31);

    const arrive = barrier(32);
    const won = await Promise.all(
      Array.from({ length: 32 }, (_, writer) => {
        let first = true;
        return db.transaction(async (tx) => {
          const row = await tx.findOne("counters", { id: "r" });
          if (first) {
            first = false;
            await arrive();
          }
          if (row !== null) return false;
          tx.create("counters", { id: "r", value: writer, on_call: false });
          return true;
        });
      }),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    await expect(db.findOne("counters", { id: "r" })).resolves.toMatchObject({
      value: won.indexOf(true),
    });
  });

  it("guards every row it read against write skew", async () => {
    const { db } = await setup();
    const arrive = barrier(2);
    const leave = (me: string, other: string) => {
      let first = true;
      return db.transaction(async (tx) => {
        const mine = (await tx.findOne("counters", { id: me }))!;
        const theirs = (await tx.findOne("counters", { id: other }))!;
        if (first) {
          first = false;
          await arrive();
        }
        if (theirs.on_call) tx.update("counters", mine, { on_call: false });
      });
    };
    await Promise.all([leave("d1", "d2"), leave("d2", "d1")]);
    const rows = await Promise.all(
      ["d1", "d2"].map((id) => db.findOne("counters", { id })),
    );
    expect(rows.filter((row) => row!.on_call)).toHaveLength(1);
  });

  it("reruns when a row it read changes before the read repeats", async () => {
    const { db, memory } = await setup();
    let runs = 0;
    await db.transaction(async (tx) => {
      runs += 1;
      const row = (await tx.findOne("counters", { id: "c" }))!;
      if (runs === 1) {
        await memory.write([
          {
            type: "increment",
            table: table("counters"),
            key: ["c"],
            by: { value: 5 },
          },
        ]);
      }
      const again = (await tx.findOne("counters", { id: "c" }))!;
      tx.update("counters", again, { value: row.value + 1 });
    });
    expect(runs).toBe(2);
    await expect(db.findOne("counters", { id: "c" })).resolves.toMatchObject({
      value: 6,
    });
  });

  it("reports exists, unique, and not_found only for current reads", async () => {
    const { db } = await setup();
    await expect(
      reasonOf(
        db.transaction(async (tx) => {
          tx.create("counters", { id: "c", value: 1, on_call: false });
        }),
      ),
    ).resolves.toBe("exists");
    await expect(
      reasonOf(
        db.transaction(async (tx) => {
          tx.create("bundles", { id: "b9", channel: "prod", hash: "h-b0" });
        }),
      ),
    ).resolves.toBe("unique");
    await expect(
      reasonOf(
        db.transaction(async (tx) => {
          const row = (await tx.findOne("bundles", { hash: "h-b1" }))!;
          tx.update("bundles", row, { hash: "h-b0" });
        }),
      ),
    ).resolves.toBe("unique");
    await expect(
      reasonOf(
        db.transaction(async (tx) => {
          tx.create("bundles", { id: "b9", channel: "beta", hash: "h-b9" });
        }),
      ),
    ).resolves.toBe("not_found");
    await expect(
      reasonOf(
        db.transaction(async (tx) => {
          const channel = await tx.findOne("channels", { name: "beta" });
          if (channel === null) {
            tx.create("bundles", { id: "b9", channel: "beta", hash: "h-b9" });
          }
        }),
      ),
    ).resolves.toBe("not_found");
  });

  it("refuses a restricted delete, even when fn catches it, unless the children go first", async () => {
    const { db } = await setup();
    await expect(
      reasonOf(
        db.transaction(async (tx) => {
          const channel = (await tx.findOne("channels", { name: "prod" }))!;
          await tx.delete("channels", channel).catch(() => undefined);
        }),
      ),
    ).resolves.toBe("referenced");

    await db.transaction(async (tx) => {
      for (const id of ["b0", "b1", "b2"]) {
        await tx.delete("bundles", (await tx.findOne("bundles", { id }))!);
      }
      await tx.delete(
        "channels",
        (await tx.findOne("channels", { name: "prod" }))!,
      );
    });
    await expect(db.findOne("channels", { name: "prod" })).resolves.toBeNull();
    await expect(db.findOne("patches", { id: "p1" })).resolves.toBeNull();
  });

  it("reruns a restricted delete whose read of the counter went stale", async () => {
    const { db, memory } = await setup();
    await db.transaction(async (tx) => {
      tx.create("channels", { name: "beta" });
      tx.create("bundles", { id: "bx", channel: "beta", hash: "h-bx" });
    });
    const bx = (await db.findOne("bundles", { id: "bx" }))!;
    let runs = 0;
    await db.transaction(async (tx) => {
      runs += 1;
      const channel = (await tx.findOne("channels", { name: "beta" }))!;
      if (runs === 1) {
        await memory.write([
          {
            type: "delete",
            table: table("bundles"),
            key: ["bx"],
            guard: { v: bx._v },
            previous: bx,
          },
          {
            type: "increment",
            table: table("channels"),
            key: ["beta"],
            by: { _refs_bundles_channel: -1 },
          },
        ]);
      }
      await tx.delete("channels", channel);
    });
    expect(runs).toBe(2);
    await expect(db.findOne("channels", { name: "beta" })).resolves.toBeNull();
  });

  it("cascades children first and moves every other parent's counter", async () => {
    const { db, writes } = await setup();
    await db.transaction(async (tx) => {
      await tx.delete("bundles", (await tx.findOne("bundles", { id: "b1" }))!);
    });
    expect(
      writes[0]!.map(
        (op) =>
          `${op.type} ${op.table.name} ${op.type === "insert" ? "" : op.key.join()}`,
      ),
    ).toEqual([
      "increment channels prod",
      "increment bundles b0",
      "increment bundles b2",
      "delete patches p1",
      "delete patches p2",
      "delete bundles b1",
    ]);
    for (const id of ["p1", "p2"]) {
      await expect(db.findOne("patches", { id })).resolves.toBeNull();
    }
    await expect(db.findOne("bundles", { id: "b0" })).resolves.toMatchObject({
      _refs_patches_base_bundle_id: 0,
    });
    await expect(db.findOne("bundles", { id: "b2" })).resolves.toMatchObject({
      _refs_patches_bundle_id: 0,
    });
    await expect(
      db.findOne("channels", { name: "prod" }),
    ).resolves.toMatchObject({ _refs_bundles_channel: 2 });
  });

  it("inserts parents before children and carries counters from earlier writes", async () => {
    const { db, writes } = await setup();
    await db.transaction(async (tx) => {
      tx.create("patches", { id: "p9", bundle_id: "b9", base_bundle_id: "b0" });
      tx.create("bundles", { id: "b9", channel: "prod", hash: "h-b9" });
    });
    expect(
      writes[0]!.map(({ type, table }) => `${type} ${table.name}`),
    ).toEqual([
      "insert bundles",
      "insert patches",
      "increment bundles",
      "increment channels",
    ]);
    await expect(db.findOne("bundles", { id: "b9" })).resolves.toMatchObject({
      _refs_patches_bundle_id: 1,
      note: null,
    });
  });

  it("guards a rooted range through its parent and refuses unrooted ranges", async () => {
    const { db } = await setup();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let runs = 0;
    const first = db.transaction(async (tx) => {
      runs += 1;
      const page = await tx.findMany("releases", {
        index: "byCatalog",
        where: { catalog_id: "c1" },
        limit: 10,
      });
      if (runs === 1) {
        entered();
        await gate;
      }
      tx.create("releases", { catalog_id: "c1", id: `r${page.rows.length}` });
      return page.rows.length;
    });
    await inside;
    await db.transaction(async (tx) => {
      tx.create("releases", { catalog_id: "c1", id: "rx" });
    });
    proceed();
    await expect(first).resolves.toBe(1);
    expect(runs).toBe(2);

    await expect(
      db.transaction((tx) =>
        tx.findMany("releases", {
          // @ts-expect-error all is not rooted.
          index: "all",
          where: { catalog_id: "c1" },
          limit: 1,
        }),
      ),
    ).rejects.toThrow(DatabaseQueryError);
  });

  it("rejects writes over the adapter's atomic limit before sending them", async () => {
    const { db, writes } = await setup({ maxOps: 3, seed: false });
    await expect(
      reasonOf(
        db.transaction(async (tx) => {
          for (const id of ["x1", "x2", "x3", "x4"]) {
            tx.create("counters", { id, value: 0, on_call: false });
          }
        }),
      ),
    ).resolves.toBe("too_large");
    expect(writes).toEqual([]);
  });

  it("keeps db, nested transactions, and a finished handle out of fn", async () => {
    const { db } = await setup();
    await expect(
      db.transaction(async () => db.findOne("counters", { id: "c" })),
    ).rejects.toThrow(DatabaseTransactionError);
    await expect(
      db.transaction(async () => db.transaction(async () => 1)),
    ).rejects.toThrow(DatabaseTransactionError);
    let saved: Tx | undefined;
    await db.transaction(async (tx) => {
      saved = tx;
    });
    expect(() =>
      saved!.create("counters", { id: "z", value: 0, on_call: false }),
    ).toThrow("The transaction has ended.");
  });

  it("writes only rows it read, never keys, unknown fields, or missing required fields", async () => {
    const { db } = await setup();
    const row = (await db.findOne("counters", { id: "c" }))!;
    await expect(
      db.transaction(async (tx) => {
        tx.update("counters", row, { value: 1 });
      }),
    ).rejects.toThrow("take a row this transaction read");
    await expect(
      db.transaction(async (tx) => {
        const read = (await tx.findOne("counters", { id: "c" }))!;
        // @ts-expect-error Key fields cannot change.
        tx.update("counters", read, { id: "moved" });
      }),
    ).rejects.toThrow("id cannot be changed");
    await expect(
      db.transaction(async (tx) => {
        // @ts-expect-error value is required.
        tx.create("counters", { id: "n", on_call: false });
      }),
    ).rejects.toThrow("value is required");
    await expect(
      db.transaction(async (tx) => {
        tx.create("counters", {
          id: "n",
          value: 0,
          on_call: false,
          // @ts-expect-error extra is not a field.
          extra: 1,
        });
      }),
    ).rejects.toThrow("extra cannot be set");
  });
});
