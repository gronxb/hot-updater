import { beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import {
  firebaseEventDocumentId,
  firebaseEventSourceShard,
} from "./firebaseEventIndex";
import {
  createFirebaseInsightsCollections,
  createFirebaseInsightsQueries,
} from "./firebaseInsights";
import { runFirebaseInsightsJobStep } from "./firebaseInsightsJobs";
import {
  appendFirebaseInsightsEvent,
  prepareFirebaseInsightsStep,
  projectFirebaseInsightsStep,
  publishFirebaseInsightsProjection,
} from "./firebaseInsightsMaintenance";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Firebase integration tests require the Firestore emulator.");
}

const { firestore, bundleEventsCollection, clearCollections } =
  createFirestoreMock("firebase-insights-jobs");
const collections = createFirebaseInsightsCollections(firestore);
const namespace = "firebase-insights-jobs/(default)";
const queries = createFirebaseInsightsQueries(collections, namespace, (row) =>
  appendFirebaseInsightsEvent(firestore, collections, row),
);

const runJob = async (jobId: string) => {
  for (let step = 0; step < 200; step += 1) {
    const result = await runFirebaseInsightsJobStep(firestore, collections, {
      jobId,
      maxItems: 10,
      maxRequests: 7,
      nowMs: Date.now(),
    });
    expect(result.usage).toMatchObject({ items: result.processed });
    expect(result.usage.requests).toBeGreaterThan(0);
    expect(result.usage.requests).toBeLessThanOrEqual(7);
    expect(result.usage.bytes).toBeGreaterThan(0);
    expect(result.usage.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    if (result.state !== "building") return result;
  }
  throw new Error("job did not finish");
};

const publishLatest = async (
  rows: readonly Parameters<typeof appendFirebaseInsightsEvent>[2][],
) => {
  await prepareFirebaseInsightsStep(
    firestore,
    bundleEventsCollection,
    collections,
    {
      writersDrained: true,
      indexesReady: true,
      maxItems: 1,
      maxRequests: 4,
    },
  );
  for (const row of rows) {
    await appendFirebaseInsightsEvent(firestore, collections, row);
  }
  for (const shard of new Set(
    rows.map(({ id }) => firebaseEventSourceShard(id)),
  )) {
    await projectFirebaseInsightsStep(firestore, collections, {
      sourceShard: shard,
      maxItems: 100,
      maxRequests: 4,
    });
  }
  await expect(
    publishFirebaseInsightsProjection(firestore, collections, Date.now()),
  ).resolves.toMatchObject({ published: true });
};

describe("Firestore durable Insights publications", () => {
  beforeEach(clearCollections);

  it("captures 65 clocks and publishes an immutable report manifest", async () => {
    const bundleId = "bundle-report";
    const bucketStartMs = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const rows = [
      {
        ...createBundleEventRowFixture("970001", bucketStartMs + 100),
        install_id: "installation-a",
        to_bundle_id: bundleId,
        cohort: "cohort-a",
      },
      {
        ...createBundleEventRowFixture("970002", bucketStartMs + 200),
        install_id: "installation-a",
        to_bundle_id: bundleId,
        cohort: "cohort-a",
      },
      {
        ...createBundleEventRowFixture("970003", bucketStartMs + 300),
        install_id: "installation-b",
        to_bundle_id: bundleId,
        cohort: "cohort-b",
      },
    ];
    await publishLatest(rows);
    const input = {
      query: { kind: "bundleDetail", bundleId, window: "all" },
    } as const;

    const preparing = await queries.getReport(input);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    const reserved = (
      await collections.jobs.doc(preparing.job.id).get()
    ).data();
    expect(reserved?.sourceGeneration).toBe(
      preparing.versions.sourceGeneration,
    );
    expect(reserved?.upperSequences).toHaveLength(65);
    await expect(runJob(preparing.job.id)).resolves.toMatchObject({
      state: "ready",
    });
    const ready = await queries.getReport(input);
    expect(ready.state).toBe("ready");
    if (ready.state !== "ready") return;
    expect(ready.data.summary).toEqual({ installed: 2, recovered: 0 });
    const publication = (
      await collections.publications.doc(ready.data.id).get()
    ).data();
    expect(publication?.sectionManifest).toEqual([
      { sectionKey: "movementSeries:installed", total: 1 },
      { sectionKey: "movementSeries:recovered", total: 1 },
      { sectionKey: "movementCohorts:installed", total: 2 },
      { sectionKey: "movementCohorts:recovered", total: 0 },
    ]);
    const counts = (await collections.reportCounts.get()).docs.filter(
      (document) => document.data().publicationId === ready.data.id,
    );
    expect(counts).toHaveLength(4);

    const series = await queries.pageReport({
      publicationId: ready.data.id,
      section: "movementSeries",
      metric: "installed",
      limit: 10,
    });
    expect(series.state).toBe("ready");
    if (series.state === "ready") {
      expect(series.data.data).toEqual([{ bucketStartMs, value: 2 }]);
      expect(series.data.total).toMatchObject({ state: "exact", value: 1 });
    }
    const recoveredSeries = await queries.pageReport({
      publicationId: ready.data.id,
      section: "movementSeries",
      metric: "recovered",
      limit: 10,
    });
    expect(recoveredSeries.state).toBe("ready");
    if (recoveredSeries.state === "ready") {
      expect(recoveredSeries.data.data).toEqual([{ bucketStartMs, value: 0 }]);
    }
    const installedRow = (
      await collections.reportRows
        .where("publicationId", "==", ready.data.id)
        .where("sectionKey", "==", "movementSeries:installed")
        .limit(1)
        .get()
    ).docs[0]!;
    const installedRowData = installedRow.data();
    await installedRow.ref.delete();
    await expect(
      queries.pageReport({
        publicationId: ready.data.id,
        section: "movementSeries",
        metric: "installed",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    await installedRow.ref.set(installedRowData);
    const installedCount = counts.find(
      (document) => document.data().sectionKey === "movementSeries:installed",
    )!;
    await installedCount.ref.delete();
    await expect(
      queries.pageReport({
        publicationId: ready.data.id,
        section: "movementSeries",
        metric: "installed",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
  });

  it("binds filtered active-bundle counts and rows to the full bundle ID", async () => {
    const bundleId = "active-bundle";
    await publishLatest([
      {
        ...createBundleEventRowFixture("975001", Date.now() - 1_000),
        to_bundle_id: bundleId,
      },
    ]);
    const report = await queries.getReport({
      query: { kind: "activeOverview", window: "24h" },
    });
    expect(report.state).toBe("preparing");
    if (report.state !== "preparing") return;
    await expect(runJob(report.job.id)).resolves.toMatchObject({
      state: "ready",
    });
    const ready = await queries.getReport({
      query: { kind: "activeOverview", window: "24h" },
    });
    expect(ready.state).toBe("ready");
    if (ready.state !== "ready") return;
    const input = {
      publicationId: ready.data.id,
      section: "activeBundleSeries",
      bundleId,
      limit: 10,
    } as const;
    await expect(queries.pageReport(input)).resolves.toMatchObject({
      state: "ready",
    });
    const count = (
      await collections.reportCounts
        .where("publicationId", "==", ready.data.id)
        .where("bundleId", "==", bundleId)
        .limit(1)
        .get()
    ).docs[0]!;
    expect(count.data()).toMatchObject({ bundleId });
    const countData = count.data();
    await count.ref.update({ bundleId: "other-bundle" });
    await expect(queries.pageReport(input)).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    await count.ref.set(countData);

    const row = (
      await collections.reportRows
        .where("publicationId", "==", ready.data.id)
        .where("bundleKey", "==", countData.bundleKey)
        .orderBy("bundleOrdinal", "asc")
        .limit(1)
        .get()
    ).docs[0]!;
    const rowData = row.data();
    await row.ref.update({ "row.bundleId": "other-bundle" });
    await expect(queries.pageReport(input)).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    await row.ref.set(rowData);
  });

  it("fails a reserved job durably when its captured source prefix has a gap", async () => {
    const row = createBundleEventRowFixture("980001", 100);
    await publishLatest([row]);
    const input = {
      kind: "contains",
      query: row.install_id,
      limit: 10,
    } as const;
    const preparing = await queries.pageInstallations(input);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    await collections.events.doc(firebaseEventDocumentId(row.id)).delete();
    const failed = await runJob(preparing.job.id);
    expect(failed.state).toBe("failed");
    expect(
      (await collections.jobs.doc(preparing.job.id).get()).data(),
    ).toMatchObject({
      state: "failed",
      failureCode: "storage-corruption",
    });
    await expect(queries.pageInstallations(input)).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
  });

  it("returns typed storage corruption when reservation loses a source clock", async () => {
    await publishLatest([]);
    await collections.sourceClocks.doc("live_00").delete();
    await expect(
      queries.pageInstallations({ kind: "contains", query: "value", limit: 1 }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
  });
});
