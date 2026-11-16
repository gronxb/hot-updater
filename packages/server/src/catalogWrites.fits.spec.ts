import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Each store's real atomic-write limits, which no package exports: the
// specs pin conversions against the stores' own constants, not a copy.
import { dynamoDB } from "@hot-updater/aws";
import { cosmosDatabase } from "@hot-updater/azure";
import { d1Database } from "@hot-updater/cloudflare";
import { firebaseDatabase } from "@hot-updater/firebase";
import {
  bundleToRow,
  compileReleaseCatalog,
  coreTarget,
  createEngine,
  createKvAdapter,
  createMemoryAdapter,
  createSqlAdapter,
  type DatabaseAdapter,
  DatabaseConstraintError,
  SETTINGS_TABLE,
  type StoredRow,
  type WriteOp,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/protocol";
import {
  createBundleFixture,
  createMemoryKeyValueStore,
  setReleaseCatalogPartitioning,
  createReleaseCatalogPartitionFixture,
} from "@hot-updater/test-utils";
import {
  sqliteBatchExecutor,
  sqliteExecutor,
} from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import { drainScope } from "./core/catalogWrites";
import { createInProcessCoreApi } from "./core/inProcess.testFixtures";

/**
 * Design-v4 §13 modelled each conversion's atomic fit (review P3-1). Here
 * every fixture converts through core's real write path over each store's
 * real `fits`, taken from each provider's public database: `dynamoDB`,
 * `cosmosDatabase`, `firebaseDatabase` and the REST `d1Database`, built
 * offline (none connects before a request), each judging writes against its
 * store's own limits. The rows live in an in-memory store of the same kit
 * (the key-value kit, or the SQL kit as D1 runs it: 100 parameters, batch
 * writes), so only the provider decides what fits. The SQL kit also runs
 * with its default 1,000 operations (the
 * PostgreSQL, MySQL and SQLite routes; MongoDB's `fits` is the same
 * `ops.length <= 1000`), and the memory adapter. The results replace §13's
 * "staged on" column, and the tables are written to the scratchpad given
 * by `HOT_UPDATER_MEASURE_DIR`.
 */

const OUT = process.env.HOT_UPDATER_MEASURE_DIR;
const CHANNEL = "production";
const scopeKeyOf = (channel = CHANNEL) =>
  createReleaseCatalogScopeKey({
    channelKey: encodeChannelKey(channel),
    platform: "ios",
    strategy: "APP_VERSION",
  });
const PARTITIONS = coreTarget.schema.tables.find(
  ({ name }) => name === "release_catalog_partitions",
)!;
const CATALOGS = coreTarget.schema.tables.find(
  ({ name }) => name === "release_catalogs",
)!;

// --- Stores --------------------------------------------------------------

type StoreName = "memory" | "dynamodb" | "cosmos" | "firestore" | "d1" | "sql";

const sqlite = (maxOps: number | undefined, batch: boolean) => {
  const db = new DatabaseSync(":memory:");
  const adapter = createSqlAdapter({
    executor: batch ? sqliteBatchExecutor(db) : sqliteExecutor(db),
    ...(maxOps === undefined ? {} : { maxOps }),
    ...(batch ? { maxParams: 100 } : {}),
  });
  return { adapter, db };
};

/**
 * Each provider's own `fits`, from its public database: built offline, as a
 * config loads, since none connects before its first request.
 */
const providerFits = {
  cosmos: () =>
    cosmosDatabase({
      connectionString:
        "AccountEndpoint=https://fits.documents.azure.com:443/;AccountKey=Zml0cw==;",
    }).adapter,
  d1: () =>
    d1Database({
      accountId: "fits",
      cloudflareApiToken: "fits",
      databaseId: "fits",
    }).adapter,
  dynamodb: () =>
    dynamoDB({
      credentials: { accessKeyId: "fits", secretAccessKey: "fits" },
      region: "us-east-1",
      tableName: "fits",
    }).adapter,
  firestore: () => firebaseDatabase({ projectId: "fits" }).adapter,
} as const;

/** Rows in `data`, judged by the provider's own `fits`. */
const judgedBy = (
  data: DatabaseAdapter,
  provider: DatabaseAdapter,
): DatabaseAdapter =>
  Object.assign(Object.create(data) as DatabaseAdapter, {
    fits: (ops: Parameters<DatabaseAdapter["fits"]>[0]) => provider.fits(ops),
  });

const openStore = async (name: StoreName): Promise<DatabaseAdapter> => {
  switch (name) {
    case "memory":
      return createMemoryAdapter();
    case "dynamodb":
    case "cosmos":
    case "firestore":
      return judgedBy(
        createKvAdapter({ store: createMemoryKeyValueStore() }),
        providerFits[name](),
      );
    case "d1":
    case "sql": {
      const { adapter: data } = sqlite(undefined, name === "d1");
      const adapter = name === "d1" ? judgedBy(data, providerFits.d1()) : data;
      await adapter.migrations!.apply([
        ...coreTarget.schema.tables,
        SETTINGS_TABLE,
      ]);
      return adapter;
    }
  }
};

const STORES: readonly StoreName[] = [
  "memory",
  "dynamodb",
  "cosmos",
  "firestore",
  "d1",
  "sql",
];

/** The highest heap seen since `measured` started: sampled on a timer and at every store call. */
let heapPeak = 0;
const sampleHeap = () => {
  heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
};

/** Counts what reaches the store: calls, rows read, ops and bytes written. */
const counting = (adapter: DatabaseAdapter) => {
  const totals = {
    gets: 0,
    queries: 0,
    rowsRead: 0,
    writes: 0,
    ops: 0,
    bytes: 0,
  };
  const sized = (op: WriteOp) =>
    op.type === "insert"
      ? JSON.stringify(op.row).length
      : op.type === "patch"
        ? JSON.stringify(op.set).length
        : 0;
  const counted: DatabaseAdapter = Object.assign(
    Object.create(adapter) as DatabaseAdapter,
    {
      async get(table: never, keys: never) {
        const rows = (await adapter.get(table, keys)) as (StoredRow | null)[];
        totals.gets += 1;
        sampleHeap();
        totals.rowsRead += rows.filter((row) => row !== null).length;
        return rows;
      },
      async query(table: never, request: never) {
        const rows = (await adapter.query(table, request)) as StoredRow[];
        totals.queries += 1;
        sampleHeap();
        totals.rowsRead += rows.length;
        return rows;
      },
      async write(ops: readonly WriteOp[]) {
        sampleHeap();
        const result = await adapter.write(ops);
        if (result.ok) {
          totals.writes += 1;
          totals.ops += ops.length;
          totals.bytes += ops.reduce((sum, op) => sum + sized(op), 0);
        }
        return result;
      },
    },
  );
  const reset = () => {
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] = 0;
    }
  };
  return { adapter: counted, reset, totals };
};

