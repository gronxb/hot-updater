import type {
  BundleEventRow,
  InsightsPageEventsInput,
} from "@hot-updater/plugin-core";
import {
  DocumentReference,
  Firestore,
  Query,
  Transaction,
} from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import {
  FIREBASE_INSIGHTS_INDEX_REVISION,
  FIREBASE_INSIGHTS_LAYOUT_VERSION,
  firebaseEventDocumentId,
  firebaseEventPageShard,
  firebaseEventScopeKey,
  firebaseEventSourceShard,
  firebaseInstallationKey,
} from "./firebaseEventIndex";
import {
  createFirebaseInsightsCollections,
  createFirebaseInsightsQueries,
} from "./firebaseInsights";
import {
  appendFirebaseInsightsEvent,
  firebaseInsightsSourceClockId,
  prepareFirebaseInsightsStep,
  projectFirebaseInsightsStep,
  publishFirebaseInsightsProjection,
  repairFirebaseInsightsPoisonStep,
} from "./firebaseInsightsMaintenance";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("Firebase integration tests require the Firestore emulator.");
}

const { firestore, bundleEventsCollection, clearCollections } =
  createFirestoreMock("firebase-insights-maintenance");
const collections = createFirebaseInsightsCollections(firestore);

const initializeEmptyInsights = async () => {
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
};

const recoveredEvent = (
  suffix: string,
  receivedAtMs: number,
  fromBundleId: string,
): BundleEventRow => {
  const row = createBundleEventRowFixture(suffix, receivedAtMs);
  if (row.type === "UNCHANGED") throw new Error("invalid fixture");
  return { ...row, type: "RECOVERED", from_bundle_id: fromBundleId };
};

