import {
  AnalyticsSchemaNotReadyError,
  type BundleEventPersistenceRow,
} from "@hot-updater/analytics/provider";
import { beforeEach, describe, expect, it } from "vitest";

import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { migrateFirebaseAnalytics } from "./firebaseAnalyticsMigration";
import { createFirebaseAnalyticsPersistence } from "./firebaseAnalyticsPersistence";

const PROJECT_ID = "firebase-analytics-persistence-test";

const { bundleEventsCollection, clearCollections, settingsCollection } =
  createFirestoreMock(PROJECT_ID);

const unchangedRow = (
  id: string,
  receivedAtMs: number,
): BundleEventPersistenceRow => ({
  id,
  type: "UNCHANGED",
  install_id: `install-${id}`,
  user_id: null,
  username: null,
  from_bundle_id: null,
  to_bundle_id: `bundle-${id}`,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: null,
  fingerprint_hash: null,
  sdk_version: "1.2.3",
  received_at_ms: receivedAtMs,
});

describe("Firebase Analytics persistence", () => {
  beforeEach(clearCollections);

  const createReadyPersistence = async () => {
    await migrateFirebaseAnalytics(bundleEventsCollection.firestore);
    return createFirebaseAnalyticsPersistence(bundleEventsCollection);
  };

  it("creates each event at the document matching its id", async () => {
    const persistence = await createReadyPersistence();
    const row = unchangedRow("event-1", 1_000);

    await persistence.append(row);

    const document = await bundleEventsCollection.doc(row.id).get();
    expect(document.data()).toEqual(row);
    await expect(persistence.append(row)).rejects.toMatchObject({ code: 6 });
  });

  it("scans with a strict cutoff and exclusive ordered cursor", async () => {
    const persistence = await createReadyPersistence();
    const rows = [
      unchangedRow("event-c", 2_000),
      unchangedRow("event-b", 1_000),
      unchangedRow("event-a", 1_000),
      unchangedRow("event-d", 3_000),
    ];
    await Promise.all(rows.map((row) => persistence.append(row)));

    const firstPage = await persistence.scan({
      beforeReceivedAtMs: 3_000,
      limit: 2,
    });
    const secondPage = await persistence.scan({
      after: { id: "event-b", receivedAtMs: 1_000 },
      beforeReceivedAtMs: 3_000,
      limit: 2,
    });

    expect(firstPage.map(({ id }) => id)).toEqual(["event-a", "event-b"]);
    expect(secondPage.map(({ id }) => id)).toEqual(["event-c"]);
  });

  it("rejects malformed rows and mismatched document ids while scanning", async () => {
    const persistence = await createReadyPersistence();
    await bundleEventsCollection
      .doc("wrong-key")
      .set(unchangedRow("event-1", 1_000));

    await expect(
      persistence.scan({ beforeReceivedAtMs: 2_000, limit: 10 }),
    ).rejects.toThrow("bundle_events.id.document-key");

    await bundleEventsCollection.doc("wrong-key").delete();
    await persistence.scan({ beforeReceivedAtMs: 2_000, limit: 10 });
    await bundleEventsCollection.doc("event-2").set({
      ...unchangedRow("event-2", 1_000),
      unexpected: true,
    });

    await expect(
      persistence.scan({ beforeReceivedAtMs: 2_000, limit: 10 }),
    ).rejects.toMatchObject({
      name: "InvalidBundleEventPersistenceRowError",
    });
  });

  it("blocks before migration and retries readiness after migration", async () => {
    const persistence = createFirebaseAnalyticsPersistence(
      bundleEventsCollection,
    );
    const row = unchangedRow("event-after-migration", 1_000);

    await expect(persistence.append(row)).rejects.toBeInstanceOf(
      AnalyticsSchemaNotReadyError,
    );
    const markerBeforeMigration = await bundleEventsCollection.firestore
      .collection("private_hot_updater_settings")
      .doc("schema.analytics")
      .get();
    expect(markerBeforeMigration.exists).toBe(false);
    expect((await bundleEventsCollection.doc(row.id).get()).exists).toBe(false);

    await migrateFirebaseAnalytics(bundleEventsCollection.firestore);
    await expect(persistence.append(row)).resolves.toBeUndefined();
  });

  it("blocks a warm instance after the schema marker becomes future", async () => {
    const persistence = await createReadyPersistence();
    await persistence.append(unchangedRow("event-before-future", 1_000));
    await settingsCollection.doc("schema.analytics").set({ value: "3" });
    const row = unchangedRow("event-after-future", 2_000);

    await expect(persistence.append(row)).rejects.toBeInstanceOf(
      AnalyticsSchemaNotReadyError,
    );
    expect((await bundleEventsCollection.doc(row.id).get()).exists).toBe(false);
  });
});
