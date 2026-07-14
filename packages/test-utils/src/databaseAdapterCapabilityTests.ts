import { NIL_UUID } from "@hot-updater/core";
import {
  type DatabaseAdapter,
  resolveUpdateInfoFromBundles,
  rowToBundle,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabaseAdapterTestState } from "./databaseAdapterTestRunner";
import {
  createBundleRowFixture,
  createChannelRowFixture,
} from "./databaseTestFixtures";

type CapabilityTestState<TContext> = DatabaseAdapterTestState<
  DatabaseAdapter<TContext>,
  TContext
>;

class TransactionFixtureError extends Error {
  constructor() {
    super("rollback fixture");
    this.name = "TransactionFixtureError";
  }
}

export const registerDatabaseAdapterCapabilityTests = <TContext>(
  state: CapabilityTestState<TContext>,
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
        await transaction.create({
          model: "channels",
          data: createChannelRowFixture("production"),
        });
        await transaction.create({ model: "bundles", data: bundle });
        return "committed" as const;
      }, state.context);

      expect(result).toBe("committed");
      await expect(
        adapter.findOne(
          {
            model: "bundles",
            where: [{ field: "id", value: bundle.id }],
          },
          state.context,
        ),
      ).resolves.toEqual(bundle);
    });

    it("rolls back when the transaction callback rejects", async (context) => {
      const adapter = state.getAdapter();
      if (adapter.transaction === undefined) {
        context.skip();
        return;
      }
      expect(adapter.transaction).toBeTypeOf("function");

      await expect(
        adapter.transaction(async (transaction) => {
          await transaction.create({
            model: "channels",
            data: createChannelRowFixture("rollback"),
          });
          throw new TransactionFixtureError();
        }, state.context),
      ).rejects.toBeInstanceOf(TransactionFixtureError);
      await expect(
        adapter.findOne(
          {
            model: "channels",
            where: [{ field: "id", value: "channel-rollback" }],
          },
          state.context,
        ),
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
      await adapter.create(
        {
          model: "channels",
          data: createChannelRowFixture("production"),
        },
        state.context,
      );
      await adapter.create({ model: "bundles", data: bundle }, state.context);

      const args = {
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      } as const;
      const update = await adapter.getUpdateInfo(args, state.context);
      const genericUpdate = await resolveUpdateInfoFromBundles({
        args,
        bundles: [rowToBundle(bundle, "production")],
      });

      expect(update).toEqual(genericUpdate);
    });
  });
};
