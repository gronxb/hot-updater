import type { DatabaseChange, DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "./databaseTestFixtures";

type RelationTestState = DatabasePluginTestState<DatabasePlugin>;

const commit = (plugin: DatabasePlugin, ...changes: DatabaseChange[]) =>
  plugin.commit({ changes });

const insertRow = (plugin: DatabasePlugin, suffix: string) => {
  const row = createBundleRowFixture(suffix);
  return commit(plugin, {
    model: "bundles",
    operation: "insert",
    row,
  }).then(() => row);
};

export const registerDatabasePluginRelationTests = (
  state: RelationTestState,
): void => {
  describe("bundle_patches table", () => {
    it("hydrates multiple owners and deletes only the selected owner's patches", async () => {
      const plugin = state.getPlugin();
      const base = await insertRow(plugin, "51");
      const first = await insertRow(plugin, "52");
      const second = await insertRow(plugin, "53");
      const firstPatch = createBundlePatchRowFixture("52", first.id, base.id);
      const secondPatch = createBundlePatchRowFixture("53", second.id, base.id);
      await commit(
        plugin,
        { model: "bundlePatches", operation: "insert", row: firstPatch },
        { model: "bundlePatches", operation: "insert", row: secondPatch },
      );
      const patches = await plugin.models.bundlePatches.findByBundleIds([
        first.id,
        second.id,
      ]);
      expect([...patches].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        firstPatch,
        secondPatch,
      ]);
      await expect(
        plugin.models.bundlePatches.findByBundleIds([]),
      ).resolves.toEqual([]);
      await expect(
        commit(plugin, {
          model: "bundlePatches",
          operation: "delete",
          where: { bundleId: first.id },
        }),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.models.bundlePatches.findByBundleIds([first.id, second.id]),
      ).resolves.toEqual([secondPatch]);
      await expect(plugin.models.bundles.findById(first.id)).resolves.toEqual(
        first,
      );
    });

    it("commits bundle and patch rows together but reads them separately", async () => {
      const plugin = state.getPlugin();
      const base = await insertRow(plugin, "61");
      const owner = createBundleRowFixture("62");
      const patch = createBundlePatchRowFixture("71", owner.id, base.id, 1);

      await expect(
        commit(
          plugin,
          { model: "bundles", operation: "insert", row: owner },
          { model: "bundlePatches", operation: "insert", row: patch },
        ),
      ).resolves.toEqual({ committed: true });
      await expect(plugin.models.bundles.findById(owner.id)).resolves.toEqual(
        owner,
      );
      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toEqual([patch]);
      await expect(
        plugin.models.bundlePatches.findByBundleIds([base.id]),
      ).resolves.toEqual([]);
      if (plugin.models.bundlePatches.findByBaseBundleIds !== undefined) {
        await expect(
          plugin.models.bundlePatches.findByBaseBundleIds([base.id, base.id]),
        ).resolves.toEqual([patch]);
        await expect(
          plugin.models.bundlePatches.findByBaseBundleIds([owner.id]),
        ).resolves.toEqual([]);
      }
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
        commit(
          plugin,
          { model: "bundles", operation: "insert", row: owner },
          { model: "bundlePatches", operation: "insert", row: patch },
        ),
      ).rejects.toThrow();
      await expect(
        plugin.models.bundles.findById(owner.id),
      ).resolves.toBeNull();
    });

    it("cascades patch deletion from either referenced bundle", async () => {
      const plugin = state.getPlugin();
      const base = await insertRow(plugin, "91");
      const owner = createBundleRowFixture("92");
      const patch = createBundlePatchRowFixture("93", owner.id, base.id);
      await commit(
        plugin,
        { model: "bundles", operation: "insert", row: owner },
        { model: "bundlePatches", operation: "insert", row: patch },
      );

      await commit(plugin, {
        model: "bundles",
        operation: "delete",
        where: { id: base.id },
      });

      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toEqual([]);
      await expect(plugin.models.bundles.findById(owner.id)).resolves.toEqual(
        owner,
      );
    });
  });
};
