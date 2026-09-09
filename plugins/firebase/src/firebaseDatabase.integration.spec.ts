import {
  createDatabaseClient,
  compareInsightsText,
  type BundleEventRow,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  setupDatabaseClientTestSuite,
  setupDatabasePluginTestSuite,
} from "@hot-updater/test-utils";
import { Query, Transaction } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseDatabase } from "./firebaseDatabase";
import {
  firebaseChannelDocumentId,
  firebaseInstallationDocumentId,
} from "./firebaseDatabasePersistence";

const PROJECT_ID = "firebase-database-test";

const {
  bundleEventsCollection,
  bundlePatchesCollection,
  bundlesCollection,
  channelsCollection,
  clearCollections,
  insightsLatestCollection,
  firestore,
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

  it("rebuilds a lost private latest copy by replaying into empty Insights storage", async () => {
    const insights = createPlugin().models.insights;
    const old = {
      ...createBundleEventRowFixture("9701", 100),
      user_id: "old-user",
    };
    const latest = {
      ...old,
      id: createBundleEventRowFixture("9702", 200).id,
      received_at_ms: 200,
      user_id: "new-user",
    };
    await insights.recordEvent({ event: latest });
    await insights.recordEvent({ event: old });
    await bundlesCollection.doc("unrelated").set({ preserve: "artifact" });
    const exported = await insights.listEvents({
      filter: { kind: "all" },
      beforeReceivedAtMs: 201,
      limit: 10,
    });
    await insightsLatestCollection
      .doc(firebaseInstallationDocumentId(old.install_id))
      .delete();
    await insights.recordEvent({ event: latest });
    // Duplicate replay into damaged storage cannot repair it.
    await expect(
      insights.findLatestEvents({ installId: old.install_id }),
    ).resolves.toEqual([]);
    // No writers run during this offline fixture. Only disposable Insights
    // storage is emptied; production uses a separately initialized target.
    for (const collection of [
      bundleEventsCollection,
      insightsLatestCollection,
    ]) {
      const snapshot = await collection.get();
      const batch = firestore.batch();
      for (const document of snapshot.docs) batch.delete(document.ref);
      await batch.commit();
    }
    for (const event of [...exported, ...exported.toReversed()])
      await insights.recordEvent({ event });
    await expect(
      insights.findLatestEvents({ installId: old.install_id }),
    ).resolves.toEqual([latest]);
    await expect(
      insights.findLatestEvents({ userId: "old-user", limit: 10 }),
    ).resolves.toEqual([]);
    await expect(
      insights.findLatestEvents({ userId: "new-user", limit: 10 }),
    ).resolves.toEqual([latest]);
    expect((await bundleEventsCollection.get()).size).toBe(2);
    expect((await bundlesCollection.doc("unrelated").get()).data()).toEqual({
      preserve: "artifact",
    });
  });

  it("uses the event-list index ordering for event counts", async () => {
    const orderBy = vi.spyOn(Query.prototype, "orderBy");
    try {
      await createPlugin().models.insights.countEvents({
        filter: {
          type: "UPDATE_APPLIED",
          platform: "ios",
          channel: "production",
          toBundleId: "00000000-0000-0000-0000-000000000001",
        },
        sinceMs: 0,
        beforeReceivedAtMs: 1,
      });
      expect(orderBy.mock.calls).toEqual(
        expect.arrayContaining([
          ["received_at_ms", "desc"],
          ["id", "desc"],
        ]),
      );
    } finally {
      orderBy.mockRestore();
    }
  });

  it("keeps arbitrary exact installation IDs separate and pages in UTF-8 order", async () => {
    const insights = createPlugin().models.insights;
    const ids = [
      "a/b",
      ".",
      "..",
      "__reserved__",
      "A",
      "a",
      "install_YQ",
      "\uE000",
      "😀",
    ];
    for (const [index, install_id] of ids.entries()) {
      const event = {
        ...createBundleEventRowFixture(String(980 + index), 100),
        install_id,
        user_id: "unicode-user",
      };
      await insights.recordEvent({
        event,
      });
      await expect(
        insights.findLatestEvents({ installId: install_id }),
      ).resolves.toEqual([event]);
    }
    const actual: string[] = [];
    for (;;) {
      const page = await insights.findLatestEvents({
        userId: "unicode-user",
        afterInstallId: actual.at(-1),
        limit: 2,
      });
      actual.push(...page.map((row) => row.install_id));
      if (page.length < 2) break;
    }
    expect(actual).toEqual(ids.toSorted(compareInsightsText));
  });

  it("rolls back an event when its installation write fails and retries safely", async () => {
    const insights = createPlugin().models.insights;
    const event = createBundleEventRowFixture("941", 100);
    const input = { event };
    const write = vi
      .spyOn(Transaction.prototype, "set")
      .mockImplementationOnce(() => {
        throw new Error("injected installation write failure");
      });
    try {
      await expect(insights.recordEvent(input)).rejects.toThrow(
        "injected installation write failure",
      );
    } finally {
      write.mockRestore();
    }
    expect((await bundleEventsCollection.doc(event.id).get()).exists).toBe(
      false,
    );
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([]);
    await insights.recordEvent(input);
    await insights.recordEvent(input);
    expect((await bundleEventsCollection.get()).size).toBe(1);
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([input.event]);
  });

  it("serializes concurrent reports, clears current user, and never loads other models", async () => {
    const insights = createPlugin().models.insights;
    await insights.findLatestEvents({ installId: "initialize-schema" });
    await bundlesCollection.doc("unrelated-malformed").set({ invalid: true });
    const events = ["950", "953", "951", "952"].map((suffix) => ({
      ...createBundleEventRowFixture(suffix, 200),
      install_id: "concurrent-installation",
      user_id: suffix === "953" ? null : "previous-user",
    }));
    await Promise.all(
      events.map((event) =>
        insights.recordEvent({
          event,
        }),
      ),
    );
    const winner = events[1]!;
    await expect(
      insights.findLatestEvents({ installId: winner.install_id }),
    ).resolves.toEqual([winner]);
    await expect(
      insights.findLatestEvents({ userId: "previous-user", limit: 10 }),
    ).resolves.toEqual([]);
    expect((await bundleEventsCollection.get()).size).toBe(4);
    await expect(
      insights.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs: 100,
      }),
    ).resolves.toBe(1);
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
      metadata: {
        ...createBundleEventRowFixture("913", 300).metadata,
        update_strategy: null,
      },
    };
    await insights.recordEvent({
      event: applied,
    });
    await insights.recordEvent({
      event: recovered,
    });
    await insights.recordEvent({
      event: unchanged,
    });
    await bundleEventsCollection.doc("malformed-old-event").set({
      id: "malformed-old-event",
      received_at_ms: 1,
    });

    await expect(
      insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 1_000,
        limit: 1,
      }),
    ).resolves.toEqual([unchanged]);
    await expect(
      insights.listEvents({
        filter: {
          kind: "installationMovement",
          installId: applied.install_id,
        },
        beforeReceivedAtMs: 1_000,
        limit: 10,
      }),
    ).resolves.toEqual([recovered, applied]);
  });

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
