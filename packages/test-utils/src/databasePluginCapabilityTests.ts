import { NIL_UUID } from "@hot-updater/core";
import {
  type DatabasePlugin,
  resolveUpdateInfoFromBundles,
  rowToBundle,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import { createBundleRowFixture } from "./databaseTestFixtures";

type CapabilityTestState = DatabasePluginTestState<DatabasePlugin>;

class TransactionFixtureError extends Error {
  constructor() {
    super("rollback fixture");
    this.name = "TransactionFixtureError";
  }
}

export const registerDatabasePluginCapabilityTests = (
  state: CapabilityTestState,
): void => {
  describe("optional capabilities", () => {
    it("commits transaction writes and returns the callback value", async (context) => {
      const plugin = state.getPlugin();
      if (plugin.transaction === undefined) {
        context.skip();
        return;
      }
      expect(plugin.transaction).toBeTypeOf("function");
      const bundle = createBundleRowFixture("91");

      const result = await plugin.transaction(async (transaction) => {
        await transaction.create({ model: "bundles", data: bundle });
        return "committed" as const;
      });

      expect(result).toBe("committed");
      await expect(
        plugin.findOne({
          model: "bundles",
          where: [{ field: "id", value: bundle.id }],
        }),
      ).resolves.toEqual(bundle);
    });

    it("rolls back when the transaction callback rejects", async (context) => {
      const plugin = state.getPlugin();
      if (plugin.transaction === undefined) {
        context.skip();
        return;
      }
      expect(plugin.transaction).toBeTypeOf("function");
      const bundle = createBundleRowFixture("92", "rollback");

      await expect(
        plugin.transaction(async (transaction) => {
          await transaction.create({ model: "bundles", data: bundle });
          throw new TransactionFixtureError();
        }),
      ).rejects.toBeInstanceOf(TransactionFixtureError);
      await expect(
        plugin.findOne({
          model: "bundles",
          where: [{ field: "id", value: bundle.id }],
        }),
      ).resolves.toBeNull();
    });

    it("matches the generic update resolver through the fast path", async (context) => {
      const plugin = state.getPlugin();
      if (plugin.getUpdateInfo === undefined) {
        context.skip();
        return;
      }
      expect(plugin.getUpdateInfo).toBeTypeOf("function");
      const bundle = createBundleRowFixture("99");
      await plugin.create({ model: "bundles", data: bundle });

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