// --- Fixtures (design-v4 §13, measure-v4.ts) ---------------------------------

let state = 0;
const reseed = () => {
  state = 0x9e3779b9;
};
const rnd = () => {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state / 0x100000000;
};
const pick = <T>(items: readonly T[]) =>
  items[Math.floor(rnd() * items.length)]!;
const mixedRange = (versions: number): string => {
  const a = Math.floor(rnd() * versions);
  const b = Math.min(versions, a + 1 + Math.floor(rnd() * 4));
  return pick([
    `1.${a}.0`,
    `1.${a}.0`,
    `1.${a}.0`,
    `1.${a}.0`,
    `1.${a}.x`,
    `^1.${a}.0`,
    `>=1.${a}.0`,
    `>=1.${a}.0 <1.${b}.0`,
    `1.${a}.0 || 1.${b}.0`,
    `>=1.${a}.0-beta.1 <1.${b}.0`,
    `*`,
    `2.${a}.0`,
  ]);
};
const uuid = (t: number) =>
  `${t.toString(16).padStart(8, "0")}-0000-7000-8000-000000000000`;

interface Fixture {
  readonly label: string;
  readonly n: number;
  readonly range: (i: number) => string;
  readonly enabled: () => boolean;
  readonly message: (i: number) => string;
  /** Today's compact row of it exceeds 256 KB: seeded partitioned. */
  readonly overCap?: boolean;
}

const always = () => true;
const mostly = () => rnd() > 0.1;
const short = (i: number) => `release ${i}`;

const FIXTURES: readonly Fixture[] = [
  {
    label: "300 over 12, mixed",
    n: 300,
    range: () => mixedRange(12),
    enabled: mostly,
    message: short,
  },
  {
    label: "1000 over 40, mixed",
    n: 1000,
    range: () => mixedRange(40),
    enabled: mostly,
    message: short,
    overCap: true,
  },
  {
    label: "1150 over 1, mixed",
    n: 1150,
    range: () => mixedRange(1),
    enabled: mostly,
    message: short,
  },
  {
    label: "1150 over 1, exact",
    n: 1150,
    range: () => "1.0.0",
    enabled: always,
    message: short,
  },
  {
    label: "300 over 12, exact",
    n: 300,
    range: (i) => `1.${i % 12}.0`,
    enabled: always,
    message: short,
  },
  {
    label: "98 exact versions",
    n: 98,
    range: (i) => `1.${i}.0`,
    enabled: always,
    message: short,
  },
  {
    label: "24 exact × 5, 8 KB messages",
    n: 120,
    range: (i) => `1.${i % 24}.0`,
    enabled: always,
    message: (i) => `${i}:`.padEnd(8000, "m"),
    overCap: true,
  },
  {
    label: "300 exact versions",
    n: 300,
    range: (i) => `1.${i}.0`,
    enabled: always,
    message: short,
  },
  {
    label: "600 exact versions",
    n: 600,
    range: (i) => `1.${i}.0`,
    enabled: always,
    message: short,
  },
];

