import { NIL_UUID } from "@hot-updater/core";
import {
  type DatabasePlugin,
  type DatabaseBundleMutation,
  resolveUpdateInfoFromBundles,
  rowToBundle,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "./databaseTestFixtures";

type CapabilityTestState = DatabasePluginTestState<DatabasePlugin>;

const commit = (plugin: DatabasePlugin, mutation: DatabaseBundleMutation) =>
  plugin.commit({ mutations: [mutation] });

export const registerDatabasePluginCapabilityTests = (
  state: CapabilityTestState,
): void => {
  describe("optional capabilities", () => {
    it("does not expose callback-scoped transactions", () => {
      expect(Reflect.has(state.getPlugin(), "transaction")).toBe(false);
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

      await expect(
        plugin.commit({
          mutations: [
            {
              operation: "insert",
              bundleId: first.id,
              changes: [{ table: "bundles", operation: "insert", row: first }],
            },
            {
              operation: "insert",
              bundleId: second.id,
              changes: [
                { table: "bundles", operation: "insert", row: second },
                {
                  table: "bundle_patches",
                  operation: "insert",
                  row: invalidPatch,
                },
              ],
            },
          ],
        }),
      ).rejects.toThrow();
      await expect(plugin.bundles.findById(first.id)).resolves.toBeNull();
      await expect(plugin.bundles.findById(second.id)).resolves.toBeNull();
    });

    it("matches the generic update resolver through the fast path", async (context) => {
      const plugin = state.getPlugin();
      if (plugin.getUpdateInfo === undefined) {
        context.skip();
        return;
      }
      const bundle = createBundleRowFixture("99");
      await commit(plugin, {
        operation: "insert",
        bundleId: bundle.id,
        changes: [{ table: "bundles", operation: "insert", row: bundle }],
      });

      const args = {
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      } as const;
      const update = await plugin.getUpdateInfo(args);
      const genericUpdate = await resolveUpdateInfoFromBundles({
        args,
        bundles: [rowToBundle(bundle)],
      });

      expect(update).toEqual(genericUpdate);
    });
  });
};
