import {
  createDatabaseClient,
  compareInsightsText,
  toInsightsInstallationRow,
  type BundleEventRow,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  setupDatabaseClientTestSuite,
  setupDatabasePluginTestSuite,
} from "@hot-updater/test-utils";
import { Transaction } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseDatabase } from "./firebaseDatabase";
import {
  firebaseChannelDocumentId,
  firebaseInstallationDocumentId,
} from "./firebaseDatabasePersistence";
import { migrateFirebaseInsights } from "./firebaseInsightsMigration";

const PROJECT_ID = "firebase-database-test";

const {
  firestore,
  bundleEventsCollection,
  bundleInstallationsCollection,
  bundlePatchesCollection,
  bundlesCollection,
  channelsCollection,
  clearCollections,
  legacyBundlesCollection,
  legacyInstallationsCollection,
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

  it.each([1, 2, 3, 6])(
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
    ).toEqual({ version: 5 });
  });

  it("initializes an empty database as the v1 adapter", async () => {
    await expect(findAllBundles(createPlugin())).resolves.toEqual([]);
    expect(
      (await settingsCollection.doc("database_adapter_version").get()).data(),
    ).toEqual({ version: 5 });
  });

  it("requires an explicit resumable migration for populated legacy installation keys", async () => {
    await settingsCollection
      .doc("database_adapter_version")
      .set({ version: 4 });
    const ids = [
      "a",
      "install_YQ",
      ...Array.from(
        { length: 199 },
        (_, index) => `legacy-${index.toString().padStart(3, "0")}`,
      ),
    ];
    const batch = firestore.batch();
    for (const [index, install_id] of ids.entries()) {
      const event = {
        ...createBundleEventRowFixture(String(1000 + index), 100),
        install_id,
        user_id: "migrated-user",
      };
      batch.set(
        legacyInstallationsCollection.doc(install_id),
        toInsightsInstallationRow(event),
      );
    }
    batch.set(legacyInstallationsCollection.doc("zz-malformed"), {
      install_id: "zz-malformed",
    });
    await batch.commit();
    await expect(
      createPlugin().models.insights.findInstallations({ installId: "a" }),
    ).rejects.toThrow("migrateFirebaseInsights(config)");
    const config = { projectId: PROJECT_ID };
    await expect(migrateFirebaseInsights(config)).rejects.toThrow(
      "zz-malformed",
    );
    expect((await bundleInstallationsCollection.get()).size).toBe(200);
    expect(
      (await settingsCollection.doc("database_adapter_version").get()).data()
        ?.version,
    ).toBe(4);
    const repaired = {
      ...createBundleEventRowFixture("1201", 100),
      install_id: "zz-malformed",
      user_id: "migrated-user",
    };
    await legacyInstallationsCollection
      .doc(repaired.install_id)
      .set(toInsightsInstallationRow(repaired));
    await migrateFirebaseInsights(config);
    await migrateFirebaseInsights(config);
    expect(
      (await settingsCollection.doc("database_adapter_version").get()).data()
        ?.version,
    ).toBe(5);
    expect((await legacyInstallationsCollection.get()).size).toBe(202);
    expect((await bundleInstallationsCollection.get()).size).toBe(202);
    for (const installId of ["a", "install_YQ"]) {
      await expect(
        createPlugin().models.insights.findInstallations({ installId }),
      ).resolves.toEqual([expect.objectContaining({ install_id: installId })]);
      expect(
        (
          await bundleInstallationsCollection
            .doc(firebaseInstallationDocumentId(installId))
            .get()
        ).exists,
      ).toBe(true);
    }
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

  it("keeps arbitrary exact installation IDs separate and pages in UTF-8 order", async () => {
    const insights = createPlugin().models.insights;
    const ids = ["a/b", ".", "..", "__reserved__", "A", "a", "\uE000", "😀"];
    for (const [index, install_id] of ids.entries()) {
      const event = {
        ...createBundleEventRowFixture(String(980 + index), 100),
        install_id,
        user_id: "unicode-user",
      };
      await insights.record({
        event,
        installation: toInsightsInstallationRow(event),
      });
      await expect(
        insights.findInstallations({ installId: install_id }),
      ).resolves.toEqual([toInsightsInstallationRow(event)]);
    }
    const actual: string[] = [];
    for (;;) {
      const page = await insights.findInstallations({
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
    const input = { event, installation: toInsightsInstallationRow(event) };
    const write = vi
      .spyOn(Transaction.prototype, "set")
      .mockImplementationOnce(() => {
        throw new Error("injected installation write failure");
      });
    try {
      await expect(insights.record(input)).rejects.toThrow(
        "injected installation write failure",
      );
    } finally {
      write.mockRestore();
    }
    expect((await bundleEventsCollection.doc(event.id).get()).exists).toBe(
      false,
    );
    await expect(
      insights.findInstallations({ installId: event.install_id }),
    ).resolves.toEqual([]);
    await insights.record(input);
    await insights.record(input);
    expect((await bundleEventsCollection.get()).size).toBe(1);
    await expect(
      insights.findInstallations({ installId: event.install_id }),
    ).resolves.toEqual([input.installation]);
  });

  it("serializes concurrent reports, clears current user, and never loads other models", async () => {
    const insights = createPlugin().models.insights;
    await insights.findInstallations({ installId: "initialize-schema" });
    await bundlesCollection.doc("unrelated-malformed").set({ invalid: true });
    const events = ["950", "953", "951", "952"].map((suffix) => ({
      ...createBundleEventRowFixture(suffix, 200),
      install_id: "concurrent-installation",
      user_id: suffix === "953" ? null : "previous-user",
    }));
    await Promise.all(
      events.map((event) =>
        insights.record({
          event,
          installation: toInsightsInstallationRow(event),
        }),
      ),
    );
    const winner = events[1]!;
    await expect(
      insights.findInstallations({ installId: winner.install_id }),
    ).resolves.toEqual([toInsightsInstallationRow(winner)]);
    await expect(
      insights.findInstallations({ userId: "previous-user", limit: 10 }),
    ).resolves.toEqual([]);
    expect((await bundleEventsCollection.get()).size).toBe(4);
    await expect(
      insights.countInstallations({
        platform: "ios",
        channel: "production",
        sinceMs: 100,
      }),
    ).resolves.toBe(1);
  });

  it("counts recovery against its source with the same scope and time boundaries as its list", async () => {
    const insights = createPlugin().models.insights;
    const first = createBundleEventRowFixture("960", 100);
    const bundleId = first.to_bundle_id;
    const recovered: BundleEventRow = {
      ...createBundleEventRowFixture("961", 200),
      type: "RECOVERED",
      update_strategy: "appVersion",
      install_id: first.install_id,
      from_bundle_id: bundleId,
      to_bundle_id: first.from_bundle_id!,
    };
    const excluded = {
      ...recovered,
      id: createBundleEventRowFixture("962", 300).id,
      received_at_ms: 300,
    };
    for (const event of [
      first,
      recovered,
      excluded,
      {
        ...recovered,
        id: createBundleEventRowFixture("963", 200).id,
        channel: "other",
      },
    ]) {
      await insights.record({
        event,
        installation: toInsightsInstallationRow(event),
      });
    }
    const filter = {
      type: "RECOVERED" as const,
      platform: "ios" as const,
      channel: "production",
      fromBundleId: bundleId,
    };
    await expect(
      insights.countEvents({ filter, sinceMs: 200, beforeReceivedAtMs: 300 }),
    ).resolves.toBe(1);
    await expect(
      insights.listEvents({
        filter: { kind: "bundle", ...filter },
        sinceMs: 200,
        beforeReceivedAtMs: 300,
        limit: 10,
      }),
    ).resolves.toEqual([recovered]);
    await expect(
      insights.countInstallations({
        platform: "ios",
        channel: "production",
        sinceMs: 100,
        bundleId,
      }),
    ).resolves.toBe(0);
  });

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

    await insights.record({
      event: latest,
      installation: toInsightsInstallationRow(latest),
    });
    await insights.record({
      event: older,
      installation: toInsightsInstallationRow(older),
    });
    await insights.record({
      event: tieWinner,
      installation: toInsightsInstallationRow(tieWinner),
    });

    await expect(
      insights.findInstallations({ installId: latest.install_id }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: tieWinner.id,
        install_id: latest.install_id,
        received_at_ms: 200,
      }),
    ]);
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
    await insights.record({
      event: applied,
      installation: toInsightsInstallationRow(applied),
    });
    await insights.record({
      event: recovered,
      installation: toInsightsInstallationRow(recovered),
    });
    await insights.record({
      event: unchanged,
      installation: toInsightsInstallationRow(unchanged),
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
    await insights.record({
      event: first,
      installation: toInsightsInstallationRow(first),
    });
    await insights.record({
      event: second,
      installation: toInsightsInstallationRow(second),
    });
    await insights.record({
      event: inactive,
      installation: toInsightsInstallationRow(inactive),
    });

    await expect(
      insights.findInstallations({
        userId: "shared-user",
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ install_id: first.install_id }),
    ]);
    await expect(
      insights.findInstallations({
        userId: "shared-user",
        afterInstallId: first.install_id,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ install_id: second.install_id }),
    ]);
    await expect(
      insights.countInstallations({
        platform: "ios",
        channel: "production",
        sinceMs: 100,
      }),
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