/** The fixture's releases as rows of `channel`'s scope, ids ascending. */
const historyOf = (fixture: Fixture, channelId: string, channel = CHANNEL) => {
  reseed();
  const rows = [];
  let t = 0x1000;
  for (let i = 0; i < fixture.n; i += 1) {
    t += 2;
    const range = fixture.range(i);
    const enabled = fixture.enabled();
    const force = rnd() > 0.9;
    const message = fixture.message(i);
    const rollout = pick([0, 1, 10, 500, 1000, 1000, 1000]);
    const cohorts = rnd() > 0.8 ? [pick(["qa", "beta", "staff"])] : [];
    rows.push({
      bundle: { ...createBundleFixture(String(i)), id: uuid(t) },
      release: {
        bundle_id: uuid(t),
        channel_id: channelId,
        created_at_ms: t,
        enabled,
        fingerprint_hash: null,
        id: uuid(t + 1),
        kind: "BUNDLE" as const,
        message,
        operation: "DEPLOY" as const,
        platform: "ios" as const,
        revision: 1,
        rollout_cohort_count: rollout,
        scope_key: scopeKeyOf(channel),
        should_force_update: force,
        source_release_id: null,
        strategy: "APP_VERSION" as const,
        target_app_version: range,
        target_cohorts: cohorts,
        updated_at_ms: t,
      },
    });
  }
  return rows;
};

const noDelay = { catalogWrites: { restartDelay: async () => {} } };

/**
 * A scope holding `fixture`'s releases: its catalog row first, then the
 * releases and bundles as rows, then a rebuild through core. With the
 * switch off that is today's compact row; with it on, the rebuild is the
 * scope's conversion.
 */
const seeded = async (
  adapter: DatabaseAdapter,
  fixture: Fixture,
  {
    partitioned = false,
    channel = CHANNEL,
    beforeRebuild,
  }: {
    readonly partitioned?: boolean;
    readonly channel?: string;
    /** Runs right before the rebuild, which converts when `partitioned`. */
    readonly beforeRebuild?: () => void;
  } = {},
) => {
  const core = createInProcessCoreApi(adapter, noDelay);
  const db = createEngine({ name: "seed", adapter }).core;
  const { id: channelId } = await core.ensureChannel(channel);
  const scopeKey = scopeKeyOf(channel);
  const empty = await compileReleaseCatalog({
    releases: [],
    strategy: "APP_VERSION",
  });
  await db.transaction(async (tx) => {
    tx.create("release_catalogs", {
      byte_size: empty.byteSize,
      catalog_hash: empty.catalogHash,
      catalog_id: "0190f3a2-0000-7000-8000-000000000000",
      channel_id: channelId,
      channel_key: encodeChannelKey(channel),
      fingerprint_hash: null,
      generation: 1,
      is_tombstone: true,
      payload: empty.canonicalPayload,
      platform: "ios",
      scope_key: scopeKey,
      strategy: "APP_VERSION",
      updated_at_ms: 1,
    });
  });
  const history = historyOf(fixture, channelId, channel);
  for (let at = 0; at < history.length; at += 4) {
    await db.transaction(async (tx) => {
      for (const { bundle, release } of history.slice(at, at + 4)) {
        tx.create("bundles", bundleToRow(bundle));
        tx.create("releases", release);
      }
    });
  }
  if (partitioned) await setReleaseCatalogPartitioning(adapter, "on");
  beforeRebuild?.();
  const rebuilt = await core.rebuildReleaseCatalog(scopeKey);
  return { core, rebuilt, scopeKey };
};

const deployOne = (
  core: ReturnType<typeof createInProcessCoreApi>,
  suffix: string,
  targetAppVersion: string,
  extra: { readonly message?: string; readonly channel?: string } = {},
) =>
  core.deploy([
    {
      bundle: createBundleFixture(suffix),
      release: {
        channel: extra.channel ?? CHANNEL,
        enabled: true,
        fingerprintHash: null,
        message: extra.message ?? null,
        shouldForceUpdate: false,
        targetAppVersion,
      },
    },
  ]);

type Outcome = "atomic" | "staged" | "compact";

/** Every stored row of a scope's partitions, R and markers included, by key. */
const partitionRows = async (adapter: DatabaseAdapter, scopeKey: string) =>
  (
    await adapter.query(PARTITIONS, {
      eq: [scopeKey],
      index: "byScope",
      limit: 500,
      order: "asc",
    })
  ).map(
    (row) => `${String(row.epoch)}/${String(row.lower_key)}@${String(row._v)}`,
  );

/** How the scope's last write committed, from its rows. */
const layoutOf = async (adapter: DatabaseAdapter, scopeKey: string) => {
  const [row] = await adapter.get(CATALOGS, [[scopeKey]]);
  const payload = JSON.parse(String(row!.payload)) as { epoch?: string };
  const [staging] = await adapter.get(PARTITIONS, [[scopeKey, "!", "!"]]);
  return {
    epoch: payload.epoch ?? null,
    staged:
      staging === null || staging === undefined
        ? null
        : (JSON.parse(String(staging.payload)) as { epoch: string | null })
            .epoch,
  };
};

