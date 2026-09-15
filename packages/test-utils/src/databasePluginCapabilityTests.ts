import {
  type DatabasePlugin,
  type DatabaseChange,
  MAX_BUNDLE_ARTIFACT_BYTES,
  MAX_BUNDLE_PATCHES,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
  createChannelRowFixture,
  createApiKeyRowFixture,
  createReleaseRowFixture,
} from "./databaseTestFixtures";

type CapabilityTestState = DatabasePluginTestState<DatabasePlugin>;

const commit = (plugin: DatabasePlugin, ...changes: DatabaseChange[]) =>
  plugin.commit({ changes });

export const registerDatabasePluginCapabilityTests = (
  state: CapabilityTestState,
): void => {
  describe("database commit boundary", () => {
    it("does not expose callback transactions or superseded flat members", () => {
      const plugin = state.getPlugin();
      expect(Object.keys(plugin.models).sort()).toEqual(
        [
          "insights",
          "bundlePatches",
          "bundles",
          "channels",
          "apiKeys",
          "releaseCatalogs",
          "releases",
        ].sort(),
      );
      expect(Reflect.has(plugin, "queries")).toBe(false);
      expect(Reflect.has(plugin, "transaction")).toBe(false);
      for (const member of [
        "bundles",
        "bundlePatches",
        "channels",
        "insights",
        "apiKeys",
        "getChannels",
        "getUpdateInfo",
      ]) {
        expect(Reflect.has(plugin, member)).toBe(false);
      }
    });

    it("atomically inserts every commit model", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("production");
      const base = createBundleRowFixture("86");
      const bundle = createBundleRowFixture("87");
      const patch = createBundlePatchRowFixture("87", bundle.id, base.id);
      const apiKey = createApiKeyRowFixture("87", 100);

      await expect(
        commit(
          plugin,
          {
            model: "channels",
            operation: "insert",
            row: channel,
            onConflict: "ignore",
          },
          { model: "bundles", operation: "insert", row: base },
          { model: "bundles", operation: "insert", row: bundle },
          { model: "bundlePatches", operation: "insert", row: patch },
          {
            model: "apiKeys",
            operation: "insert",
            row: apiKey,
            onConflict: "ignore",
          },
        ),
      ).resolves.toEqual({ committed: true });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
      await expect(
        plugin.models.bundlePatches.findByBundleIds([bundle.id]),
      ).resolves.toEqual([patch]);
      await expect(
        plugin.models.apiKeys.findByHash(apiKey.hash),
      ).resolves.toEqual(apiKey);
    });

    it("atomically publishes, reorders, and replaces bundle patches", async () => {
      const plugin = state.getPlugin();
      const publish = plugin.models.bundlePatches.publish;
      if (!publish) {
        throw new Error(
          `Database plugin "${plugin.name}" does not support atomic patch publication`,
        );
      }
      const firstBase = createBundleRowFixture("90");
      const secondBase = createBundleRowFixture("91");
      const owner = createBundleRowFixture("92");
      await commit(
        plugin,
        { model: "bundles", operation: "insert", row: firstBase },
        { model: "bundles", operation: "insert", row: secondBase },
        { model: "bundles", operation: "insert", row: owner },
      );
      const { order_index: _firstOrder, ...firstPatchFixture } =
        createBundlePatchRowFixture("90", owner.id, firstBase.id);
      const firstPatch = {
        ...firstPatchFixture,
        id: `${owner.id}:${firstBase.id}`,
      };
      const { order_index: _secondOrder, ...secondPatchFixture } =
        createBundlePatchRowFixture("91", owner.id, secondBase.id);
      const secondPatch = {
        ...secondPatchFixture,
        id: `${owner.id}:${secondBase.id}`,
      };

      await expect(
        publish({
          position: "primary",
          row: firstPatch,
        }),
      ).resolves.toEqual({
        patches: [{ ...firstPatch, order_index: 0 }],
        previous: null,
        published: true,
      });
      await expect(
        publish({
          position: "last",
          row: secondPatch,
        }),
      ).resolves.toMatchObject({
        patches: [
          { id: firstPatch.id, order_index: 0 },
          { id: secondPatch.id, order_index: 1 },
        ],
        previous: null,
        published: true,
      });

      const replacement = {
        ...secondPatch,
        patch_file_hash: "d".repeat(64),
        patch_storage_uri: "storage://replacement-patch",
      };
      const result = await publish({
        position: "primary",
        row: replacement,
      });
      expect(result).toMatchObject({
        patches: [
          { id: secondPatch.id, order_index: 0 },
          { id: firstPatch.id, order_index: 1 },
        ],
        previous: secondPatch,
        published: true,
      });
      const persisted = await plugin.models.bundlePatches.findByBundleIds([
        owner.id,
      ]);
      expect(
        [...persisted].sort(
          (left, right) => left.order_index - right.order_index,
        ),
      ).toEqual(result.published ? result.patches : expect.unreachable());
    });

    it("enforces the shared bundle patch limit without replacing existing rows", async () => {
      const plugin = state.getPlugin();
      const publish = plugin.models.bundlePatches.publish;
      if (!publish) {
        throw new Error(
          `Database plugin "${plugin.name}" does not support atomic patch publication`,
        );
      }
      const owner = createBundleRowFixture("8000");
      const bases = Array.from({ length: MAX_BUNDLE_PATCHES + 1 }, (_, index) =>
        createBundleRowFixture(String(8100 + index)),
      );
      for (const row of [owner, ...bases]) {
        await commit(plugin, { model: "bundles", operation: "insert", row });
      }
      for (const [index, base] of bases
        .slice(0, MAX_BUNDLE_PATCHES)
        .entries()) {
        const { order_index: _orderIndex, ...fixture } =
          createBundlePatchRowFixture(String(8200 + index), owner.id, base.id);
        await expect(
          publish({
            position: "last",
            row: { ...fixture, id: `${owner.id}:${base.id}` },
          }),
        ).resolves.toMatchObject({ published: true });
      }

      const overflowBase = bases[MAX_BUNDLE_PATCHES]!;
      const { order_index: _orderIndex, ...overflowFixture } =
        createBundlePatchRowFixture("8399", owner.id, overflowBase.id);
      await expect(
        publish({
          position: "last",
          row: {
            ...overflowFixture,
            id: `${owner.id}:${overflowBase.id}`,
          },
        }),
      ).resolves.toEqual({ published: false, reason: "limit_exceeded" });
      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toHaveLength(MAX_BUNDLE_PATCHES);

      const firstBase = bases[0]!;
      const { order_index: _replacementOrderIndex, ...replacementFixture } =
        createBundlePatchRowFixture("8400", owner.id, firstBase.id);
      await expect(
        publish({
          position: "primary",
          row: {
            ...replacementFixture,
            id: `${owner.id}:${firstBase.id}`,
          },
        }),
      ).resolves.toMatchObject({
        patches: expect.arrayContaining([
          expect.objectContaining({
            id: `${owner.id}:${firstBase.id}`,
            order_index: 0,
            patch_file_hash: replacementFixture.patch_file_hash,
          }),
        ]),
        published: true,
      });
      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toHaveLength(MAX_BUNDLE_PATCHES);
    });

    it("rejects self-referencing bundle patches before mutation", async () => {
      const plugin = state.getPlugin();
      const publish = plugin.models.bundlePatches.publish;
      if (!publish) {
        throw new Error(
          `Database plugin "${plugin.name}" does not support atomic patch publication`,
        );
      }
      const owner = createBundleRowFixture("8500");
      await commit(plugin, {
        model: "bundles",
        operation: "insert",
        row: owner,
      });
      const { order_index: _orderIndex, ...fixture } =
        createBundlePatchRowFixture("8500", owner.id, owner.id);

      await expect(
        publish({
          position: "primary",
          row: { ...fixture, id: `${owner.id}:${owner.id}` },
        }),
      ).rejects.toThrow();
      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toEqual([]);
    });

    it("rejects noncanonical and oversized patch rows before mutation", async () => {
      const plugin = state.getPlugin();
      const publish = plugin.models.bundlePatches.publish;
      if (!publish) {
        throw new Error(
          `Database plugin "${plugin.name}" does not support atomic patch publication`,
        );
      }
      const owner = createBundleRowFixture("8510");
      const base = createBundleRowFixture("8511");
      await commit(
        plugin,
        { model: "bundles", operation: "insert", row: owner },
        { model: "bundles", operation: "insert", row: base },
      );
      const valid = createBundlePatchRowFixture("8510", owner.id, base.id);
      const { order_index: _orderIndex, ...publishRow } = valid;

      await expect(
        publish({
          position: "primary",
          row: { ...publishRow, patch_file_hash: "malformed" },
        }),
      ).rejects.toThrow();
      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toEqual([]);

      for (const row of [
        { ...valid, id: "alternate-id" },
        { ...valid, byte_size: MAX_BUNDLE_ARTIFACT_BYTES + 1 },
        { ...valid, base_file_hash: "malformed" },
        { ...valid, patch_file_hash: "malformed" },
      ]) {
        await expect(
          commit(plugin, {
            model: "bundlePatches",
            operation: "insert",
            row,
          }),
        ).rejects.toThrow();
        await expect(
          plugin.models.bundlePatches.findByBundleIds([owner.id]),
        ).resolves.toEqual([]);
      }
    });

    it("atomically enforces the patch cap for bulk replacement and deletion", async () => {
      const plugin = state.getPlugin();
      const owner = createBundleRowFixture("8600");
      const oldBases = Array.from({ length: MAX_BUNDLE_PATCHES }, (_, index) =>
        createBundleRowFixture(String(8601 + index)),
      );
      const newBases = Array.from({ length: MAX_BUNDLE_PATCHES }, (_, index) =>
        createBundleRowFixture(String(8701 + index)),
      );
      const overflowBase = createBundleRowFixture("8800");
      await expect(
        plugin.commit({
          changes: [owner, ...oldBases, ...newBases, overflowBase].map(
            (row) => ({ model: "bundles", operation: "insert", row }),
          ),
        }),
      ).resolves.toEqual({ committed: true });
      const oldPatches = oldBases.map((base, index) =>
        createBundlePatchRowFixture(String(8601 + index), owner.id, base.id),
      );
      await expect(
        plugin.commit({
          changes: oldPatches.map((row) => ({
            model: "bundlePatches",
            operation: "insert",
            row,
          })),
        }),
      ).resolves.toEqual({ committed: true });

      const overflowPatch = createBundlePatchRowFixture(
        "8800",
        owner.id,
        overflowBase.id,
      );
      await expect(
        plugin.commit({
          changes: [
            {
              model: "bundlePatches",
              operation: "insert",
              row: overflowPatch,
            },
          ],
        }),
      ).rejects.toThrow();
      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toHaveLength(MAX_BUNDLE_PATCHES);

      const newPatches = newBases.map((base, index) =>
        createBundlePatchRowFixture(String(8701 + index), owner.id, base.id),
      );
      await expect(
        plugin.commit({
          changes: [
            {
              model: "bundlePatches",
              operation: "delete",
              where: { bundleId: owner.id },
            },
            ...newPatches.map((row) => ({
              model: "bundlePatches" as const,
              operation: "insert" as const,
              row,
            })),
          ],
        }),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toEqual(newPatches);

      await expect(
        plugin.commit({
          changes: [
            { model: "bundles", operation: "delete", where: { id: owner.id } },
          ],
        }),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.models.bundles.findById(owner.id),
      ).resolves.toBeNull();
      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toEqual([]);
    });

    it("rejects deleting a base referenced by many patch owners", async () => {
      const plugin = state.getPlugin();
      const publish = plugin.models.bundlePatches.publish;
      if (!publish) {
        throw new Error(
          `Database plugin "${plugin.name}" does not support atomic patch publication`,
        );
      }
      const base = createBundleRowFixture("8900");
      const owners = Array.from(
        { length: MAX_BUNDLE_PATCHES + 1 },
        (_, index) => createBundleRowFixture(String(8901 + index)),
      );
      await expect(
        plugin.commit({
          changes: [base, ...owners].map((row) => ({
            model: "bundles",
            operation: "insert",
            row,
          })),
        }),
      ).resolves.toEqual({ committed: true });
      for (const [index, owner] of owners.entries()) {
        const { order_index: _orderIndex, ...row } =
          createBundlePatchRowFixture(String(8901 + index), owner.id, base.id);
        await expect(
          publish({
            position: "primary",
            row: { ...row, id: `${owner.id}:${base.id}` },
          }),
        ).resolves.toMatchObject({ published: true });
      }

      await expect(
        plugin.commit({
          changes: [
            { model: "bundles", operation: "delete", where: { id: base.id } },
          ],
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 0, reason: "referenced" },
      });
      await expect(plugin.models.bundles.findById(base.id)).resolves.toEqual(
        base,
      );
      await expect(
        plugin.models.bundlePatches.findByBundleIds(owners.map(({ id }) => id)),
      ).resolves.toHaveLength(MAX_BUNDLE_PATCHES + 1);
    });

    it("treats supported conflict-ignored inserts as idempotent", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("preview");
      const apiKey = createApiKeyRowFixture("88", 100);
      const changes = [
        {
          model: "channels",
          operation: "insert",
          row: channel,
          onConflict: "ignore",
        },
        {
          model: "apiKeys",
          operation: "insert",
          row: apiKey,
          onConflict: "ignore",
        },
      ] as const satisfies readonly DatabaseChange[];

      await expect(plugin.commit({ changes })).resolves.toEqual({
        committed: true,
      });
      await expect(plugin.commit({ changes })).resolves.toEqual({
        committed: true,
      });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
      await expect(plugin.models.apiKeys.list()).resolves.toEqual([apiKey]);
    });

    it("atomically updates bundle and API key models", async () => {
      const plugin = state.getPlugin();
      const bundle = createBundleRowFixture("89");
      const apiKey = createApiKeyRowFixture("89", 100);
      await commit(
        plugin,
        { model: "bundles", operation: "insert", row: bundle },
        {
          model: "apiKeys",
          operation: "insert",
          row: apiKey,
          onConflict: "ignore",
        },
      );

      await expect(
        commit(
          plugin,
          {
            model: "bundles",
            operation: "update",
            where: { id: bundle.id },
            update: { storage_uri: "storage://bundles/89-updated.zip" },
          },
          {
            model: "apiKeys",
            operation: "update",
            where: { id: apiKey.id },
            update: { revokedAtMs: 200 },
          },
        ),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.models.bundles.findById(bundle.id),
      ).resolves.toMatchObject({
        storage_uri: "storage://bundles/89-updated.zip",
      });
      await expect(
        plugin.models.apiKeys.findByHash(apiKey.hash),
      ).resolves.toEqual({ ...apiKey, revoked_at_ms: 200 });
    });

    it("accepts an empty atomic commit", async () => {
      await expect(state.getPlugin().commit({ changes: [] })).resolves.toEqual({
        committed: true,
      });
    });

    it("deletes an empty channel through the generic commit boundary", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("commit-delete");
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });

      await expect(
        commit(plugin, {
          model: "channels",
          operation: "delete",
          where: { id: channel.id },
        }),
      ).resolves.toEqual({ committed: true });
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
    });

    it("treats a missing generic channel delete as idempotent", async () => {
      await expect(
        commit(state.getPlugin(), {
          model: "channels",
          operation: "delete",
          where: { id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
        }),
      ).resolves.toEqual({ committed: true });
    });

    it("deletes an artifact and an independent empty channel atomically", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("retired");
      const bundle = createBundleRowFixture("90", channel.name);
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await commit(plugin, {
        model: "bundles",
        operation: "insert",
        row: bundle,
      });

      await expect(
        commit(
          plugin,
          {
            model: "bundles",
            operation: "delete",
            where: { id: bundle.id },
          },
          {
            model: "channels",
            operation: "delete",
            where: { id: channel.id },
          },
        ),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.models.bundles.findById(bundle.id),
      ).resolves.toBeNull();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
    });

    it("returns an indexed Release-referenced channel conflict and rolls back prior changes", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("protected");
      const bundle = createBundleRowFixture("96", channel.name);
      await plugin.models.channels.insert({
        row: channel,
        onConflict: "returnExisting",
      });
      await commit(plugin, {
        model: "bundles",
        operation: "insert",
        row: bundle,
      });
      const release = createReleaseRowFixture("96", bundle, channel);
      await commit(plugin, {
        model: "releases",
        operation: "insert",
        row: release,
      });

      await expect(
        commit(
          plugin,
          {
            model: "bundles",
            operation: "update",
            where: { id: bundle.id },
            update: { storage_uri: "storage://bundles/96-updated.zip" },
          },
          {
            model: "channels",
            operation: "delete",
            where: { id: channel.id },
          },
        ),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 1, reason: "referenced" },
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
    });

    it("rolls back an atomic commit when a later mutation violates a relation", async () => {
      const plugin = state.getPlugin();
      const first = createBundleRowFixture("91");
      const second = createBundleRowFixture("92");
      const invalidPatch = createBundlePatchRowFixture(
        "93",
        second.id,
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
      );
      const apiKey = createApiKeyRowFixture("93", 100);

      await expect(
        plugin.commit({
          changes: [
            {
              model: "channels",
              operation: "insert",
              row: createChannelRowFixture("production"),
              onConflict: "ignore",
            },
            { model: "bundles", operation: "insert", row: first },
            { model: "bundles", operation: "insert", row: second },
            {
              model: "apiKeys",
              operation: "insert",
              row: apiKey,
              onConflict: "ignore",
            },
            {
              model: "bundlePatches",
              operation: "insert",
              row: invalidPatch,
            },
          ],
        }),
      ).rejects.toThrow();
      await expect(
        plugin.models.bundles.findById(first.id),
      ).resolves.toBeNull();
      await expect(
        plugin.models.bundles.findById(second.id),
      ).resolves.toBeNull();
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [],
      });
      await expect(
        plugin.models.apiKeys.findByHash(apiKey.hash),
      ).resolves.toBeNull();
    });

    it("rejects a Release that references a missing channel", async () => {
      const plugin = state.getPlugin();
      const channel = createChannelRowFixture("production");
      const bundle = createBundleRowFixture("95");
      await commit(plugin, {
        model: "bundles",
        operation: "insert",
        row: bundle,
      });
      const release = createReleaseRowFixture("95", bundle, channel);

      await expect(
        commit(plugin, {
          model: "releases",
          operation: "insert",
          row: release,
        }),
      ).rejects.toThrow();
      await expect(
        plugin.models.releases.findById(release.id),
      ).resolves.toBeNull();
    });

    it("rolls back earlier changes when a later update conflicts", async () => {
      const plugin = state.getPlugin();
      const bundle = createBundleRowFixture("94");
      const apiKey = createApiKeyRowFixture("94", 100);
      await commit(
        plugin,
        { model: "bundles", operation: "insert", row: bundle },
        {
          model: "apiKeys",
          operation: "insert",
          row: apiKey,
          onConflict: "ignore",
        },
      );

      await expect(
        commit(
          plugin,
          {
            model: "bundles",
            operation: "update",
            where: { id: bundle.id },
            update: { storage_uri: "storage://bundles/94-updated.zip" },
          },
          {
            model: "apiKeys",
            operation: "update",
            where: { id: "missing-key" },
            update: { revokedAtMs: 200 },
          },
        ),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 1, reason: "not_found" },
      });
      await expect(plugin.models.bundles.findById(bundle.id)).resolves.toEqual(
        bundle,
      );
      await expect(
        plugin.models.apiKeys.findByHash(apiKey.hash),
      ).resolves.toEqual(apiKey);
    });
  });
};
