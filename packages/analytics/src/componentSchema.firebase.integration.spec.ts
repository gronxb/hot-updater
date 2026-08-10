import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFirebaseUniversalComponentDataAdapter } from "../../../plugins/firebase/src/firebaseUniversalComponentData";
import { createFirestoreMock } from "../../../plugins/firebase/test-utils/createFirestoreMock";
import { analyticsComponentSchema } from "./componentSchema";

const PROJECT_ID = "firebase-analytics-component-schema-test";
const SETTINGS_COLLECTION = "private_hot_updater_settings";

const { firestore } = createFirestoreMock(PROJECT_ID);
const bundleEventsCollection = firestore.collection("bundle_events");
const settingsCollection = firestore.collection(SETTINGS_COLLECTION);

const commonRow = (id: string, receivedAtMs: number) => ({
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprint_hash: null,
  id,
  install_id: `install-${id}`,
  platform: "ios",
  received_at_ms: receivedAtMs,
  sdk_version: "1.2.3",
  to_bundle_id: `bundle-${id}`,
  user_id: null,
  username: null,
});

const v1Row = (id: string, receivedAtMs = 1_000) => ({
  ...commonRow(id, receivedAtMs),
  from_bundle_id: `previous-${id}`,
  type: "UPDATE_APPLIED",
  update_strategy: "fingerprint",
});

const v2Row = (id: string, receivedAtMs = 2_000) => ({
  ...commonRow(id, receivedAtMs),
  from_bundle_id: null,
  type: "UNCHANGED",
  update_strategy: null,
});

type AnalyticsRow = ReturnType<typeof v1Row> | ReturnType<typeof v2Row>;

const clearCollection = async (
  collection: ReturnType<typeof firestore.collection>,
): Promise<void> => {
  while (true) {
    const snapshot = await collection.limit(500).get();
    if (snapshot.empty) return;
    const batch = firestore.batch();
    for (const document of snapshot.docs) batch.delete(document.ref);
    await batch.commit();
  }
};

const clearState = async (): Promise<void> => {
  await clearCollection(bundleEventsCollection);
  await clearCollection(settingsCollection);
};

const seedRows = async (rows: readonly AnalyticsRow[]): Promise<void> => {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = firestore.batch();
    for (const row of rows.slice(offset, offset + 500)) {
      batch.set(bundleEventsCollection.doc(row.id), row);
    }
    await batch.commit();
  }
};

const validateIndexesOnEmulator = async (): Promise<void> => {
  await bundleEventsCollection
    .orderBy("received_at_ms", "asc")
    .orderBy("id", "asc")
    .limit(1)
    .get();
};