const outcomeOf = (
  before: Awaited<ReturnType<typeof layoutOf>>,
  after: Awaited<ReturnType<typeof layoutOf>>,
): Outcome => {
  if (after.epoch === null) return "compact";
  // A staged flip publishes the epoch R names; an atomic write keeps the
  // live epoch, or converts with a fresh one R never names.
  return after.epoch !== before.epoch && after.staged === after.epoch
    ? "staged"
    : "atomic";
};

const HEADERS = {
  cost: "| Write | gets | queries | rows read | writes | ops | bytes written | peak heap / elapsed |\n| --- | --- | --- | --- | --- | --- | --- | --- |",
  fits: "| Fixture | memory | dynamodb | cosmos | firestore | d1 | sql |\n| --- | --- | --- | --- | --- | --- | --- |",
};
const tables: Record<keyof typeof HEADERS, string[]> = { cost: [], fits: [] };
/** Adds a line to a table and writes it out. */
const record = (name: keyof typeof HEADERS, line: string) => {
  tables[name].push(line);
  if (OUT === undefined) return;
  writeFileSync(
    `${OUT}/${name}-table.md`,
    `${HEADERS[name]}\n${tables[name].join("\n")}\n`,
  );
};

// --- 1. Conversions over each store's real `fits` -----------------------------

/**
 * What each conversion did, by fixture and store: a deploy of one exact
 * release into a compact scope with the switch on. Over-cap fixtures, which
 * today refuses, are partitioned by their rebuild and record their next
 * deploy instead.
 */
const EXPECTED: Record<string, Record<StoreName, string>> = {
  "300 over 12, mixed": {
    memory: "atomic",
    dynamodb: "atomic",
    cosmos: "atomic",
    firestore: "atomic",
    d1: "atomic",
    sql: "atomic",
  },
  "1000 over 40, mixed": {
    memory: "atomic, then atomic",
    dynamodb: "staged, then atomic",
    cosmos: "staged, then atomic",
    firestore: "atomic, then atomic",
    d1: "atomic, then atomic",
    sql: "atomic, then atomic",
  },
  "1150 over 1, mixed": {
    memory: "atomic",
    dynamodb: "atomic",
    cosmos: "atomic",
    firestore: "atomic",
    d1: "atomic",
    sql: "atomic",
  },
  "1150 over 1, exact": {
    memory: "atomic",
    dynamodb: "atomic",
    cosmos: "atomic",
    firestore: "atomic",
    d1: "atomic",
    sql: "atomic",
  },
  "300 over 12, exact": {
    memory: "atomic",
    dynamodb: "atomic",
    cosmos: "atomic",
    firestore: "atomic",
    d1: "atomic",
    sql: "atomic",
  },
  "98 exact versions": {
    memory: "atomic",
    dynamodb: "staged",
    cosmos: "staged",
    firestore: "atomic",
    d1: "atomic",
    sql: "atomic",
  },
  "24 exact × 5, 8 KB messages": {
    memory: "atomic, then atomic",
    dynamodb: "atomic, then atomic",
    cosmos: "staged, then atomic",
    firestore: "atomic, then atomic",
    d1: "atomic, then atomic",
    sql: "atomic, then atomic",
  },
  "300 exact versions": {
    memory: "atomic",
    dynamodb: "staged",
    cosmos: "staged",
    firestore: "staged",
    d1: "staged",
    sql: "atomic",
  },
  "600 exact versions": {
    memory: "atomic",
    dynamodb: "staged",
    cosmos: "staged",
    firestore: "staged",
    d1: "staged",
    sql: "staged",
  },
};

describe("conversions over each store's real fits (design-v4 §13, ruling 8)", () => {
  const results: Record<string, Partial<Record<StoreName, string>>> = {};
  for (const fixture of FIXTURES) {
    it(`${fixture.label}`, async () => {
      results[fixture.label] = {};
      for (const store of STORES) {
        const adapter = await openStore(store);
        const { core, scopeKey } = await seeded(adapter, fixture, {
          partitioned: fixture.overCap === true,
        });
        if (fixture.overCap) {
          // Its conversion was the rebuild, from the empty compact row.
          const converted = outcomeOf(
            { epoch: null, staged: null },
            await layoutOf(adapter, scopeKey),
          );
          const before = await layoutOf(adapter, scopeKey);
          await deployOne(core, "600000", "1.0.0");
          const next = outcomeOf(before, await layoutOf(adapter, scopeKey));
          results[fixture.label]![store] = `${converted}, then ${next}`;
          continue;
        }
        const compact = await layoutOf(adapter, scopeKey);
        expect(compact.epoch).toBeNull();
        await setReleaseCatalogPartitioning(adapter, "on");
        const before = await layoutOf(adapter, scopeKey);
        await deployOne(core, "600000", "1.0.0");
        const outcome = outcomeOf(before, await layoutOf(adapter, scopeKey));
        results[fixture.label]![store] = outcome;
      }
      record(
        "fits",
        `| ${fixture.label} | ${STORES.map((store) => results[fixture.label]![store]).join(" | ")} |`,
      );
      expect(results[fixture.label]).toEqual(EXPECTED[fixture.label]);
    }, 600_000);
  }
});

