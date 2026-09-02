import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { Query } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseInsightsDatabase } from "./db";
import { firebaseDatabase } from "./firebaseDatabase";
import { firebaseChannelDocumentId } from "./firebaseDatabasePersistence";

const PROJECT_ID = "firebase-database-test";
const INSIGHTS_DATABASE_NAMESPACE = "10000000-0000-4000-8000-000000000004";

const {
  bundlePatchesCollection,
  bundlesCollection,
  channelsCollection,
  clearCollections,
  legacyBundlesCollection,
  legacySettingsCollection,
  bundleEventsCollection,
  insightsV2,
  settingsCollection,
} = createFirestoreMock(PROJECT_ID);

const createPlugin = (): DatabasePlugin =>
  firebaseDatabase({
    projectId: PROJECT_ID,
    storageBucket: `${PROJECT_ID}.appspot.com`,
    insightsDatabaseNamespace: INSIGHTS_DATABASE_NAMESPACE,
  });

const findAllBundles = (plugin: DatabasePlugin) =>
  plugin.models.bundles.findMany({
    limit: 100,
    offset: 0,
    orderBy: { field: "id", direction: "asc" },
  });

const storedBundleRow = (id: string) => ({
  id,
  platform: "ios",
  file_hash: `hash-${id}`,
  git_commit_hash: null,
  storage_uri: `gs://bucket/${id}.zip`,
  archive_byte_size: 3_000_000_001,
  metadata: {},
});

const bundleFixture = (suffix: string) => ({
  id: `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`,
  platform: "ios" as const,
  fileHash: `hash-${suffix}`,
  gitCommitHash: null,
  storageUri: `storage://bundles/${suffix}.zip`,
  archiveByteSize: 3_000_000_001,
  metadata: { app_version: suffix },
});

describe("firebase fixed-model document updates", () => {
  beforeEach(clearCollections);

  it("preserves an extension field when updating artifact metadata", async () => {
    const bundle = bundleFixture("extension-field");
    const client = createDatabaseClient(createPlugin());
    await client.insertBundle(bundle);
    await bundlesCollection.doc(bundle.id).update({
      extension_field: { version: "future" },
    });

    await client.updateBundleById(bundle.id, {
      metadata: { app_version: "updated" },
    });

    const stored = await bundlesCollection.doc(bundle.id).get();
    expect(stored.data()).toMatchObject({
      extension_field: { version: "future" },
      metadata: { app_version: "updated" },
    });
  });
});

describe("firebase infrastructure generation", () => {
  beforeEach(clearCollections);

  it.each([1, 2, 3, 5])(
    "rejects adapter version %s before reading database collections",
    async (version) => {
      const marker = { version, existing_option: "preserve-me" };
      await settingsCollection.doc("database_adapter_version").set(marker);
      const bundlesRead = vi.spyOn(bundlesCollection, "get");
      const patchesRead = vi.spyOn(bundlePatchesCollection, "get");

      await expect(findAllBundles(createPlugin())).rejects.toThrow(
        `Unsupported Firebase database adapter version: ${version}`,
      );
      expect(bundlesRead).not.toHaveBeenCalled();
      expect(patchesRead).not.toHaveBeenCalled();
      const storedMarker = await settingsCollection
        .doc("database_adapter_version")
        .get();
      expect(storedMarker.data()).toEqual(marker);
      bundlesRead.mockRestore();
      patchesRead.mockRestore();
    },
  );

  it("initializes v1 without modifying existing v0 collections", async () => {
    const legacy = storedBundleRow("legacy-bundle");
    await legacyBundlesCollection.doc(legacy.id).set(legacy);
    await legacySettingsCollection
      .doc("database_adapter_version")
      .set({ version: 3 });

    await expect(findAllBundles(createPlugin())).resolves.toEqual([]);

    expect((await legacyBundlesCollection.doc(legacy.id).get()).data()).toEqual(
      legacy,
    );
    expect(
      (
        await legacySettingsCollection.doc("database_adapter_version").get()
      ).data(),
    ).toEqual({ version: 3 });
    expect(
      (await settingsCollection.doc("database_adapter_version").get()).data(),
    ).toEqual({ version: 4 });
  });

  it("initializes an empty database as the v1 adapter", async () => {
    await expect(findAllBundles(createPlugin())).resolves.toEqual([]);
    expect(
      (await settingsCollection.doc("database_adapter_version").get()).data(),
    ).toEqual({ version: 4 });
  });
});

