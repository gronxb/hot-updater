import {
  createDatabaseClient,
  type BundleEventRow,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  setupDatabaseClientTestSuite,
  setupDatabasePluginTestSuite,
} from "@hot-updater/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseDatabase } from "./firebaseDatabase";
import { firebaseChannelDocumentId } from "./firebaseDatabasePersistence";

const PROJECT_ID = "firebase-database-test";

const {
  bundleEventsCollection,
  bundleInstallationsCollection,
  bundlePatchesCollection,
  bundlesCollection,
  channelsCollection,
  clearCollections,
  legacyBundlesCollection,
  legacySettingsCollection,
  settingsCollection,
} = createFirestoreMock(PROJECT_ID);

const createPlugin = (): DatabasePlugin =>
  firebaseDatabase({
    projectId: PROJECT_ID,
    storageBucket: `${PROJECT_ID}.appspot.com`,
  });

const findAllBundles = (plugin: DatabasePlugin) =>
  plugin.models.bundles.findMany({
    limit: 100,
    offset: 0,
    orderBy: { field: "id", direction: "asc" },
  });

setupDatabasePluginTestSuite({
  name: "firebase fixed-model database plugin",
  createPlugin,
  migrate: () => undefined,
  reset: clearCollections,
  dispose: () => undefined,
});

setupDatabaseClientTestSuite({
  name: "firebase database aggregate client",
  createPlugin,
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: clearCollections,
  dispose: () => undefined,
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

describe("firebase insights storage", () => {
  beforeEach(clearCollections);

  it("keeps the latest installation by received time and event id", async () => {
    const insights = createPlugin().models.insights;
    const latest = {
      ...createBundleEventRowFixture("903", 200),
      install_id: "installation-latest",
      user_id: "user-latest",
    };
    const older = {
      ...createBundleEventRowFixture("901", 100),
      install_id: latest.install_id,
      user_id: latest.user_id,
    };
    const tieWinner = {
      ...createBundleEventRowFixture("904", 200),
      install_id: latest.install_id,
      user_id: latest.user_id,
    };

    await insights.append(latest);
    await insights.append(older);
    await insights.append(tieWinner);

    await expect(insights.getInstallation(latest.install_id)).resolves.toEqual(
      expect.objectContaining({
        id: tieWinner.id,
        install_id: latest.install_id,
        received_at_ms: 200,
      }),
    );
    expect((await bundleInstallationsCollection.get()).size).toBe(1);
    expect((await bundleEventsCollection.get()).size).toBe(3);
  });

  it("uses bounded event pages and filters installation movement", async () => {
    const insights = createPlugin().models.insights;
    const applied = {
      ...createBundleEventRowFixture("911", 200),
      install_id: "installation-page",
    };
    const recovered = {
      ...createBundleEventRowFixture("912", 200),
      type: "RECOVERED" as const,
      install_id: applied.install_id,
    } as BundleEventRow;
    const unchanged = {
      ...createBundleEventRowFixture("913", 300),
      type: "UNCHANGED" as const,
      install_id: applied.install_id,
      from_bundle_id: null,
      update_strategy: null,
    };
    await insights.append(applied);
    await insights.append(recovered);
    await insights.append(unchanged);
    await bundleEventsCollection.doc("malformed-old-event").set({
      id: "malformed-old-event",
      received_at_ms: 1,
    });

    await expect(
      insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 1_000,
        limit: 1,
      }),
    ).resolves.toEqual([unchanged]);
    await expect(
      insights.pageEvents({
        selector: {
          kind: "installationMovement",
          installId: applied.install_id,
        },
        beforeReceivedAtMs: 1_000,
        limit: 10,
      }),
    ).resolves.toEqual([recovered, applied]);
  });

  it("pages current user installations and counts active installations", async () => {
    const insights = createPlugin().models.insights;
    const first = {
      ...createBundleEventRowFixture("921", 100),
      install_id: "installation-a",
      user_id: "shared-user",
    };
    const second = {
      ...createBundleEventRowFixture("922", 200),
      install_id: "installation-b",
      user_id: "shared-user",
    };
    const inactive = {
      ...createBundleEventRowFixture("923", 50),
      install_id: "installation-c",
      user_id: "other-user",
    };
    await insights.append(first);
    await insights.append(second);
    await insights.append(inactive);

    await expect(
      insights.pageInstallationsByCurrentUserId({
        userId: "shared-user",
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ install_id: first.install_id }),
    ]);
    await expect(
      insights.pageInstallationsByCurrentUserId({
        userId: "shared-user",
        afterInstallId: first.install_id,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ install_id: second.install_id }),
    ]);
    await expect(
      insights.countActiveInstallations({ sinceMs: 100 }),
    ).resolves.toBe(2);
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
