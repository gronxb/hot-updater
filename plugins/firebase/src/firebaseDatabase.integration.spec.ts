import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  setupDatabaseClientTestSuite,
  setupDatabasePluginTestSuite,
} from "@hot-updater/test-utils";
import { Query, Transaction } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBundleEventRowFixture,
  createBundleRowFixture,
} from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseDatabase } from "./firebaseDatabase";
import { firebaseChannelDocumentId } from "./firebaseDatabasePersistence";
import { toFirebaseEventDocument } from "./firebaseEventIndex";

const PROJECT_ID = "firebase-database-test";

const {
  bundleEventsCollection,
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

describe("firebase event write isolation", () => {
  beforeEach(clearCollections);

  it("rejects identities that cannot retain exact index ordering or UTF-8 equality on both write paths", async () => {
    const plugin = createPlugin();
    const bundle = createBundleRowFixture("818");
    await plugin.commit({
      changes: [{ model: "bundles", operation: "insert", row: bundle }],
    });
    const valid = createBundleEventRowFixture("819", 100);
    for (const event of [
      { ...valid, id: "\uE000" },
      { ...valid, id: "\u{10000}" },
      { ...valid, id: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" },
      { ...valid, install_id: "unpaired-\uD800" },
    ]) {
      await expect(plugin.models.insights.append(event)).rejects.toMatchObject({
        code: "invalid-data",
      });
      await expect(
        plugin.commit({
          changes: [
            {
              model: "bundles",
              operation: "update",
              where: { id: bundle.id },
              update: { metadata: { incorrect: true } },
            },
            { model: "insights", operation: "insert", row: event },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid-data" });
      expect(
        (await bundlesCollection.doc(bundle.id).get()).data()?.metadata,
      ).toEqual(bundle.metadata);
    }
    expect((await bundleEventsCollection.get()).empty).toBe(true);
  });

  it("appends without reading history or unrelated catalog documents", async () => {
    await settingsCollection
      .doc("database_adapter_version")
      .set({ version: 4 });
    await bundlesCollection.doc("unrelated-malformed").set({ invalid: true });
    await bundleEventsCollection
      .doc("unrelated-malformed")
      .set({ invalid: true });
    const event = createBundleEventRowFixture("810", 100);
    const reads = vi.spyOn(Query.prototype, "get");
    const transactionReads = vi.spyOn(Transaction.prototype, "get");
    try {
      await createPlugin().models.insights.append(event);
      expect(reads).not.toHaveBeenCalled();
      expect(transactionReads).not.toHaveBeenCalled();
      expect((await bundleEventsCollection.doc(event.id).get()).data()).toEqual(
        toFirebaseEventDocument(event),
      );
    } finally {
      reads.mockRestore();
      transactionReads.mockRestore();
    }
  });

  it("keeps history out of catalog reads, mutations and mixed commits", async () => {
    await settingsCollection
      .doc("database_adapter_version")
      .set({ version: 4 });
    const untouched = { invalid: true, extension: "preserve" };
    await bundleEventsCollection.doc("unrelated-malformed").set(untouched);
    const plugin = createPlugin();
    const bundle = createBundleRowFixture("811");
    const event = createBundleEventRowFixture("812", 100);
    const reads = vi.spyOn(Query.prototype, "get");
    const transactionReads = vi.spyOn(Transaction.prototype, "get");
    try {
      await expect(
        plugin.commit({
          changes: [
            { model: "bundles", operation: "insert", row: bundle },
            { model: "insights", operation: "insert", row: event },
          ],
        }),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.commit({
          changes: [
            {
              model: "bundles",
              operation: "update",
              where: { id: bundle.id },
              update: { metadata: { updated: true } },
            },
          ],
        }),
      ).resolves.toEqual({ committed: true });
      await expect(findAllBundles(plugin)).resolves.toMatchObject([
        { id: bundle.id, metadata: { updated: true } },
      ]);
      expect(
        reads.mock.contexts.some(
          (query) =>
            query instanceof Query && query.isEqual(bundleEventsCollection),
        ),
      ).toBe(false);
      expect(
        transactionReads.mock.calls.some(
          ([reference]) =>
            reference instanceof Query &&
            reference.isEqual(bundleEventsCollection),
        ),
      ).toBe(false);
      expect(
        (await bundleEventsCollection.doc("unrelated-malformed").get()).data(),
      ).toEqual(untouched);
      expect((await bundleEventsCollection.doc(event.id).get()).data()).toEqual(
        toFirebaseEventDocument(event),
      );
    } finally {
      reads.mockRestore();
      transactionReads.mockRestore();
    }
  });

  it("rejects duplicate events and rolls back every change in a mixed commit", async () => {
    const plugin = createPlugin();
    const event = createBundleEventRowFixture("813", 100);
    await plugin.models.insights.append(event);
    const stored = { ...event, extension: "preserve" };
    await bundleEventsCollection.doc(event.id).set(stored);
    const bundle = createBundleRowFixture("814");
    await plugin.commit({
      changes: [{ model: "bundles", operation: "insert", row: bundle }],
    });
    const replacement = { ...event, install_id: "different-installation" };

    await expect(plugin.models.insights.append(replacement)).rejects.toThrow();
    await expect(
      plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id: bundle.id },
            update: { metadata: { incorrect: true } },
          },
          { model: "insights", operation: "insert", row: replacement },
        ],
      }),
    ).rejects.toThrow();
    expect(
      (await bundlesCollection.doc(bundle.id).get()).data()?.metadata,
    ).toEqual(bundle.metadata);
    expect((await bundleEventsCollection.doc(event.id).get()).data()).toEqual(
      stored,
    );

    const fresh = createBundleEventRowFixture("815", 200);
    await expect(
      plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id: bundle.id },
            update: { metadata: { incorrect: true } },
          },
          { model: "insights", operation: "insert", row: fresh },
          { model: "insights", operation: "insert", row: fresh },
        ],
      }),
    ).rejects.toThrow();
    expect(
      (await bundlesCollection.doc(bundle.id).get()).data()?.metadata,
    ).toEqual(bundle.metadata);
    expect((await bundleEventsCollection.doc(fresh.id).get()).exists).toBe(
      false,
    );
  });

  it("allows only one writer when append races a mixed commit for the same event ID", async () => {
    const plugin = createPlugin();
    await plugin.models.channels.list({});
    const event = createBundleEventRowFixture("816", 100);
    const competing = { ...event, install_id: "competing-installation" };
    const bundle = createBundleRowFixture("817");
    const results = await Promise.allSettled([
      plugin.models.insights.append(event),
      plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          { model: "insights", operation: "insert", row: competing },
        ],
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const commitWon = results[1].status === "fulfilled";
    expect((await bundleEventsCollection.doc(event.id).get()).data()).toEqual(
      toFirebaseEventDocument(commitWon ? competing : event),
    );
    expect((await bundlesCollection.doc(bundle.id).get()).exists).toBe(
      commitWon,
    );
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