// --- Escape-heavy payloads and long keys ----------------------------------------

/** The largest `n` in [low, high] for which `accepted(n)`; `accepted(low)` holds. */
const boundary = async (
  low: number,
  high: number,
  accepted: (n: number) => Promise<boolean>,
) => {
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (await accepted(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
};

const refused = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof DatabaseConstraintError
      ? `DatabaseConstraintError(${error.reason})`
      : ((error as { code?: string }).code ?? (error as Error).name);
  }
};

/**
 * Quotes and backslashes: the canonical payload escapes each to 2 bytes, and
 * the key-value item escapes that again to 4, so DynamoDB's 400 KB item
 * binds before the compiler's 256 KB.
 */
const escapeHeavy = (length: number) =>
  Array.from({ length }, (_, i) => ['"', "\\"][i % 2]).join("");

describe("escape-heavy messages at DynamoDB's item limit (ruling 8)", () => {
  it("accepts what today accepts and refuses what today refuses, by the real fits", async () => {
    // A partitioned scope of two releases, then one escape-heavy release.
    const attempt = async (length: number, partitioned: boolean) => {
      const adapter = await openStore("dynamodb");
      const core = createInProcessCoreApi(adapter, noDelay);
      if (partitioned) await setReleaseCatalogPartitioning(adapter, "on");
      await deployOne(core, "610001", "1.0.0");
      await deployOne(core, "610002", "2.0.0");
      const before = await partitionRows(adapter, scopeKeyOf());
      const error = await refused(() =>
        deployOne(core, "610003", "1.0.0", { message: escapeHeavy(length) }),
      );
      // A refusal writes nothing: no staging row, marker or row of it.
      if (error !== null) {
        expect(await partitionRows(adapter, scopeKeyOf())).toEqual(before);
      }
      return { adapter, error };
    };
    // Today's largest accepted message: the compact row's item at 400 KB.
    const today = await boundary(
      1,
      200_000,
      async (length) => (await attempt(length, false)).error === null,
    );
    // The item binds (4 bytes a character) before the compiler's 256 KB
    // cap (2 bytes a character) would, at about 100,000 characters.
    expect(today).toBeLessThan(110_000);
    expect(today).toBeGreaterThan(90_000);
    const accepted = await attempt(today, true);
    expect(accepted.error).toBeNull();
    const over = await attempt(today + 1, true);
    // Partitioning refuses nothing today accepts, and nothing more: the row
    // holding the release is its interval's share of the same bytes.
    const todayOver = await attempt(today + 1, false);
    record(
      "fits",
      `| escape-heavy message, DynamoDB item | today accepts ≤ ${today} chars; partitioned accepts ${today}: ${accepted.error ?? "yes"}; at ${today + 1}: today ${todayOver.error ?? "accepts"}, partitioned ${over.error ?? "accepts"} |`,
    );
    expect(todayOver.error).toBe("DatabaseConstraintError(too_large)");
    // A partition row is smaller than the compact row, so it may still fit.
    expect([null, "DatabaseConstraintError(too_large)"]).toContain(over.error);
    // One row alone over the item limit: refused before anything is
    // staged, as today refuses it (the refusal check in `attempt`).
    const far = await attempt(today + 10_000, true);
    expect(far.error).toBe("DatabaseConstraintError(too_large)");
    expect((await attempt(today + 10_000, false)).error).toBe(far.error);
  }, 600_000);
});

describe("long keys (ruling 8)", () => {
  // The longest channel name is 255 characters (`channels.name`), so the
  // longest partition sort key is its scope key, an epoch and a 256-byte
  // lower key: about 660 bytes, under DynamoDB's 1,024 and Firestore's
  // 1,500. What can overflow is the `lower_key` column itself.
  const CHANNEL_MAX = "c".repeat(255);
  /** `>=2.0.0-<id> <3.0.0`, whose lower key is `id.length + 11` bytes. */
  const prerelease = (length: number) => `>=2.0.0-${"a".repeat(length)} <3.0.0`;

  it.each(["memory", "dynamodb", "firestore", "d1"] as const)(
    "partitions up to a 256-byte lower key under a 255-character channel, and keeps a longer one compact (%s)",
    async (store) => {
      const outcome = async (length: number) => {
        const adapter = await openStore(store);
        const core = createInProcessCoreApi(adapter, noDelay);
        await setReleaseCatalogPartitioning(adapter, "on");
        await deployOne(core, "630001", "1.0.0", { channel: CHANNEL_MAX });
        const error = await refused(() =>
          deployOne(core, "630002", prerelease(length), {
            channel: CHANNEL_MAX,
          }),
        );
        return {
          epoch: (await layoutOf(adapter, scopeKeyOf(CHANNEL_MAX))).epoch,
          error,
        };
      };
      expect(await outcome(245)).toEqual({
        epoch: expect.any(String),
        error: null,
      });
      // A 257-byte lower key: the scope is written compact, and deploys.
      expect(await outcome(246)).toEqual({ epoch: null, error: null });
      // The longest version the compiler takes (256 characters) stays compact too.
      expect(await outcome(250)).toEqual({ epoch: null, error: null });
      if (store === "dynamodb") {
        record(
          "fits",
          "| 255-char channel, 2.0.0 prerelease endpoint | lower key 256 B: partitioned; 257 B and the 256-char version: compact, deployed; every partition sort key under DynamoDB's 1,024 B |",
        );
      }
    },
  );
});

