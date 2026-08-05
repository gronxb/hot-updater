import {
  AnalyticsSchemaCompatibilityError,
  type BundleEventPersistenceRow,
} from "@hot-updater/analytics/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import {
  FirebaseAnalyticsSchemaStateError,
  migrateFirebaseAnalytics,
} from "./firebaseAnalyticsMigration";

const PROJECT_ID = "firebase-analytics-migration-test";

const {
  bundleEventsCollection,
  clearCollections,
  firestore,
  settingsCollection,
} = createFirestoreMock(PROJECT_ID);

const commonRow = (id: string, receivedAtMs: number) => ({
  id,
  install_id: `install-${id}`,
  user_id: null,
  username: null,
  to_bundle_id: `bundle-${id}`,
  platform: "ios" as const,
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprint_hash: null,
  sdk_version: "1.2.3",
  received_at_ms: receivedAtMs,
});

const v1Row = (id: string): BundleEventPersistenceRow => ({
  ...commonRow(id, 1_000),
  type: "UPDATE_APPLIED",
  from_bundle_id: "bundle-old",
  update_strategy: "fingerprint",
});

const v2Row = (id: string): BundleEventPersistenceRow => ({
  ...commonRow(id, 2_000),
  type: "UNCHANGED",
  from_bundle_id: null,
  update_strategy: null,
});

class MarkerCommitTestError extends Error {
  readonly name = "MarkerCommitTestError";
}

describe("Firebase Analytics schema migration", () => {
  beforeEach(clearCollections);

  it("creates schema.analytics 2 for a fresh project and reruns as ready", async () => {
    await expect(migrateFirebaseAnalytics(firestore)).resolves.toEqual({
      kind: "created-v2",
    });
    await expect(migrateFirebaseAnalytics(firestore)).resolves.toEqual({
      kind: "ready",
    });

    const marker = await settingsCollection.doc("schema.analytics").get();
    expect(marker.data()).toEqual({ value: "2" });
  });

  it("adopts valid unmarked transition rows without semver evidence", async () => {
    const row = v1Row("event-v1");
    await settingsCollection.doc("unrelated").set({ value: "preserve-me" });
    await bundleEventsCollection.doc(row.id).set(row);

    await expect(migrateFirebaseAnalytics(firestore)).resolves.toEqual({
      kind: "adopted-v2",
    });

    const [event, unrelated, component] = await Promise.all([
      bundleEventsCollection.doc(row.id).get(),
      settingsCollection.doc("unrelated").get(),
      settingsCollection.doc("schema.analytics").get(),
    ]);
    expect(event.data()).toEqual(row);
    expect(unrelated.data()).toEqual({ value: "preserve-me" });
    expect(component.data()).toEqual({ value: "2" });
  });

  it("adopts valid unmarked v2 rows without changing data", async () => {
    const row = v2Row("event-v2");
    await bundleEventsCollection.doc(row.id).set(row);

    await expect(migrateFirebaseAnalytics(firestore)).resolves.toEqual({
      kind: "adopted-v2",
    });

    const [event, component] = await Promise.all([
      bundleEventsCollection.doc(row.id).get(),
      settingsCollection.doc("schema.analytics").get(),
    ]);
    expect(event.data()).toEqual(row);
    expect(component.data()).toEqual({ value: "2" });
  });

  it("advances an explicit v1 marker after validating transition rows", async () => {
    const row = v1Row("event-marked-v1");
    await settingsCollection.doc("schema.analytics").set({ value: "1" });
    await bundleEventsCollection.doc(row.id).set(row);

    await expect(migrateFirebaseAnalytics(firestore)).resolves.toEqual({
      kind: "migrated-v1-v2",
    });
    expect(
      (await settingsCollection.doc("schema.analytics").get()).data(),
    ).toEqual({ value: "2" });
  });

  it("recovers when v2 rows exist before a v1 marker was advanced", async () => {
    const row = v2Row("event-v1-marker-v2-shape");
    await settingsCollection.doc("schema.analytics").set({ value: "1" });
    await bundleEventsCollection.doc(row.id).set(row);

    await expect(migrateFirebaseAnalytics(firestore)).resolves.toEqual({
      kind: "adopted-v2",
    });
    expect(
      (await settingsCollection.doc("schema.analytics").get()).data(),
    ).toEqual({ value: "2" });
  });

  it("keeps the marker absent for a mismatched document id", async () => {
    const row = v2Row("event-miskeyed");
    await bundleEventsCollection.doc("wrong-key").set(row);

    await expect(migrateFirebaseAnalytics(firestore)).rejects.toThrow(
      "bundle_events.id.document-key",
    );
    const marker = await settingsCollection.doc("schema.analytics").get();
    expect(marker.exists).toBe(false);
  });

  it("rejects future and malformed component markers before event validation", async () => {
    await bundleEventsCollection.doc("invalid").set({ invalid: true });
    await settingsCollection.doc("schema.analytics").set({ value: "3" });

    await expect(migrateFirebaseAnalytics(firestore)).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );

    await settingsCollection.doc("schema.analytics").set({ value: 2 });
    await expect(migrateFirebaseAnalytics(firestore)).rejects.toBeInstanceOf(
      FirebaseAnalyticsSchemaStateError,
    );
  });

  it("keeps the marker absent when document validation fails", async () => {
    const row = v2Row("event-invalid");
    await bundleEventsCollection.doc(row.id).set({ ...row, extra: true });

    await expect(migrateFirebaseAnalytics(firestore)).rejects.toMatchObject({
      name: "InvalidBundleEventPersistenceRowError",
    });
    const marker = await settingsCollection.doc("schema.analytics").get();
    expect(marker.exists).toBe(false);
  });

  it("retries safely when the final marker batch fails", async () => {
    const row = v2Row("event-retry");
    await bundleEventsCollection.doc(row.id).set(row);
    const markerBatch = firestore.batch();
    vi.spyOn(markerBatch, "commit").mockRejectedValueOnce(
      new MarkerCommitTestError(),
    );
    const batchFactory = vi
      .spyOn(firestore, "batch")
      .mockReturnValueOnce(markerBatch);

    await expect(migrateFirebaseAnalytics(firestore)).rejects.toBeInstanceOf(
      MarkerCommitTestError,
    );
    batchFactory.mockRestore();
    const [eventAfterFailure, markerAfterFailure] = await Promise.all([
      bundleEventsCollection.doc(row.id).get(),
      settingsCollection.doc("schema.analytics").get(),
    ]);
    expect(eventAfterFailure.data()).toEqual(row);
    expect(markerAfterFailure.exists).toBe(false);

    await expect(migrateFirebaseAnalytics(firestore)).resolves.toEqual({
      kind: "adopted-v2",
    });
  });
});
