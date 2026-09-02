import type {
  BundleEventRow,
  InsightsEventPageData,
} from "@hot-updater/plugin-core";
import { Query } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import {
  FIREBASE_INSIGHTS_INDEX_REVISION,
  FIREBASE_INSIGHTS_LAYOUT_VERSION,
  firebaseEventDocumentId,
  firebaseEventPageShard,
  firebaseEventScopeKey,
  firebaseEventSourceShard,
  toFirebaseEventDocument,
} from "./firebaseEventIndex";
import {
  createFirebaseInsightsCollections,
  createFirebaseInsightsQueries,
} from "./firebaseInsights";
import { runFirebaseInsightsJobStep } from "./firebaseInsightsJobs";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Firebase integration tests require the Firestore emulator.");
}

const { firestore, clearCollections } = createFirestoreMock(
  "firebase-insights-pages",
);
const namespace = "10000000-0000-4000-8000-000000000001";
const collections = createFirebaseInsightsCollections(firestore, namespace);
const queries = createFirebaseInsightsQueries(
  collections,
  namespace,
  async () => undefined,
);
const bundleId = createBundleEventRowFixture("1", 1).to_bundle_id;
const installId = "target-installation";
const historicalSearchInstallId = "historical-search-target";
const seededSequences = new Map<number, number>();
const seededInstallIds = new Set<string>();
let seededEventCount = 0;

const movement = (index: number): BundleEventRow => ({
  ...createBundleEventRowFixture(String(200_000 + index), 60_000),
  type: index % 2 === 0 ? "UPDATE_APPLIED" : "RECOVERED",
  install_id: installId,
  from_bundle_id: bundleId,
  to_bundle_id: bundleId,
  update_strategy: "appVersion",
});

const seed = async (rows: readonly BundleEventRow[]): Promise<void> => {
  const touchedShards = new Set<number>();
  for (let start = 0; start < rows.length; start += 400) {
    const batch = firestore.batch();
    for (const row of rows.slice(start, start + 400)) {
      const sourceShard = firebaseEventSourceShard(row.id);
      const sequence = (seededSequences.get(sourceShard) ?? 0) + 1;
      seededSequences.set(sourceShard, sequence);
      touchedShards.add(sourceShard);
      seededInstallIds.add(row.install_id);
      seededEventCount += 1;
      batch.create(
        collections.events.doc(firebaseEventDocumentId(row.id)),
        toFirebaseEventDocument(row, sequence, sourceShard),
      );
    }
    await batch.commit();
  }
  const batch = firestore.batch();
  for (const shard of touchedShards) {
    batch.set(
      collections.sourceClocks.doc(
        `live_${shard.toString(16).padStart(2, "0")}`,
      ),
      {
        version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
        shard,
        sequence: seededSequences.get(shard),
        observedAtMs: 90_000,
      },
    );
  }
  await batch.commit();
};

const readyRows = async (
  input: Parameters<typeof queries.pageEvents>[0],
): Promise<InsightsEventPageData> => {
  const result = await queries.pageEvents(input);
  if (result.state !== "ready") throw new Error(result.state);
  return result.data;
};