describe("Firestore v2 Insights maintenance", () => {
  beforeEach(clearCollections);

  it("atomically appends source and latest without invalidating readiness", async () => {
    await initializeEmptyInsights();
    const event = createBundleEventRowFixture("910001", 100);
    await collections.control.doc("projection").set({
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      state: "ready",
      generation: "old",
      observedAtMs: 1,
    });
    const reads = vi.spyOn(Transaction.prototype, "getAll");
    const creates = vi.spyOn(Transaction.prototype, "create");
    const sets = vi.spyOn(Transaction.prototype, "set");
    try {
      await appendFirebaseInsightsEvent(firestore, collections, event);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(reads.mock.calls[0]).toHaveLength(3);
      expect(creates).toHaveBeenCalledTimes(2);
      expect(sets).toHaveBeenCalledTimes(3);
    } finally {
      reads.mockRestore();
      creates.mockRestore();
      sets.mockRestore();
    }
    const shard = firebaseEventSourceShard(event.id);
    const stored = await collections.events
      .doc(firebaseEventDocumentId(event.id))
      .get();
    expect(stored.data()).toMatchObject({
      id: event.id,
      _insights_source_shard: shard,
      _insights_source_seq: 1,
    });
    expect(
      (
        await collections.sourceClocks
          .doc(firebaseInsightsSourceClockId(shard))
          .get()
      ).data(),
    ).toMatchObject({ sequence: 1, shard });
    expect(
      (await collections.control.doc("projection").get()).data(),
    ).toMatchObject({ state: "ready", generation: "old" });
    expect(
      (
        await collections.installations
          .doc(firebaseInstallationKey(event.install_id))
          .get()
      ).data(),
    ).toMatchObject({ id: event.id });
    await expect(
      appendFirebaseInsightsEvent(firestore, collections, event),
    ).rejects.toThrow();
    expect(
      (
        await collections.sourceClocks
          .doc(firebaseInsightsSourceClockId(shard))
          .get()
      ).data()?.sequence,
    ).toBe(1);

    await collections.control.doc("layout").set({
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      state: "ready",
      indexRevision: FIREBASE_INSIGHTS_INDEX_REVISION,
    });
    const queries = createFirebaseInsightsQueries(
      collections,
      "firebase-insights-maintenance/(default)",
      (row) => appendFirebaseInsightsEvent(firestore, collections, row),
    );
    const page = await queries.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 101,
      limit: 1,
    });
    expect(page.state).toBe("ready");
    if (page.state === "ready") {
      expect(page.data.data.map(({ id }) => id)).toEqual([event.id]);
    }
  });

  it("fails closed on a missing or overflowing source clock", async () => {
    await initializeEmptyInsights();
    const event = createBundleEventRowFixture("910100", 100);
    const shard = firebaseEventSourceShard(event.id);
    const clock = collections.sourceClocks.doc(
      firebaseInsightsSourceClockId(shard),
    );
    await clock.delete();
    await expect(
      appendFirebaseInsightsEvent(firestore, collections, event),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await clock.set({
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      shard,
      sequence: Number.MAX_SAFE_INTEGER,
      observedAtMs: 1,
    });
    await expect(
      appendFirebaseInsightsEvent(firestore, collections, event),
    ).rejects.toMatchObject({ code: "invalid-result" });
    expect(
      (await collections.events.doc(firebaseEventDocumentId(event.id)).get())
        .exists,
    ).toBe(false);
  });

  it.each([
    {
      name: "installation",
      field: "_insights_install_key",
      selector: { kind: "installationId", installId: "collision-install" },
      event: {
        ...createBundleEventRowFixture("910201", 100),
        install_id: "stored-install",
      },
      identity: "collision-install",
    },
    {
      name: "to bundle",
      field: "_insights_to_bundle_key",
      selector: { kind: "bundleId", bundleId: "collision-to-bundle" },
      event: {
        ...createBundleEventRowFixture("910202", 100),
        to_bundle_id: "stored-to-bundle",
      },
      identity: "collision-to-bundle",
    },
    {
      name: "from bundle",
      field: "_insights_from_bundle_key",
      selector: { kind: "bundleId", bundleId: "collision-from-bundle" },
      event: recoveredEvent("910203", 100, "stored-from-bundle"),
      identity: "collision-from-bundle",
    },
  ] satisfies readonly {
    name: string;
    field: string;
    selector: InsightsPageEventsInput["selector"];
    event: BundleEventRow;
    identity: string;
  }[])(
    "returns typed corruption for a $name digest/full-identity mismatch",
    async ({ field, selector, event, identity }) => {
      await initializeEmptyInsights();
      await appendFirebaseInsightsEvent(firestore, collections, event);
      await collections.events
        .doc(firebaseEventDocumentId(event.id))
        .update({ [field]: firebaseEventScopeKey(identity) });
      const queries = createFirebaseInsightsQueries(
        collections,
        "firebase-insights-maintenance/(default)",
        (row) => appendFirebaseInsightsEvent(firestore, collections, row),
      );

      await expect(
        queries.pageEvents({
          selector,
          beforeReceivedAtMs: 101,
          limit: 1,
        }),
      ).resolves.toMatchObject({
        state: "failed",
        error: { code: "storage-corruption" },
      });
    },
  );

  it.each([
    { name: "a fresh database", initialize: false, code: "storage-not-ready" },
    { name: "a missing clock", initialize: true, code: "storage-corruption" },
  ] as const)(
    "fails live reads before data I/O for $name",
    async ({ initialize, code }) => {
      if (initialize) {
        await initializeEmptyInsights();
        await collections.sourceClocks.doc("live_00").delete();
      }
      const documentReads = vi.spyOn(DocumentReference.prototype, "get");
      const queryReads = vi.spyOn(Query.prototype, "get");
      const queries = createFirebaseInsightsQueries(
        collections,
        "firebase-insights-maintenance/(default)",
        (row) => appendFirebaseInsightsEvent(firestore, collections, row),
      );
      try {
        await expect(
          queries.pageEvents({
            selector: { kind: "all" },
            beforeReceivedAtMs: 1,
            limit: 1,
          }),
        ).resolves.toMatchObject({ state: "failed", error: { code } });
        await expect(
          queries.pageInstallations({
            kind: "installationId",
            installId: "absent-installation",
            limit: 1,
          }),
        ).resolves.toMatchObject({ state: "failed", error: { code } });
        expect(documentReads).not.toHaveBeenCalled();
        expect(queryReads).not.toHaveBeenCalled();
      } finally {
        documentReads.mockRestore();
        queryReads.mockRestore();
      }
    },
  );

  it("revalidates all ready-state clocks on reopen", async () => {
    await initializeEmptyInsights();
    await collections.sourceClocks.doc("live_00").delete();

    await expect(
      prepareFirebaseInsightsStep(
        firestore,
        bundleEventsCollection,
        collections,
        {
          writersDrained: true,
          indexesReady: true,
          maxItems: 1,
          maxRequests: 4,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("continues event pages by emitted keys while source generation advances", async () => {
    await initializeEmptyInsights();
    await collections.control.doc("layout").set({
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      state: "ready",
      indexRevision: FIREBASE_INSIGHTS_INDEX_REVISION,
    });
    const rows: BundleEventRow[] = [];
    for (let suffix = 911_000; rows.length < 4; suffix += 1) {
      const candidate = createBundleEventRowFixture(String(suffix), 0);
      if (
        rows.length === 0 ||
        firebaseEventPageShard(candidate.id) ===
          firebaseEventPageShard(rows[0]!.id)
      ) {
        rows.push(candidate);
      }
    }
    const initialHead = { ...rows[0]!, received_at_ms: 400 };
    const initialTail = { ...rows[1]!, received_at_ms: 100 };
    const lateBeforeKey = { ...rows[2]!, received_at_ms: 500 };
    const lateAfterKey = { ...rows[3]!, received_at_ms: 300 };
    const queries = createFirebaseInsightsQueries(
      collections,
      "firebase-insights-maintenance/(default)",
      (row) => appendFirebaseInsightsEvent(firestore, collections, row),
    );
    await queries.append(initialHead);
    await queries.append(initialTail);
    const input = {
      selector: { kind: "all" },
      beforeReceivedAtMs: 1_000,
      limit: 1,
    } as const;
    const first = await queries.pageEvents(input);
    expect(first.state).toBe("ready");
    if (first.state !== "ready") throw new Error(first.state);
    expect(first.data.data.map(({ id }) => id)).toEqual([initialHead.id]);

    await queries.append(lateBeforeKey);
    await queries.append(lateAfterKey);
    const seen = [initialHead.id];
    let cursor = first.data.nextCursor;
    let latestSourceGeneration = first.versions.sourceGeneration;
    while (cursor !== null) {
      const page = await queries.pageEvents({ ...input, cursor });
      expect(page.state).toBe("ready");
      if (page.state !== "ready") throw new Error(page.state);
      for (const event of page.data.data) {
        expect(seen).not.toContain(event.id);
        expect(event.received_at_ms).toBeLessThan(input.beforeReceivedAtMs);
        seen.push(event.id);
      }
      latestSourceGeneration = page.versions.sourceGeneration;
      cursor = page.data.nextCursor;
    }
    expect(latestSourceGeneration).not.toBe(first.versions.sourceGeneration);
    expect(seen).toEqual([initialHead.id, lateAfterKey.id, initialTail.id]);
    expect(seen).not.toContain(lateBeforeKey.id);
  });

  it("rejects an exact-installation cursor before Firestore I/O", async () => {
    await initializeEmptyInsights();
    const namespace = "firebase-insights-maintenance/(default)";
    const installId = "exact-installation";
    const scopeKey = firebaseEventScopeKey(
      JSON.stringify(["installationId", installId]),
    );
    const upperSequences = Array.from({ length: 65 }, () => 0);
    const vector = [
      ...Array.from(
        { length: 64 },
        (_, shard) =>
          [`live_${shard.toString(16).padStart(2, "0")}`, 0] as const,
      ),
      ["legacy", 0] as const,
    ];
    const cursor = JSON.stringify([
      FIREBASE_INSIGHTS_LAYOUT_VERSION,
      namespace,
      "installations-live",
      scopeKey,
      firebaseEventScopeKey(JSON.stringify(vector)),
      0,
      upperSequences,
      "0".repeat(64),
    ]);
    const documentReads = vi.spyOn(DocumentReference.prototype, "get");
    const batchReads = vi.spyOn(Firestore.prototype, "getAll");
    const queryReads = vi.spyOn(Query.prototype, "get");
    const queries = createFirebaseInsightsQueries(
      collections,
      namespace,
      (row) => appendFirebaseInsightsEvent(firestore, collections, row),
    );
    try {
      await expect(
        queries.pageInstallations({
          kind: "installationId",
          installId,
          limit: 1,
          cursor,
        } as unknown as Parameters<typeof queries.pageInstallations>[0]),
      ).rejects.toMatchObject({ code: "invalid-query" });
      expect(documentReads).not.toHaveBeenCalled();
      expect(batchReads).not.toHaveBeenCalled();
      expect(queryReads).not.toHaveBeenCalled();
    } finally {
      documentReads.mockRestore();
      batchReads.mockRestore();
      queryReads.mockRestore();
    }
  });

  it("keeps a live-all cutoff stable while appends continue", async () => {
    await initializeEmptyInsights();
    const namespace = "firebase-insights-maintenance/(default)";
    const queries = createFirebaseInsightsQueries(
      collections,
      namespace,
      (row) => appendFirebaseInsightsEvent(firestore, collections, row),
    );
    const initial = Array.from({ length: 8 }, (_, index) => ({
      ...createBundleEventRowFixture(String(920_000 + index), 1_000 + index),
      install_id: `snapshot-installation-${index}`,
      received_at_ms: 1_000 + index,
    }));
    for (const row of initial) await queries.append(row);
    const first = await queries.pageInstallations({ kind: "all", limit: 1 });
    expect(first.state).toBe("ready");
    if (first.state !== "ready") return;

    const updated = {
      ...initial[7]!,
      id: createBundleEventRowFixture("920100", 2_000).id,
      received_at_ms: 2_000,
    };
    const created = {
      ...createBundleEventRowFixture("920101", 2_001),
      install_id: "snapshot-installation-new",
      received_at_ms: 2_001,
    };
    await queries.append(updated);
    await queries.append(created);

    const seen = [...first.data.data];
    let cursor = first.data.nextCursor;
    while (cursor !== null) {
      const page = await queries.pageInstallations({
        kind: "all",
        limit: 1,
        cursor,
      });
      expect(page.state).toBe("ready");
      if (page.state !== "ready") return;
      seen.push(...page.data.data);
      cursor = page.data.nextCursor;
    }
    expect(seen.map(({ install_id }) => install_id)).toEqual(
      [...initial]
        .sort((left, right) =>
          firebaseInstallationKey(left.install_id).localeCompare(
            firebaseInstallationKey(right.install_id),
          ),
        )
        .map(({ install_id }) => install_id),
    );
    expect(new Set(seen.map(({ install_id }) => install_id)).size).toBe(8);
    expect(
      seen.find(({ install_id }) => install_id === updated.install_id)?.id,
    ).toBe(initial[7]!.id);
  });

  it("captures a drained legacy prefix and advances event copies with its checkpoint", async () => {
    const events = [
      createBundleEventRowFixture("920001", 10),
      createBundleEventRowFixture("920002", 20),
    ];
    for (const event of events) {
      await bundleEventsCollection.doc(event.id).set(event);
    }
    const step = (maxItems: number) =>
      prepareFirebaseInsightsStep(
        firestore,
        bundleEventsCollection,
        collections,
        {
          writersDrained: true,
          indexesReady: true,
          maxItems,
          maxRequests: 4,
        },
      );
    await expect(step(1)).resolves.toEqual({
      state: "building",
      processed: 0,
    });
    const live = createBundleEventRowFixture("925000", 30);
    await appendFirebaseInsightsEvent(firestore, collections, live);
    await expect(step(1)).resolves.toEqual({
      state: "building",
      processed: 1,
    });
    await expect(step(1)).resolves.toEqual({
      state: "ready",
      processed: 1,
    });
    const copied = await Promise.all(
      events.map((event) =>
        collections.events.doc(firebaseEventDocumentId(event.id)).get(),
      ),
    );
    expect(
      copied.map((document) => document.data()?._insights_source_seq),
    ).toEqual([1, 2]);
    expect(
      copied.map((document) => document.data()?._insights_source_shard),
    ).toEqual(["legacy", "legacy"]);
    expect(
      (await collections.control.doc("layout").get()).data(),
    ).toMatchObject({ state: "ready", afterId: events[1]!.id });
    expect(
      (await collections.events.doc(firebaseEventDocumentId(live.id)).get())
        .exists,
    ).toBe(true);
  });

  it("revalidates repaired poison and resumes from the preserved checkpoint", async () => {
    const prior = createBundleEventRowFixture("930000", 5);
    const event = createBundleEventRowFixture("930001", 10);
    await bundleEventsCollection.doc(prior.id).set(prior);
    await bundleEventsCollection.doc(event.id).set({
      ...event,
      extension: "x".repeat(21 * 1024),
    });
    const input = {
      writersDrained: true,
      indexesReady: true,
      maxItems: 1,
      maxRequests: 4,
    } as const;
    await prepareFirebaseInsightsStep(
      firestore,
      bundleEventsCollection,
      collections,
      input,
    );
    await prepareFirebaseInsightsStep(
      firestore,
      bundleEventsCollection,
      collections,
      input,
    );
    const failed = await prepareFirebaseInsightsStep(
      firestore,
      bundleEventsCollection,
      collections,
      input,
    );
    expect(failed.state).toBe("failed");
    expect(
      (await collections.control.doc("layout").get()).data(),
    ).toMatchObject({ state: "failed", afterId: prior.id });
    expect((await collections.poison.get()).size).toBe(1);
    await bundleEventsCollection.doc(event.id).set(event);
    await expect(
      repairFirebaseInsightsPoisonStep(
        firestore,
        bundleEventsCollection,
        collections,
        { maxItems: 1, maxRequests: 4 },
      ),
    ).resolves.toEqual({
      state: "building",
      repairedDocumentId: event.id,
    });
    expect(
      (await collections.control.doc("layout").get()).data(),
    ).toMatchObject({ state: "building", afterId: prior.id });
    await expect(
      prepareFirebaseInsightsStep(
        firestore,
        bundleEventsCollection,
        collections,
        input,
      ),
    ).resolves.toEqual({ state: "ready", processed: 1 });
    expect((await collections.poison.get()).empty).toBe(true);
    expect((await collections.events.get()).size).toBe(2);
  });

  it("enumerates arbitrary legacy document keys and persists invalid event IDs as poison", async () => {
    const event = createBundleEventRowFixture("935001", 10);
    const legacyDocumentId = "arbitrary-legacy-document-key";
    await bundleEventsCollection.doc(legacyDocumentId).set({
      ...event,
      id: "not-a-uuid",
    });
    const input = {
      writersDrained: true,
      indexesReady: true,
      maxItems: 10,
      maxRequests: 4,
    } as const;

    await expect(
      prepareFirebaseInsightsStep(
        firestore,
        bundleEventsCollection,
        collections,
        input,
      ),
    ).resolves.toEqual({ state: "building", processed: 0 });
    const failed = await prepareFirebaseInsightsStep(
      firestore,
      bundleEventsCollection,
      collections,
      input,
    );

    expect(failed.state).toBe("failed");
    expect(
      (await collections.control.doc("layout").get()).data(),
    ).toMatchObject({ state: "failed" });
    expect((await collections.poison.get()).docs[0]?.data()).toMatchObject({
      documentId: legacyDocumentId,
      source: "legacy",
    });
    expect((await collections.events.get()).empty).toBe(true);
  });

  it("projects latest rows, then publishes only caught-up clocks", async () => {
    await initializeEmptyInsights();
    await collections.control.doc("layout").set({
      version: FIREBASE_INSIGHTS_LAYOUT_VERSION,
      state: "ready",
      indexRevision: FIREBASE_INSIGHTS_INDEX_REVISION,
    });
    const first = {
      ...createBundleEventRowFixture("940001", 100),
      install_id: "same-installation",
      user_id: "historical-user",
      username: "Old Name",
    };
    const latest = {
      ...createBundleEventRowFixture("940002", 200),
      install_id: "same-installation",
      user_id: "current-user",
      username: "New Name",
    };
    await appendFirebaseInsightsEvent(firestore, collections, first);
    await appendFirebaseInsightsEvent(firestore, collections, latest);
    await expect(
      publishFirebaseInsightsProjection(firestore, collections, 300),
    ).resolves.toEqual({ published: false });

    for (const shard of new Set([
      firebaseEventSourceShard(first.id),
      firebaseEventSourceShard(latest.id),
    ])) {
      let result;
      do {
        result = await projectFirebaseInsightsStep(firestore, collections, {
          sourceShard: shard,
          maxItems: 1,
          maxRequests: 4,
        });
      } while (result.state !== "caught-up");
    }
    const publication = await publishFirebaseInsightsProjection(
      firestore,
      collections,
      300,
    );
    expect(publication.published).toBe(true);
    expect(
      (
        await collections.installations
          .doc(firebaseInstallationKey(first.install_id))
          .get()
      ).data()?.id,
    ).toBe(latest.id);
    const queries = createFirebaseInsightsQueries(
      collections,
      "firebase-insights-maintenance/(default)",
      (row) => appendFirebaseInsightsEvent(firestore, collections, row),
    );
    const page = await queries.pageInstallations({
      kind: "installationId",
      installId: first.install_id,
      limit: 1,
    });
    expect(page.state).toBe("ready");
    if (page.state === "ready") {
      expect(page.data.data.map(({ id }) => id)).toEqual([latest.id]);
      expect(page.data.consistency.cutoff).toMatchObject({
        kind: "projection",
      });
      expect(page.data.consistency.cutoff.observedAtMs).toBeGreaterThanOrEqual(
        300,
      );
    }
  });
});
