import { describe, expect, it } from "vitest";

import { migrateLegacyAnalyticsBlob } from "./blobMigration";
import {
  createCoreSnapshot,
  createEvent,
  createMigrationTestState,
  InjectedManifestFailure,
} from "./blobMigration.testFixtures";
import {
  ANALYTICS_BLOB_KEY,
  ANALYTICS_BLOB_PENDING_KEY,
  AnalyticsBlobFormatError,
  loadActiveAnalyticsBlob,
  stageAnalyticsBlobData,
} from "./blobPersistence";

describe("migrateLegacyAnalyticsBlob", () => {
  it("publishes data, archives legacy Core, and writes the ready marker last", async () => {
    const state = createMigrationTestState({
      version: 2,
      bundles: [{ id: "bundle", metadata: { retained: true } }],
      bundle_patches: [{ id: "patch", order_index: 0 }],
      bundle_events: [createEvent("legacy")],
    });
    const original = state.activeCoreHandle;

    await migrateLegacyAnalyticsBlob(state.operations);

    expect(state.calls).toEqual([
      "data",
      "pending",
      "archive",
      "core",
      "manifest",
    ]);
    expect(state.archives).toEqual([original]);
    expect(state.activeCore).toEqual({
      version: 2,
      bundles: [{ id: "bundle", metadata: { retained: true } }],
      bundle_patches: [{ id: "patch", order_index: 0 }],
    });
    await expect(
      loadActiveAnalyticsBlob(state.operations),
    ).resolves.toMatchObject({ rows: [createEvent("legacy")] });
  });

  it("converges after Core publication interrupted the final marker write", async () => {
    const state = createMigrationTestState();
    state.setManifestFailure(true);
    await expect(
      migrateLegacyAnalyticsBlob(state.operations),
    ).rejects.toBeInstanceOf(InjectedManifestFailure);
    expect(state.activeCore).toEqual(createCoreSnapshot());
    expect(state.objects.has(ANALYTICS_BLOB_KEY)).toBe(false);
    expect(state.objects.has(ANALYTICS_BLOB_PENDING_KEY)).toBe(true);

    state.setManifestFailure(false);
    await migrateLegacyAnalyticsBlob(state.operations);

    await expect(
      loadActiveAnalyticsBlob(state.operations),
    ).resolves.toMatchObject({ rows: [createEvent("legacy")] });
  });

  it("retries a Core CAS from the latest recognized Core state", async () => {
    const state = createMigrationTestState();
    state.conflictNextCoreWrites(1);

    await migrateLegacyAnalyticsBlob(state.operations);

    expect(state.activeCore).toEqual({
      version: 2,
      bundles: [{ id: "concurrent-core-row" }],
      bundle_patches: [],
    });
    await expect(
      loadActiveAnalyticsBlob(state.operations),
    ).resolves.toMatchObject({ rows: [createEvent("legacy")] });
  });

  it("merges an existing Analytics event set before cleaning Core", async () => {
    const state = createMigrationTestState();
    const dataKey = await stageAnalyticsBlobData(state.operations, [
      createEvent("current"),
    ]);
    state.objects.set(ANALYTICS_BLOB_KEY, { dataKey, schema: 2 });
    state.calls.length = 0;

    await migrateLegacyAnalyticsBlob(state.operations);

    await expect(
      loadActiveAnalyticsBlob(state.operations),
    ).resolves.toMatchObject({
      rows: [createEvent("current"), createEvent("legacy")],
    });
  });

  it("rejects a conflicting id without changing Core or the ready marker", async () => {
    const state = createMigrationTestState();
    const dataKey = await stageAnalyticsBlobData(state.operations, [
      createEvent("legacy", "different-bundle"),
    ]);
    const manifest = { dataKey, schema: 2 };
    state.objects.set(ANALYTICS_BLOB_KEY, manifest);
    const originalCore = state.activeCore;
    state.calls.length = 0;

    const result = migrateLegacyAnalyticsBlob(state.operations);

    await expect(result).rejects.toBeInstanceOf(AnalyticsBlobFormatError);
    expect(state.activeCore).toEqual(originalCore);
    expect(state.objects.get(ANALYTICS_BLOB_KEY)).toEqual(manifest);
    expect(state.calls).toEqual([]);
  });

  it.each([
    {
      name: "unknown legacy root fields",
      snapshot: {
        ...createCoreSnapshot([createEvent("legacy")]),
        another_extension: { enabled: true },
      },
    },
    {
      name: "unknown event fields",
      snapshot: createCoreSnapshot([
        { ...createEvent("legacy"), future_field: true },
      ]),
    },
    {
      name: "duplicate legacy ids",
      snapshot: createCoreSnapshot([
        createEvent("duplicate"),
        createEvent("duplicate"),
      ]),
    },
  ])("rejects $name before staging data", async ({ snapshot }) => {
    const state = createMigrationTestState(snapshot);
    const original = state.activeCore;

    const result = migrateLegacyAnalyticsBlob(state.operations);

    await expect(result).rejects.toBeInstanceOf(AnalyticsBlobFormatError);
    expect(state.activeCore).toEqual(original);
    expect(state.calls).toEqual([]);
  });

  it("delegates Core row and revision compatibility before staging data", async () => {
    const state = createMigrationTestState({
      version: 2,
      bundles: [{ id: "bundle", future_field: true }],
      bundle_patches: [],
      bundle_events: [createEvent("legacy")],
    });
    state.rejectCoreCompatibility(
      new AnalyticsBlobFormatError("Core row has schema drift."),
    );

    const result = migrateLegacyAnalyticsBlob(state.operations);

    await expect(result).rejects.toBeInstanceOf(AnalyticsBlobFormatError);
    expect(state.calls).toEqual([]);
  });

  it.each([
    {
      initialCore: createCoreSnapshot([createEvent("legacy")]),
      key: ANALYTICS_BLOB_KEY,
      name: "a future Analytics manifest",
      value: { dataKey: "future", schema: 3 },
    },
    {
      initialCore: createCoreSnapshot(),
      key: ANALYTICS_BLOB_PENDING_KEY,
      name: "a corrupt pending pointer",
      value: { dataKey: "../outside-feature-storage" },
    },
  ])("rejects $name before publishing readiness", async (fixture) => {
    const state = createMigrationTestState(fixture.initialCore);
    state.objects.set(fixture.key, fixture.value);
    const readyBefore = state.objects.get(ANALYTICS_BLOB_KEY) ?? null;

    const result = migrateLegacyAnalyticsBlob(state.operations);

    await expect(result).rejects.toBeInstanceOf(AnalyticsBlobFormatError);
    expect(state.objects.get(ANALYTICS_BLOB_KEY) ?? null).toEqual(readyBefore);
    expect(state.calls).toEqual([]);
  });

  it("creates an empty feature-owned schema for a compatible fresh Core", async () => {
    const state = createMigrationTestState(createCoreSnapshot());

    await migrateLegacyAnalyticsBlob(state.operations);

    await expect(
      loadActiveAnalyticsBlob(state.operations),
    ).resolves.toMatchObject({ rows: [] });
    expect(state.calls.at(-1)).toBe("manifest");
    expect(state.archives).toEqual([]);
  });
});