describe("Firestore v2 sharded Insights pages", () => {
  beforeAll(async () => {
    await clearCollections();
    await collections.control.doc("layout").set({
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      state: "ready",
      indexRevision: FIREBASE_INSIGHTS_INDEX_REVISION,
      databaseNamespace: namespace,
    });
    const sourceBatch = firestore.batch();
    for (let shard = 0; shard < 64; shard += 1) {
      const sourceId = `live_${shard.toString(16).padStart(2, "0")}`;
      sourceBatch.set(collections.sourceClocks.doc(sourceId), {
        version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
        shard,
        sequence: 0,
        observedAtMs: 0,
      });
    }
    sourceBatch.set(collections.sourceClocks.doc("legacy"), {
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      shard: "legacy",
      sequence: 0,
      observedAtMs: 0,
    });
    await sourceBatch.commit();
    const rows: BundleEventRow[] = [];
    for (let index = 0; index < 50_001; index += 1) {
      rows.push({
        ...createBundleEventRowFixture(String(100_000 + index), index),
        type: "UNCHANGED",
        install_id:
          index === 50_000
            ? historicalSearchInstallId
            : "background-installation",
        username: index === 50_000 ? "Historical Search Needle" : null,
        from_bundle_id: null,
        update_strategy: null,
      });
    }
    rows.push(...Array.from({ length: 103 }, (_, index) => movement(index)));
    await seed(rows);
  }, 600_000);

  afterAll(async () => {
    for (const collection of Object.values(collections)) {
      if (typeof collection === "string") continue;
      await firestore.recursiveDelete(collection);
    }
    await clearCollections();
  }, 600_000);

  it.each([
    { kind: "installationId", installId } as const,
    { kind: "bundleId", bundleId } as const,
  ])(
    "pages $kind past 50,001 unrelated rows with bounded stream reads",
    async (selector) => {
      const reads = vi.spyOn(Query.prototype, "get");
      const ids: string[] = [];
      let cursor: string | undefined;
      try {
        do {
          const before = reads.mock.results.length;
          const page = await readyRows({
            selector,
            beforeReceivedAtMs: 60_001,
            limit: 17,
            cursor,
          });
          ids.push(...page.data.map(({ id }) => id));
          expect(reads.mock.results.length - before).toBeLessThanOrEqual(37);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(ids).toEqual(
          Array.from({ length: 103 }, (_, index) => movement(102 - index).id),
        );
      } finally {
        reads.mockRestore();
      }
    },
    60_000,
  );

  it("resumes distributed all-event streams only after emitted rows", async () => {
    const input = {
      selector: { kind: "all" },
      beforeReceivedAtMs: 60_001,
      limit: 100,
    } as const;
    const first = await readyRows(input);
    const second = await readyRows({ ...input, cursor: first.nextCursor! });
    expect(first.data).toHaveLength(100);
    expect(second.data[0]?.id).toBe(movement(2).id);
    expect(
      new Set([...first.data, ...second.data].map(({ id }) => id)).size,
    ).toBe(first.data.length + second.data.length);
  });

  it("resumes an all-one-shard page without a fetched-position cursor", async () => {
    const rows: BundleEventRow[] = [];
    for (let suffix = 400_000; rows.length < 105; suffix += 1) {
      const row = createBundleEventRowFixture(
        String(suffix),
        70_000 + rows.length,
      );
      if (firebaseEventPageShard(row.id) === 7) rows.push(row);
    }
    await seed(rows);
    const input = {
      selector: { kind: "all" },
      sinceReceivedAtMs: 70_000,
      beforeReceivedAtMs: 71_000,
      limit: 100,
    } as const;
    const reads = vi.spyOn(Query.prototype, "get");
    try {
      const first = await readyRows(input);
      const second = await readyRows({ ...input, cursor: first.nextCursor! });
      expect(first.data).toHaveLength(100);
      expect(second.data).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      expect([...first.data, ...second.data].map(({ id }) => id)).toEqual(
        [...rows].reverse().map(({ id }) => id),
      );
      expect(reads).toHaveBeenCalledTimes(44);
    } finally {
      reads.mockRestore();
    }
  });

  it("completes a bounded contains publication across 50,001 raw events", async () => {
    const vector = [
      ...Array.from(
        { length: 64 },
        (_, shard) =>
          [`live_${shard.toString(16).padStart(2, "0")}`, 0] as const,
      ),
      ["legacy", 0] as const,
    ];
    const generation = firebaseEventScopeKey(JSON.stringify(vector));
    await collections.control.doc("projection").set({
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      state: "ready",
      generation,
      observedAtMs: 90_000,
    });
    const input = { kind: "contains", query: "needle", limit: 10 } as const;
    const preparing = await queries.pageInstallations(input);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;

    let processed = 0;
    let steps = 0;
    let state: "building" | "ready" | "failed" = "building";
    while (state === "building") {
      const result = await runFirebaseInsightsJobStep(firestore, collections, {
        jobId: preparing.job.id,
        maxItems: 4_096,
        maxRequests: 7,
        nowMs: Date.now(),
      });
      processed += result.processed;
      steps += 1;
      expect(result.processed).toBeLessThanOrEqual(45);
      expect(result.usage.items).toBe(result.processed);
      expect(result.usage.requests).toBeLessThanOrEqual(7);
      expect(result.usage.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      state = result.state;
    }
    expect(state).toBe("ready");
    expect(processed).toBe(seededEventCount + seededInstallIds.size);
    expect(steps).toBeGreaterThan(Math.ceil(50_001 / 45));

    const ready = await queries.pageInstallations(input);
    expect(ready.state).toBe("ready");
    if (ready.state === "ready") {
      expect(ready.data.data.map(({ install_id }) => install_id)).toEqual([
        historicalSearchInstallId,
      ]);
      expect(ready.data.total).toMatchObject({ state: "exact", value: 1 });
    }
  }, 600_000);
});
