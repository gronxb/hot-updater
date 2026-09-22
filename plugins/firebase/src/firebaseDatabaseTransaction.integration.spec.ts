import type { BundleRow, ReleaseRow } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import { createFirestoreMock } from "../test-utils/createFirestoreMock";
import { firebaseDatabase } from "./firebaseDatabase";
import {
  createFirebaseDatabaseCollections,
  firebaseChannelIdDocumentId,
} from "./firebaseDatabasePersistence";
import { createFirebaseTransaction } from "./firebaseDatabaseTransaction";

const { clearCollections, settingsCollection, firestore } = createFirestoreMock(
  "firebase-staging-test",
);
const channel = { id: "channel", name: "production" };
const bundle: BundleRow = {
  id: "bundle",
  platform: "ios",
  git_commit_hash: null,
  metadata: {},
  manifest_storage_uri: "storage://bundle/manifest.json",
  manifest_file_hash: "hash",
  asset_base_storage_uri: "storage://assets",
};
const release = (id: string): ReleaseRow => ({
  id: `00000000-0000-7000-8000-${id.padStart(12, "0")}`,
  revision: 1,
  scope_key: "scope",
  channel_id: channel.id,
  platform: "ios",
  kind: "BUNDLE",
  bundle_id: bundle.id,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: null,
  rollout_cohort_count: 1,
  target_cohorts: ["0"],
  operation: "DEPLOY",
  source_release_id: null,
  created_at_ms: 1,
  updated_at_ms: 1,
});