describe("firebase bounded reads", () => {
  beforeEach(clearCollections);

  it("uses an exact document read without parsing unrelated bundles", async () => {
    const plugin = createPlugin();
    const client = createDatabaseClient(plugin);
    const value = bundleFixture("992");
    await client.insertBundle(value);
    await bundlesCollection.doc("unrelated-malformed").set({
      channel: "other",
    });

    await expect(
      createPlugin().models.bundles.findById(value.id),
    ).resolves.toMatchObject({ id: value.id });
  });

  it("rejects a requested document whose key differs from its row id", async () => {
    await settingsCollection
      .doc("database_adapter_version")
      .set({ version: 4 });
    const documentKey = "requested-document-key";
    await bundlesCollection
      .doc(documentKey)
      .set(storedBundleRow("different-embedded-id"));

    await expect(
      createPlugin().models.bundles.findById(documentKey),
    ).rejects.toThrow("bundles.id.document-key");
  });
});

describe("firebase append-only Insights boundary", () => {
  beforeEach(clearCollections);

  it("publishes the complete v2 model without a legacy writer or scan", async () => {
    const first = createBundleEventRowFixture("919001", 100);
    const second = createBundleEventRowFixture("919002", 200);
    const maintenance = firebaseInsightsDatabase({
      projectId: PROJECT_ID,
      storageBucket: `${PROJECT_ID}.appspot.com`,
      insightsDatabaseNamespace: INSIGHTS_DATABASE_NAMESPACE,
    });
    await expect(
      maintenance.prepareStep({
        writersDrained: true,
        indexesReady: true,
        maxItems: 1,
        maxRequests: 4,
      }),
    ).resolves.toEqual({ state: "ready", processed: 0 });
    const plugin = createPlugin();

    expect(plugin.models.insights).toMatchObject({
      append: expect.any(Function),
      pageEvents: expect.any(Function),
      pageInstallations: expect.any(Function),
      getReport: expect.any(Function),
      pageReport: expect.any(Function),
    });
    expect(plugin.models.insights).not.toHaveProperty("scan");
    await plugin.models.insights.append(second);
    await plugin.models.insights.append(first);

    await expect(
      plugin.models.insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: Number.MAX_SAFE_INTEGER,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "ready",
      data: { data: [second, first] },
    });
    await expect(
      plugin.models.insights.pageInstallations({ kind: "all", limit: 10 }),
    ).resolves.toMatchObject({ state: "ready" });
    expect((await bundleEventsCollection.get()).empty).toBe(true);
    expect((await insightsV2.events.get()).size).toBe(2);
    expect((await insightsV2.sourceClocks.get()).size).toBe(65);
    expect(
      (await settingsCollection.doc("database_adapter_version").get()).data(),
    ).toBeUndefined();
  });

  it("requires a canonical durable namespace before constructing the model", () => {
    expect(() =>
      firebaseDatabase({
        projectId: PROJECT_ID,
        storageBucket: `${PROJECT_ID}.appspot.com`,
        insightsDatabaseNamespace: "NOT-A-UUID",
      }),
    ).toThrow("canonical lowercase UUID database namespace");
  });

  it("fails closed before event queries when the stored namespace differs", async () => {
    await firebaseInsightsDatabase({
      projectId: PROJECT_ID,
      insightsDatabaseNamespace: INSIGHTS_DATABASE_NAMESPACE,
    }).prepareStep({
      writersDrained: true,
      indexesReady: true,
      maxItems: 1,
      maxRequests: 4,
    });
    const mismatch = firebaseDatabase({
      projectId: PROJECT_ID,
      insightsDatabaseNamespace: "10000000-0000-4000-8000-0000000000ff",
    });
    const dataReads = vi.spyOn(Query.prototype, "get");

    await expect(
      mismatch.models.insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: Number.MAX_SAFE_INTEGER,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    expect(dataReads).not.toHaveBeenCalled();
    dataReads.mockRestore();
  });
});

describe("firebase channel storage", () => {
  beforeEach(clearCollections);

  it("returns the canonical stored row under concurrent name conflicts", async () => {
    const first = createPlugin();
    await first.models.channels.list({});
    const second = createPlugin();

    const results = await Promise.all([
      first.models.channels.insert({
        row: { id: "channel-concurrent-a", name: "concurrent" },
        onConflict: "returnExisting",
      }),
      second.models.channels.insert({
        row: { id: "channel-concurrent-b", name: "concurrent" },
        onConflict: "returnExisting",
      }),
    ]);

    expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
    expect(results[0]?.row).toEqual(results[1]?.row);
    await expect(first.models.channels.list({})).resolves.toEqual({
      channels: [results[0]?.row],
    });
  });

  it("lists the channels collection without reading bundles", async () => {
    const plugin = createPlugin();
    await plugin.models.channels.insert({
      row: { id: "channel-direct-list", name: "direct-list" },
      onConflict: "returnExisting",
    });
    const bundlesRead = vi.spyOn(bundlesCollection, "get");

    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [{ id: "channel-direct-list", name: "direct-list" }],
    });
    expect(bundlesRead).not.toHaveBeenCalled();
    const stored = await channelsCollection
      .doc(firebaseChannelDocumentId("direct-list"))
      .get();
    expect(stored.data()).toEqual({
      id: "channel-direct-list",
      name: "direct-list",
    });
    bundlesRead.mockRestore();
  });
});