// --- 2. Multi-scope final fit (ruling 5) -----------------------------------------

describe("multi-scope batches at a store's atomic limit (ruling 5)", () => {
  const results: Record<string, string[]> = {};
  const CHANNELS = ["alpha", "beta", "gamma"];
  /** A batch over three scopes; the last bundle carries `patches` patches. */
  const batch = (patches: number) =>
    CHANNELS.map((channel, index) => {
      const bundle = createBundleFixture(String(800_000 + index));
      return {
        bundle: {
          ...bundle,
          ...(index === CHANNELS.length - 1
            ? {
                patches: Array.from({ length: patches }, (_, at) => ({
                  baseBundleId: createBundleFixture(String(900_000 + at)).id,
                  baseFileHash: `base-${at}`,
                  byteSize: 1_000,
                  patchFileHash: `patch-${at}`,
                  patchStorageUri: `storage://patches/${at}`,
                })),
              }
            : {}),
        },
        release: {
          channel,
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.0",
        },
      };
    });

  /** Three scopes, each converted (or compact), and the patch bases deployed. */
  const prepared = async (store: StoreName, partitioned: boolean) => {
    const adapter = await openStore(store);
    const core = createInProcessCoreApi(adapter, noDelay);
    if (partitioned) await setReleaseCatalogPartitioning(adapter, "on");
    for (const [index, channel] of CHANNELS.entries()) {
      await deployOne(core, String(700_000 + index * 2), "1.0.0", { channel });
      await deployOne(core, String(700_001 + index * 2), "2.0.0", { channel });
    }
    // Patch bases: stored bundles, more than any store's limit takes.
    const db = createEngine({ name: "bases", adapter }).core;
    for (let at = 0; at < 500; at += 20) {
      await db.transaction(async (tx) => {
        for (let base = at; base < at + 20; base += 1) {
          tx.create(
            "bundles",
            bundleToRow(createBundleFixture(String(900_000 + base))),
          );
        }
      });
    }
    return { adapter, core };
  };

  for (const store of ["dynamodb", "d1"] as const) {
    it(`accepts every batch today accepts on ${store}, and refuses only what today refuses`, async () => {
      const today = await boundary(0, 499, async (patches) => {
        const { core } = await prepared(store, false);
        return (await refused(() => core.deploy(batch(patches)))) === null;
      });
      expect(today).toBeLessThan(499);
      const outcomes: string[] = [];
      const seen = new Set<string>();
      for (let patches = today - 4; patches <= today; patches += 1) {
        const { adapter, core } = await prepared(store, true);
        const before = await Promise.all(
          CHANNELS.map((channel) => layoutOf(adapter, scopeKeyOf(channel))),
        );
        // No batch today accepts is refused.
        expect(await refused(() => core.deploy(batch(patches)))).toBeNull();
        const after = await Promise.all(
          CHANNELS.map((channel) => layoutOf(adapter, scopeKeyOf(channel))),
        );
        const kinds = after.map((layout, index) =>
          outcomeOf(before[index]!, layout),
        );
        seen.add(kinds.join("/"));
        outcomes.push(`${patches}: ${kinds.join("/")}`);
      }
      results[store] = outcomes;
      expect(outcomes.at(-1)).toBe(`${today}: compact/compact/compact`);
      // Near the limit the batch stages, and at it the heads' R checks push
      // the flip over, so the write keeps today's compact rows.
      expect(seen.has("compact/compact/compact")).toBe(true);
      expect(seen.has("staged/staged/staged")).toBe(true);
      const over = await prepared(store, true);
      const overToday = await prepared(store, false);
      const refusal = await refused(() => over.core.deploy(batch(today + 1)));
      expect(refusal).toBe(
        await refused(() => overToday.core.deploy(batch(today + 1))),
      );
      expect(refusal).toBe("DatabaseConstraintError(too_large)");
      record(
        "fits",
        `| 3-scope batch with patches, ${store} | today accepts ≤ ${today} patches; partitioned ${outcomes.join("; ")}; ${today + 1}: both ${refusal} |`,
      );
    }, 600_000);
  }
});

// --- 3. Cost per write class -------------------------------------------------------

const PEAK_SAMPLE_MS = 2;
/** Peak heap growth and elapsed time of `work`. */
const measured = async <T>(work: () => Promise<T>) => {
  const base = process.memoryUsage().heapUsed;
  heapPeak = base;
  const timer = setInterval(sampleHeap, PEAK_SAMPLE_MS);
  const started = performance.now();
  try {
    const result = await work();
    sampleHeap();
    return {
      elapsedMs: Math.round(performance.now() - started),
      peakMiB: Math.round(((heapPeak - base) / 2 ** 20) * 10) / 10,
      result,
    };
  } finally {
    clearInterval(timer);
  }
};

