import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "./databaseTestFixtures";

type RelationTestState = DatabasePluginTestState<DatabasePlugin>;

const insertRow = (plugin: DatabasePlugin, suffix: string) => {
  const row = createBundleRowFixture(suffix);
  return plugin
    .commit({
      operation: "insert",
      bundleId: row.id,
      changes: [{ table: "bundles", operation: "insert", row }],
    })
    .then(() => row);
};

export const registerDatabasePluginRelationTests = (
  state: RelationTestState,
): void => {
  describe("bundle_patches table", () => {
    it("commits bundle and patch rows together but reads them separately", async () => {
      const plugin = state.getPlugin();
      const base = await insertRow(plugin, "61");
      const owner = createBundleRowFixture("62");
      const patch = createBundlePatchRowFixture("71", owner.id, base.id, 1);

      await expect(
        plugin.commit({
          operation: "insert",
          bundleId: owner.id,
          changes: [
            { table: "bundles", operation: "insert", row: owner },
            { table: "bundle_patches", operation: "insert", row: patch },
          ],
        }),
      ).resolves.toEqual({ applied: true });
      await expect(plugin.bundles.findById(owner.id)).resolves.toEqual(owner);
      await expect(
        plugin.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toEqual([patch]);
      await expect(
        plugin.bundlePatches.findByBundleIds([base.id]),
      ).resolves.toEqual([]);
    });

    it("rejects missing owner and base bundle references atomically", async () => {
      const plugin = state.getPlugin();
      const owner = createBundleRowFixture("81");
      const patch = createBundlePatchRowFixture(
        "82",
        owner.id,
        "ffffffff-ffff-ffff-ffff-fffffffffff2",
      );

      await expect(
        plugin.commit({
          operation: "insert",
          bundleId: owner.id,
          changes: [
            { table: "bundles", operation: "insert", row: owner },
            { table: "bundle_patches", operation: "insert", row: patch },
          ],
        }),
      ).rejects.toThrow();
      await expect(plugin.bundles.findById(owner.id)).resolves.toBeNull();
    });

    it("cascades patch deletion from either referenced bundle", async () => {
      const plugin = state.getPlugin();
      const base = await insertRow(plugin, "91");
      const owner = createBundleRowFixture("92");
      const patch = createBundlePatchRowFixture("93", owner.id, base.id);
      await plugin.commit({
        operation: "insert",
        bundleId: owner.id,
        changes: [
          { table: "bundles", operation: "insert", row: owner },
          { table: "bundle_patches", operation: "insert", row: patch },
        ],
      });

      await plugin.commit({
        operation: "delete",
        bundleId: base.id,
        changes: [{ table: "bundles", operation: "delete", id: base.id }],
      });

      await expect(
        plugin.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toEqual([]);
      await expect(plugin.bundles.findById(owner.id)).resolves.toEqual(owner);
    });
  });

  describe("channel aggregate", () => {
    it("returns distinct sorted channels when the provider has a fast path", async (context) => {
      const plugin = state.getPlugin();
      if (plugin.getChannels === undefined) {
        context.skip();
        return;
      }
      for (const row of [
        createBundleRowFixture("51", "staging"),
        createBundleRowFixture("52", "production"),
        createBundleRowFixture("53", "staging"),
      ]) {
        await plugin.commit({
          operation: "insert",
          bundleId: row.id,
          changes: [{ table: "bundles", operation: "insert", row }],
        });
      }

      await expect(plugin.getChannels()).resolves.toEqual([
        "production",
        "staging",
      ]);
    });
  });
};
