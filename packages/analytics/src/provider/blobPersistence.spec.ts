import { describe, expect, it } from "vitest";

import {
  ANALYTICS_BLOB_DATA_PREFIX,
  ANALYTICS_BLOB_KEY,
  AnalyticsBlobFormatError,
  AnalyticsBlobWriteConflictError,
  createBlobAnalyticsPersistence,
  parseAnalyticsBlob,
  stageAnalyticsBlobData,
  type AnalyticsBlobOperations,
} from "./blobPersistence";
import { AnalyticsSchemaNotReadyError } from "./migration";
import type { BundleEventPersistenceRow } from "./persistence";

const event = (
  id: string,
  receivedAtMs: number,
): BundleEventPersistenceRow => ({
  id,
  type: "UNCHANGED",
  install_id: `install-${id}`,
  user_id: null,
  username: null,
  from_bundle_id: null,
  to_bundle_id: "bundle-1",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: null,
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const createStore = () => {
  const objects = new Map<string, unknown>();
  let manifestConflicts = 0;
  let concurrentManifest: unknown | null = null;
  const operations: AnalyticsBlobOperations = {
    loadObject: async (key) => objects.get(key) ?? null,
    compareAndSwapObject: async (key, expected, value) => {
      if (key === ANALYTICS_BLOB_KEY && manifestConflicts > 0) {
        manifestConflicts -= 1;
        if (concurrentManifest !== null) {
          objects.set(key, concurrentManifest);
          concurrentManifest = null;
        }
        return false;
      }
      const current = objects.get(key) ?? null;
      if (!same(current, expected)) return false;
      objects.set(key, value);
      return true;
    },
  };
  return {
    objects,
    operations,
    replaceManifestOnNextConflict(value: unknown) {
      manifestConflicts = 1;
      concurrentManifest = value;
    },
  };
};

const activate = async (
  operations: AnalyticsBlobOperations,
  rows: readonly BundleEventPersistenceRow[],
): Promise<void> => {
  const dataKey = await stageAnalyticsBlobData(operations, rows);
  const written = await operations.compareAndSwapObject(
    ANALYTICS_BLOB_KEY,
    null,
    { dataKey, schema: 2 },
  );
  expect(written).toBe(true);
};

describe("createBlobAnalyticsPersistence", () => {
  it("appends without replacing an existing event", async () => {
    const store = createStore();
    await activate(store.operations, [event("a", 1)]);
    const persistence = createBlobAnalyticsPersistence(store.operations);

    await persistence.append(event("b", 2));

    await expect(
      persistence.scan({ beforeReceivedAtMs: 3, limit: 10 }),
    ).resolves.toEqual([event("a", 1), event("b", 2)]);
  });

  it("merges a concurrent append after a manifest conflict", async () => {
    const store = createStore();
    await activate(store.operations, [event("a", 1)]);
    const concurrentDataKey = await stageAnalyticsBlobData(store.operations, [
      event("a", 1),
      event("c", 2),
    ]);
    store.replaceManifestOnNextConflict({
      dataKey: concurrentDataKey,
      schema: 2,
    });
    const persistence = createBlobAnalyticsPersistence(store.operations);

    await persistence.append(event("b", 2));

    await expect(
      persistence.scan({ beforeReceivedAtMs: 3, limit: 10 }),
    ).resolves.toEqual([event("a", 1), event("b", 2), event("c", 2)]);
  });

  it("uses an exclusive cursor and strict upper bound in stable order", async () => {
    const store = createStore();
    await activate(store.operations, [
      event("z", 20),
      event("b", 10),
      event("a", 10),
      event("c", 30),
    ]);
    const persistence = createBlobAnalyticsPersistence(store.operations);

    const rows = await persistence.scan({
      after: { id: "a", receivedAtMs: 10 },
      beforeReceivedAtMs: 30,
      limit: 2,
    });

    expect(rows).toEqual([event("b", 10), event("z", 20)]);
  });

  it("rejects duplicate event ids without publishing a new manifest", async () => {
    const store = createStore();
    await activate(store.operations, [event("a", 1)]);
    const before = store.objects.get(ANALYTICS_BLOB_KEY);
    const persistence = createBlobAnalyticsPersistence(store.operations);

    const result = persistence.append(event("a", 2));

    await expect(result).rejects.toBeInstanceOf(
      AnalyticsBlobWriteConflictError,
    );
    expect(store.objects.get(ANALYTICS_BLOB_KEY)).toEqual(before);
  });

  it("reports altered active data as a schema readiness failure", async () => {
    const store = createStore();
    const alteredDataKey = `${ANALYTICS_BLOB_DATA_PREFIX}${"0".repeat(64)}.json`;
    store.objects.set(ANALYTICS_BLOB_KEY, {
      dataKey: alteredDataKey,
      schema: 2,
    });
    store.objects.set(alteredDataKey, { events: [event("a", 1)] });
    const persistence = createBlobAnalyticsPersistence(store.operations);

    const result = persistence.scan({ beforeReceivedAtMs: 2, limit: 10 });

    await expect(result).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
  });

  it("reports a missing active manifest as a schema readiness failure", async () => {
    const store = createStore();
    const persistence = createBlobAnalyticsPersistence(store.operations);

    const result = persistence.scan({ beforeReceivedAtMs: 2, limit: 10 });

    await expect(result).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
  });

  it("reports a future active manifest as a schema readiness failure", async () => {
    const store = createStore();
    store.objects.set(ANALYTICS_BLOB_KEY, {
      dataKey: "future",
      schema: 3,
    });
    const persistence = createBlobAnalyticsPersistence(store.operations);

    const result = persistence.scan({ beforeReceivedAtMs: 2, limit: 10 });

    await expect(result).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
  });

  it("rejects duplicate ids in a stored data object", () => {
    const parse = () =>
      parseAnalyticsBlob({
        events: [event("duplicate", 1), event("duplicate", 2)],
      });

    expect(parse).toThrow(AnalyticsBlobFormatError);
  });

  it("rejects unknown stored data fields", () => {
    const parse = () => parseAnalyticsBlob({ events: [], future_field: true });

    expect(parse).toThrow(AnalyticsBlobFormatError);
  });
});