describe("Analytics schema on the generic Firebase component adapter", () => {
  beforeEach(clearState);
  afterEach(() => vi.restoreAllMocks());

  it("generates the latest Analytics ordered-scan index artifact", () => {
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore);

    expect(adapter.artifacts?.(analyticsComponentSchema)).toEqual([
      {
        contents: `${JSON.stringify(
          {
            fieldOverrides: [],
            indexes: [
              {
                collectionGroup: "bundle_events",
                fields: [
                  { fieldPath: "received_at_ms", order: "ASCENDING" },
                  { fieldPath: "id", order: "ASCENDING" },
                ],
                queryScope: "COLLECTION",
              },
            ],
          },
          null,
          2,
        )}\n`,
        path: "firestore.indexes.analytics.2.json",
        targetVersion: "2",
      },
    ]);
  });

  it("classifies an exact unmarked v1 store as a v1-to-v2 migration", async () => {
    const row = v1Row("event-unmarked-v1");
    await settingsCollection.doc("version").set({ value: "0.37.0" });
    await seedRows([row]);
    const compatibleVersions: string[][] = [];
    const validatedVersions: string[] = [];
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore, {
      selectPhysicalVersion: (versions) => {
        compatibleVersions.push([...versions]);
        return "1";
      },
      validateIndexes: async (_schema, version) => {
        validatedVersions.push(version);
        await validateIndexesOnEmulator();
      },
    });

    await expect(adapter.migrate?.(analyticsComponentSchema)).resolves.toEqual({
      changed: true,
      version: "2",
    });

    expect(compatibleVersions).toEqual([["2", "1"]]);
    expect(validatedVersions).toEqual(["1", "2"]);
    expect((await bundleEventsCollection.doc(row.id).get()).data()).toEqual(
      row,
    );
    expect(
      (await settingsCollection.doc("schema.analytics").get()).data(),
    ).toEqual({ value: "2" });
  });

  it("classifies an unmarked v2 store as adoption without rewriting rows", async () => {
    const row = v2Row("event-unmarked-v2");
    await settingsCollection.doc("version").set({ value: "0.38.0" });
    await seedRows([row]);
    const compatibleVersions: string[][] = [];
    const validatedVersions: string[] = [];
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore, {
      selectPhysicalVersion: (versions) => {
        compatibleVersions.push([...versions]);
        return versions[0] ?? null;
      },
      validateIndexes: async (_schema, version) => {
        validatedVersions.push(version);
        await validateIndexesOnEmulator();
      },
    });

    await expect(adapter.migrate?.(analyticsComponentSchema)).resolves.toEqual({
      changed: true,
      version: "2",
    });

    expect(compatibleVersions).toEqual([["2"]]);
    expect(validatedVersions).toEqual(["2"]);
    expect((await bundleEventsCollection.doc(row.id).get()).data()).toEqual(
      row,
    );
  });

  it("recovers a latest-shape store whose marker remained at version 1", async () => {
    const row = v2Row("event-marker-v1-latest");
    await settingsCollection.doc("version").set({ value: "0.37.0" });
    await settingsCollection.doc("schema.analytics").set({ value: "1" });
    await seedRows([row]);
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore);

    await expect(adapter.migrate?.(analyticsComponentSchema)).resolves.toEqual({
      changed: true,
      version: "2",
    });

    expect((await bundleEventsCollection.doc(row.id).get()).data()).toEqual(
      row,
    );
    expect(
      (await settingsCollection.doc("schema.analytics").get()).data(),
    ).toEqual({ value: "2" });
  });

  it("finds a corrupt Analytics row beyond the first 500 validation documents", async () => {
    const validRows = Array.from({ length: 500 }, (_, index) =>
      v2Row(`event-${String(index).padStart(4, "0")}`, index),
    );
    const corruptRow = {
      ...v2Row("event-zzzz-corrupt", 501),
      platform: "web",
    };
    await settingsCollection.doc("version").set({ value: "0.38.0" });
    await seedRows([...validRows, corruptRow]);
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore);

    await expect(adapter.migrate?.(analyticsComponentSchema)).rejects.toThrow(
      "Stored Firebase component data has schema drift",
    );

    expect(
      (await settingsCollection.doc("schema.analytics").get()).exists,
    ).toBe(false);
    expect((await bundleEventsCollection.count().get()).data().count).toBe(501);
  });

  it("keeps the marker absent on commit failure and converges idempotently", async () => {
    const row = v2Row("event-marker-retry");
    await seedRows([row]);
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore);
    const failedMarkerBatch = firestore.batch();
    const markerFailure = new Error("test marker commit failure");
    vi.spyOn(failedMarkerBatch, "commit").mockRejectedValueOnce(markerFailure);
    const batchFactory = vi
      .spyOn(firestore, "batch")
      .mockReturnValueOnce(failedMarkerBatch);

    await expect(adapter.migrate?.(analyticsComponentSchema)).rejects.toBe(
      markerFailure,
    );
    batchFactory.mockRestore();
    expect(
      (await settingsCollection.doc("schema.analytics").get()).exists,
    ).toBe(false);
    expect((await bundleEventsCollection.doc(row.id).get()).data()).toEqual(
      row,
    );

    await expect(adapter.migrate?.(analyticsComponentSchema)).resolves.toEqual({
      changed: true,
      version: "2",
    });
    await expect(adapter.migrate?.(analyticsComponentSchema)).resolves.toEqual({
      changed: false,
      version: "2",
    });
  });

  it("executes the declared ordered scan with cutoff, cursor, and limit", async () => {
    const adapter = createFirebaseUniversalComponentDataAdapter(firestore);
    await adapter.migrate?.(analyticsComponentSchema);
    const source = adapter.bind(analyticsComponentSchema);
    const rows = [
      v2Row("event-a", 100),
      v2Row("event-b", 100),
      v2Row("event-c", 200),
      v2Row("event-d", 300),
    ];
    for (const row of rows) {
      await source.append({ row, table: "bundle_events" });
    }

    await expect(
      source.orderedScan({
        accessPattern: "bundle_events_by_received_at",
        afterExclusive: [100, "event-a"],
        beforePrefixExclusive: [300],
        limit: 2,
      }),
    ).resolves.toEqual([rows[1], rows[2]]);
  });
});