describe("cost per write class (ruling 5)", () => {
  const row = (
    label: string,
    totals: ReturnType<typeof counting>["totals"],
    extra = "",
  ) => {
    record(
      "cost",
      `| ${label} | ${totals.gets} | ${totals.queries} | ${totals.rowsRead} | ${totals.writes} | ${totals.ops} | ${totals.bytes} | ${extra} |`,
    );
  };

  it("steady exact deploy, conversion, broad insert, rebuild, and reclamation", async () => {
    const exact = FIXTURES.find(({ label }) => label === "300 over 12, exact")!;
    const mixed = FIXTURES.find(({ label }) => label === "300 over 12, mixed")!;

    // Conversion of the exact fixture, then a steady exact deploy.
    {
      const io = counting(createMemoryAdapter());
      const { core, scopeKey } = await seeded(io.adapter, exact);
      await setReleaseCatalogPartitioning(io.adapter, "on");
      io.reset();
      await deployOne(core, "640001", "1.3.0");
      row("conversion, 300/12 exact (25 rows)", io.totals);
      expect(io.totals.writes).toBe(1);
      io.reset();
      await deployOne(core, "640002", "1.4.0");
      row("steady exact deploy, 300/12 exact", io.totals);
      // The head, discovery, the covering row twice (read, then guarded),
      // the newest release under its root, and the bundle's checks.
      expect(io.totals.queries).toBeLessThanOrEqual(4);
      expect(io.totals.gets).toBeLessThanOrEqual(5);
      expect(io.totals.rowsRead).toBeLessThan(20);
      expect(io.totals.writes).toBe(1);
      // Release, bundle, counters, the replaced rows and the head: not 25 rows.
      expect(io.totals.ops).toBeLessThanOrEqual(10);
      io.reset();
      const noop = await core.rebuildReleaseCatalog(scopeKey);
      expect(noop.changed).toBe(false);
      row("rebuild, unchanged, 300/12 exact", io.totals);
      expect(io.totals.writes).toBe(0);
    }

    // A rebuild that changes the layout: the mixed fixture converted by it.
    {
      const io = counting(createMemoryAdapter());
      let base = 0;
      const { rebuilt } = await seeded(io.adapter, mixed);
      await setReleaseCatalogPartitioning(io.adapter, "on");
      const db = createInProcessCoreApi(io.adapter, noDelay);
      io.reset();
      base = process.memoryUsage().heapUsed;
      const converted = await measured(() =>
        db.rebuildReleaseCatalog(scopeKeyOf()),
      );
      expect(rebuilt.changed).toBe(true);
      expect(converted.result.changed).toBe(true);
      row(
        "rebuild (changed: converts), 300/12 mixed",
        io.totals,
        `${converted.peakMiB} MiB / ${converted.elapsedMs} ms`,
      );
      expect(io.totals.writes).toBe(1);
      expect(base).toBeGreaterThan(0);
    }

    // The mixed fixture: conversion, broad insert, rebuild, assembly.
    {
      const io = counting(createMemoryAdapter());
      const { core, scopeKey } = await seeded(io.adapter, mixed);
      await setReleaseCatalogPartitioning(io.adapter, "on");
      io.reset();
      const conversion = await measured(() =>
        deployOne(core, "650001", "1.3.0"),
      );
      row(
        "conversion, 300/12 mixed (70 rows)",
        io.totals,
        `${conversion.peakMiB} MiB / ${conversion.elapsedMs} ms`,
      );
      expect(io.totals.bytes).toBeGreaterThan(700_000);
      io.reset();
      const broad = await measured(() => deployOne(core, "650002", "*"));
      row(
        "broad `*` insert, 300/12 mixed",
        io.totals,
        `${broad.peakMiB} MiB / ${broad.elapsedMs} ms`,
      );
      expect(io.totals.writes).toBe(1);
      io.reset();
      const assembly = await measured(() =>
        core.getReleaseCatalogRow(scopeKey),
      );
      row(
        "old-client assembly (getReleaseCatalogRow), 300/12 mixed",
        io.totals,
        `${assembly.peakMiB} MiB / ${assembly.elapsedMs} ms`,
      );
      io.reset();
      const ranged = (
        await core.listReleases({
          filter: { kind: "scope", scopeKey },
          limit: 100,
        })
      ).find(
        (release) =>
          release.enabled &&
          release.target_app_version?.startsWith(">=") === true,
      )!;
      io.reset();
      const edit = await measured(() =>
        core.updateReleasePolicy({
          patch: { message: "edited" },
          releaseId: ranged.id,
        }),
      );
      row(
        `edit (message of a ${ranged.target_app_version} release), 300/12 mixed`,
        io.totals,
        `${edit.peakMiB} MiB / ${edit.elapsedMs} ms`,
      );
      // One write: the release, the head, and only the rows holding it.
      expect(io.totals.writes).toBe(1);
      expect(io.totals.ops).toBeGreaterThan(2);
      expect(io.totals.ops).toBeLessThan(72);
      io.reset();
      const rebuild = await measured(() =>
        core.rebuildReleaseCatalog(scopeKey),
      );
      row(
        "rebuild, unchanged, 300/12 mixed",
        io.totals,
        `${rebuild.peakMiB} MiB / ${rebuild.elapsedMs} ms`,
      );
      expect(rebuild.result.changed).toBe(false);
    }

    // The 1000/40 mixed fixture on DynamoDB's limits: conversion by rebuild
    // (staged), a broad insert (staged), assembly, and reclaiming the
    // epoch the broad insert retired.
    {
      const big = FIXTURES.find(
        ({ label }) => label === "1000 over 40, mixed",
      )!;
      const io = counting(await openStore("dynamodb"));
      let started = 0;
      let base = 0;
      const { core, scopeKey } = await seeded(io.adapter, big, {
        beforeRebuild: () => {
          io.reset();
          base = process.memoryUsage().heapUsed;
          heapPeak = base;
          started = performance.now();
        },
        partitioned: true,
      });
      const conversion = {
        elapsedMs: Math.round(performance.now() - started),
        peakMiB: Math.round(((heapPeak - base) / 2 ** 20) * 10) / 10,
      };
      expect(io.totals.writes).toBeGreaterThan(2);
      row(
        "conversion by rebuild (changed), 1000/40 mixed, DynamoDB (staged)",
        io.totals,
        `${conversion.peakMiB} MiB / ${conversion.elapsedMs} ms`,
      );
      io.reset();
      const before = await layoutOf(io.adapter, scopeKey);
      const broad = await measured(() => deployOne(core, "660001", "*"));
      const after = await layoutOf(io.adapter, scopeKey);
      expect(outcomeOf(before, after)).toBe("staged");
      row(
        "broad `*` insert, 1000/40 mixed, DynamoDB (staged)",
        io.totals,
        `${broad.peakMiB} MiB / ${broad.elapsedMs} ms`,
      );
      io.reset();
      const assembly = await measured(() =>
        core.getReleaseCatalogRow(scopeKey),
      );
      // The head and its live rows, once each.
      expect(io.totals.rowsRead).toBeLessThanOrEqual(1 + 219 + 1);
      row(
        "old-client assembly, 1000/40 mixed, DynamoDB",
        io.totals,
        `${assembly.peakMiB} MiB / ${assembly.elapsedMs} ms`,
      );
      // A staged flip drains what it retired, so retire the live epoch the
      // way a released writer's compact row and the next conversion would:
      // its rows copied under a new epoch the head then names.
      const fixture = createReleaseCatalogPartitionFixture(io.adapter);
      const head = await fixture.readRow(scopeKey);
      const live = JSON.parse(head.payload).epoch as string;
      const fresh = crypto.randomUUID();
      const copies = (await fixture.rows(scopeKey))
        .filter((stored) => stored.epoch === live)
        .map((stored) => ({ ...stored, epoch: fresh }));
      await fixture.writeRows(scopeKey, [
        ...copies,
        {
          ...copies[0]!,
          epoch: "#",
          lowerKey: fresh,
          partition: {
            ...copies[0]!.partition,
            lowerKey: fresh,
            payload: JSON.stringify({
              maxRowBytes: Math.max(
                ...copies.map(({ partition }) => partition.byteSize),
              ),
            }),
          },
        },
      ]);
      await fixture.publishHead(scopeKey, {
        catalogHash: head.catalog_hash,
        epoch: fresh,
        generation: head.generation,
      });
      io.reset();
      const engine = createEngine({ name: "drain", adapter: io.adapter }).core;
      const reclaim = await measured(() => drainScope(engine, scopeKey));
      row(
        `reclamation of the retired epoch, 1000/40 mixed, DynamoDB (${reclaim.result} steps)`,
        io.totals,
        `${reclaim.peakMiB} MiB / ${reclaim.elapsedMs} ms`,
      );
      expect(reclaim.result).toBeGreaterThan(0);
      // One transaction a step: at most 25 deletes and its 2 guards.
      expect(io.totals.writes).toBe(reclaim.result);
      expect(io.totals.ops).toBeLessThanOrEqual(reclaim.result * 27);
      // Every step is one page of at most 25 rows and 512 KiB.
      const remaining = await io.adapter.query(PARTITIONS, {
        index: "byScope",
        eq: [scopeKey],
        order: "asc",
        limit: 500,
      });
      expect(
        new Set(
          remaining
            .filter(({ epoch }) => epoch !== "!" && epoch !== "#")
            .map(({ epoch }) => epoch),
        ).size,
      ).toBe(1);
      io.reset();
      const rebuild = await measured(() =>
        core.rebuildReleaseCatalog(scopeKey),
      );
      row(
        "rebuild, unchanged, 1000/40 mixed, DynamoDB",
        io.totals,
        `${rebuild.peakMiB} MiB / ${rebuild.elapsedMs} ms`,
      );
      expect(rebuild.result.changed).toBe(false);
    }
  }, 600_000);
});
