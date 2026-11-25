import {
  type AnyHotUpdaterPlugin,
  createEngine,
  createEngineDatabase,
  createKvAdapter,
  DatabaseConflictError,
  type KeyValueStore,
  migrateCoreSchema,
} from "@hot-updater/plugin-core";
import {
  createBundleEventRowFixture,
  createCapacityCappedStore,
  createMemoryKeyValueStore,
  insights11TestPlugin,
  type Insights11TestApi,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { type BundleEventRow, type InsightsApi, insights } from "./index";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const release = "00000000-0000-7000-8000-000000009980";

/** `plugin` over `store`, as `dynamoDB()` runs it: aggregates batched, retries quick. */
const serve = <T>(store: KeyValueStore, plugin: AnyHotUpdaterPlugin): T => {
  const engine = createEngine(
    createEngineDatabase({
      name: "dynamoDB",
      adapter: createKvAdapter({ store }),
      aggregateBatching: {},
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
    }),
    { plugins: [plugin] },
  );
  const now = Date.now;
  return (
    plugin.init({ db: engine.database(plugin), core: {}, now } as never) as {
      readonly api: T;
    }
  ).api;
};

/** `count` events a 1.1 server keyed by their artifact, in one recent day. */
const seed = async (store: KeyValueStore, count: number) => {
  await migrateCoreSchema(createKvAdapter({ store }), "dynamoDB", [
    insights(),
  ]);
  const legacy = serve<Insights11TestApi>(store, insights11TestPlugin());
  const base = Date.now() - (Date.now() % HOUR) - 2 * HOUR;
  for (let n = 0; n < count; n += 1) {
    await legacy.record({
      ...createBundleEventRowFixture(String(9990 + n), base + n),
      install_id: `capped-${n}`,
      to_release_id: release,
    } as BundleEventRow);
  }
  return base;
};

const launches = (api: InsightsApi, base: number) =>
  api.countEvents({
    filter: {
      platform: "ios",
      channel: "production",
      type: "UPDATE_APPLIED",
      toReleaseId: release,
    },
    sinceMs: base - DAY,
    beforeReceivedAtMs: base + DAY,
  });

describe("backfillReleaseRefs on a store with a write-capacity cap", () => {
  // `hot-updater init` caps the AWS table at 100 write units a second. One
  // rewrite there is five items (the event and its index copies), 2 units a
  // KB each in a transaction, so 13 rewrites cost more than a second of it.
  it("moves every event in transactions the cap admits", async () => {
    const inner = createMemoryKeyValueStore();
    const base = await seed(inner, 40);
    const capped = createCapacityCappedStore(inner, { unitsPerSecond: 100 });
    const api = serve<InsightsApi>(capped, insights());

    await expect(api.backfillReleaseRefs()).resolves.toEqual({ events: 40 });

    // The cap refused the larger transactions before the backfill fit it.
    expect(capped.throttles()).toBeGreaterThan(0);
    // Read back without the cap, which a compaction may wait on.
    const uncapped = serve<InsightsApi>(inner, insights());
    await expect(launches(uncapped, base)).resolves.toBe(40);
    await expect(
      uncapped.backfillReleaseRefs({ dryRun: true }),
    ).resolves.toEqual({ events: 0 });
  });

  it("fails, without moving anything, when the store admits no single rewrite, and finishes on the next run", async () => {
    const inner = createMemoryKeyValueStore();
    const base = await seed(inner, 3);
    // One rewrite costs 10 units or more.
    const starved = createCapacityCappedStore(inner, { unitsPerSecond: 5 });

    await expect(
      serve<InsightsApi>(starved, insights()).backfillReleaseRefs(),
    ).rejects.toBeInstanceOf(DatabaseConflictError);

    const api = serve<InsightsApi>(inner, insights());
    await expect(api.backfillReleaseRefs({ dryRun: true })).resolves.toEqual({
      events: 3,
    });
    await expect(api.backfillReleaseRefs()).resolves.toEqual({ events: 3 });
    await expect(launches(api, base)).resolves.toBe(3);
  });
});