describe("Firebase staged commit invariants", () => {
  beforeEach(clearCollections);

  it("serializes concurrent channel commits with the same ID and different names", async () => {
    const plugin = firebaseDatabase({});
    await plugin.models.channels.list({});
    const results = await Promise.allSettled(
      ["production", "preview"].map((name) =>
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: { id: "same-id", name },
              onConflict: "ignore",
            },
          ],
        }),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const { channels } = await plugin.models.channels.list({});
    expect(channels).toHaveLength(1);
    expect(
      (
        await settingsCollection
          .doc(firebaseChannelIdDocumentId("same-id"))
          .get()
      ).data(),
    ).toEqual(channels[0]);
  });

  it("returns one canonical channel under concurrent name conflicts", async () => {
    const plugin = firebaseDatabase({});
    await plugin.models.channels.list({});
    const results = await Promise.all(
      ["a", "b"].map((id) =>
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: { id, name: "same-name" },
              onConflict: "ignore",
            },
          ],
        }),
      ),
    );
    expect(results).toEqual([{ committed: true }, { committed: true }]);
    const { channels } = await plugin.models.channels.list({});
    expect(channels).toHaveLength(1);
    for (const id of ["a", "b"]) {
      const registry = await settingsCollection
        .doc(firebaseChannelIdDocumentId(id))
        .get();
      expect(registry.exists).toBe(id === channels[0].id);
    }
  });

  it("keeps reference checks atomic with staged release deletes and projected validation", async () => {
    const plugin = firebaseDatabase({});
    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: channel,
            onConflict: "ignore",
          },
          { model: "bundles", operation: "insert", row: bundle },
          { model: "releases", operation: "insert", row: release("a") },
          { model: "releases", operation: "insert", row: release("b") },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(
      plugin.commit({
        changes: [
          {
            model: "releases",
            operation: "update",
            where: { id: release("a").id },
            update: { target_app_version: "2.0.0", revision: 2 },
          },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(
      plugin.models.releases.findById(release("a").id),
    ).resolves.toEqual({
      ...release("a"),
      target_app_version: "2.0.0",
      revision: 2,
    });

    await expect(
      plugin.commit({
        changes: [
          {
            model: "releases",
            operation: "delete",
            where: { id: release("a").id },
          },
          { model: "bundles", operation: "delete", where: { id: bundle.id } },
        ],
      }),
    ).resolves.toEqual({
      committed: false,
      conflict: { changeIndex: 1, reason: "referenced" },
    });
    // The rejected commit must not persist the first deletion.
    expect(
      await plugin.models.releases.findById(release("a").id),
    ).not.toBeNull();

    await expect(
      plugin.commit({
        changes: [
          {
            model: "releases",
            operation: "delete",
            where: { id: release("a").id },
          },
          {
            model: "releases",
            operation: "delete",
            where: { id: release("b").id },
          },
          { model: "bundles", operation: "delete", where: { id: bundle.id } },
          { model: "channels", operation: "delete", where: { id: channel.id } },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(plugin.models.bundles.findById(bundle.id)).resolves.toBeNull();
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
    expect(
      (
        await settingsCollection
          .doc(firebaseChannelIdDocumentId(channel.id))
          .get()
      ).exists,
    ).toBe(false);
  });
  it("supports projected core existence checks while retaining complete staged rows", async () => {
    const plugin = firebaseDatabase({});
    await plugin.commit({
      changes: [
        {
          model: "channels",
          operation: "insert",
          row: channel,
          onConflict: "ignore",
        },
        { model: "bundles", operation: "insert", row: bundle },
        { model: "releases", operation: "insert", row: release("a") },
        { model: "releases", operation: "insert", row: release("b") },
      ],
    });
    await firestore.runTransaction(async (transaction) => {
      const staged = createFirebaseTransaction(
        transaction,
        createFirebaseDatabaseCollections(firestore),
      );
      const database = staged.database;
      await expect(
        database.findOne({
          model: "channels",
          where: [{ field: "id", value: channel.id }],
          select: ["id"],
        }),
      ).resolves.toEqual(channel);
      await expect(
        database.findOne({
          model: "bundles",
          where: [{ field: "id", value: bundle.id }],
          select: ["platform"],
        }),
      ).resolves.toEqual(bundle);
      const reference = {
        model: "releases" as const,
        where: [{ field: "bundle_id" as const, value: bundle.id }],
        select: ["id" as const],
      };
      await expect(database.findOne(reference)).resolves.toEqual({
        id: release("a").id,
      });
      await database.delete({
        model: "releases",
        where: [{ field: "id", value: release("a").id }],
      });
      await expect(database.findOne(reference)).resolves.toEqual({
        id: release("b").id,
      });
      await database.delete({
        model: "releases",
        where: [{ field: "id", value: release("b").id }],
      });
      await expect(database.findOne(reference)).resolves.toBeNull();
      await database.create({ model: "releases", data: release("c") });
      await expect(
        database.findOne({
          model: "releases",
          where: [{ field: "channel_id", value: channel.id }],
          select: ["id"],
        }),
      ).resolves.toEqual({ id: release("c").id });
      staged.persist();
    });
    await expect(
      plugin.models.releases.findById(release("a").id),
    ).resolves.toBeNull();
    await expect(
      plugin.models.releases.findById(release("b").id),
    ).resolves.toBeNull();
    await expect(
      plugin.models.releases.findById(release("c").id),
    ).resolves.toEqual(release("c"));
  });
  it("allows old parent deletion after moving a release ID and protects its new parents", async () => {
    const plugin = firebaseDatabase({});
    const newChannel = { id: "replacement-channel", name: "preview" };
    const newBundle = { ...bundle, id: "replacement-bundle" };
    const original = release("a");
    const moved = {
      ...original,
      bundle_id: newBundle.id,
      channel_id: newChannel.id,
      scope_key: "replacement-scope",
    };
    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: channel,
            onConflict: "ignore",
          },
          {
            model: "channels",
            operation: "insert",
            row: newChannel,
            onConflict: "ignore",
          },
          { model: "bundles", operation: "insert", row: bundle },
          { model: "bundles", operation: "insert", row: newBundle },
          { model: "releases", operation: "insert", row: original },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(
      plugin.commit({
        changes: [
          {
            model: "releases",
            operation: "delete",
            where: { id: original.id },
          },
          { model: "releases", operation: "insert", row: moved },
          { model: "bundles", operation: "delete", where: { id: bundle.id } },
          { model: "channels", operation: "delete", where: { id: channel.id } },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(plugin.models.bundles.findById(bundle.id)).resolves.toBeNull();
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [newChannel],
    });
    await expect(plugin.models.releases.findById(original.id)).resolves.toEqual(
      moved,
    );
    for (const change of [
      {
        model: "bundles" as const,
        operation: "delete" as const,
        where: { id: newBundle.id },
      },
      {
        model: "channels" as const,
        operation: "delete" as const,
        where: { id: newChannel.id },
      },
    ])
      await expect(plugin.commit({ changes: [change] })).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 0, reason: "referenced" },
      });
  });
});
