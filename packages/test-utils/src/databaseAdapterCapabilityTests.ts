import { NIL_UUID } from "@hot-updater/core";
import {
  type DatabaseAdapter,
  resolveUpdateInfoFromBundles,
  rowToBundle,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabaseAdapterTestState } from "./databaseAdapterTestRunner";
import { createBundleRowFixture } from "./databaseTestFixtures";

type CapabilityTestState = DatabaseAdapterTestState<DatabaseAdapter>;

class TransactionFixtureError extends Error {
  constructor() {
    super("rollback fixture");
    this.name = "TransactionFixtureError";
  }
}

export const registerDatabaseAdapterCapabilityTests = (
  state: CapabilityTestState,
): void => {
  describe("optional capabilities", () => {
    it("commits transaction writes and returns the callback value", async (context) => {
      const adapter = state.getAdapter();
      if (adapter.transaction === undefined) {
        context.skip();
        return;
      }
      expect(adapter.transaction).toBeTypeOf("function");
      const bundle = createBundleRowFixture("91");

      const result = await adapter.transaction(async (transaction) => {
        await transaction.create({ model: "bundles", data: bundle });
        return "committed" as const;
      });

      expect(result).toBe("committed");
      await expect(
        adapter.findOne({
          model: "bundles",
          where: [{ field: "id", value: bundle.id }],
        }),
      ).resolves.toEqual(bundle);
    });

    it("rolls back when the transaction callback rejects", async (context) => {
      const adapter = state.getAdapter();
      if (adapter.transaction === undefined) {
        context.skip();
        return;
      }
      expect(adapter.transaction).toBeTypeOf("function");
      const bundle = createBundleRowFixture("92", "rollback");

      await expect(
        adapter.transaction(async (transaction) => {
          await transaction.create({ model: "bundles", data: bundle });
          throw new TransactionFixtureError();
        }),
      ).rejects.toBeInstanceOf(TransactionFixtureError);
      await expect(
        adapter.findOne({
          model: "bundles",
          where: [{ field: "id", value: bundle.id }],
        }),
      ).resolves.toBeNull();
    });

    it("matches the generic update resolver through the fast path", async (context) => {
      const adapter = state.getAdapter();
      if (adapter.getUpdateInfo === undefined) {
        context.skip();
        return;
      }
      expect(adapter.getUpdateInfo).toBeTypeOf("function");
      const bundle = createBundleRowFixture("99");
      await adapter.create({ model: "bundles", data: bundle });

      const args = {
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      } as const;
      const update = await adapter.getUpdateInfo(args);
      const genericUpdate = await resolveUpdateInfoFromBundles({
        args,
        bundles: [rowToBundle(bundle)],
      });

      expect(update).toEqual(genericUpdate);
    });
  });
};
