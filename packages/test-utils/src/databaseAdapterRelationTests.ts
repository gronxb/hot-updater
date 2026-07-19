import type { DatabaseAdapter } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabaseAdapterTestState } from "./databaseAdapterTestRunner";
import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "./databaseTestFixtures";

type RelationTestState = DatabaseAdapterTestState<DatabaseAdapter>;

const seedBundlePair = async (
  state: RelationTestState,
): Promise<readonly [string, string]> => {
  const base = createBundleRowFixture("61");
  const target = createBundleRowFixture("62");
  await state.getAdapter().create({ model: "bundles", data: base });
  await state.getAdapter().create({ model: "bundles", data: target });
  return [base.id, target.id];
};

export const registerDatabaseAdapterRelationTests = (
  state: RelationTestState,
): void => {
  describe("channel aggregate", () => {
    it("returns distinct sorted channels from bundles", async (context) => {
      const adapter = state.getAdapter();
      if (adapter.getChannels === undefined) {
        context.skip();
        return;
      }
      for (const bundle of [
        createBundleRowFixture("51", "staging"),
        createBundleRowFixture("52", "production"),
        createBundleRowFixture("53", "staging"),
      ]) {
        await adapter.create({ model: "bundles", data: bundle });
      }

      await expect(adapter.getChannels()).resolves.toEqual([
        "production",
        "staging",
      ]);
    });
  });

  describe("bundle_patches", () => {
    it("creates, orders, selects, and deletes patch rows", async () => {
      const [baseId, targetId] = await seedBundlePair(state);
      const second = createBundlePatchRowFixture("72", targetId, baseId, 2);
      const first = createBundlePatchRowFixture("71", targetId, baseId, 1);
      for (const patch of [second, first]) {
        await state
          .getAdapter()
          .create({ model: "bundle_patches", data: patch });
      }

      const rows = await state.getAdapter().findMany({
        model: "bundle_patches",
        where: [{ field: "bundle_id", value: targetId }],
        select: ["id", "order_index"],
        orderBy: [{ field: "order_index", direction: "asc" }],
      });
      expect(rows).toEqual([
        { id: first.id, order_index: 1 },
        { id: second.id, order_index: 2 },
      ]);

      await state.getAdapter().delete({
        model: "bundle_patches",
        where: [{ field: "bundle_id", value: targetId }],
      });
      await expect(
        state.getAdapter().findMany({ model: "bundle_patches" }),
      ).resolves.toEqual([]);
    });

    it("rejects missing owner and base bundle references", async () => {
      const [baseId, targetId] = await seedBundlePair(state);
      const missingOwner = createBundlePatchRowFixture(
        "81",
        "ffffffff-ffff-ffff-ffff-fffffffffff1",
        baseId,
      );
      const missingBase = createBundlePatchRowFixture(
        "82",
        targetId,
        "ffffffff-ffff-ffff-ffff-fffffffffff2",
      );

      await expect(
        state
          .getAdapter()
          .create({ model: "bundle_patches", data: missingOwner }),
      ).rejects.toThrow();
      await expect(
        state
          .getAdapter()
          .create({ model: "bundle_patches", data: missingBase }),
      ).rejects.toThrow();
    });

    it("deletes patches whose base bundle is deleted", async () => {
      const [baseId, targetId] = await seedBundlePair(state);
      const patch = createBundlePatchRowFixture("91", targetId, baseId);
      await state.getAdapter().create({ model: "bundle_patches", data: patch });

      await state.getAdapter().delete({
        model: "bundles",
        where: [{ field: "id", value: baseId }],
      });

      await expect(
        state.getAdapter().findMany({ model: "bundle_patches" }),
      ).resolves.toEqual([]);
      await expect(
        state.getAdapter().findOne({
          model: "bundles",
          where: [{ field: "id", value: targetId }],
        }),
      ).resolves.not.toBeNull();
    });

    it("deletes patches whose owner bundle is deleted", async () => {
      const [baseId, targetId] = await seedBundlePair(state);
      const patch = createBundlePatchRowFixture("92", targetId, baseId);
      await state.getAdapter().create({ model: "bundle_patches", data: patch });

      await state.getAdapter().delete({
        model: "bundles",
        where: [{ field: "id", value: targetId }],
      });

      await expect(
        state.getAdapter().findMany({ model: "bundle_patches" }),
      ).resolves.toEqual([]);
      await expect(
        state.getAdapter().findOne({
          model: "bundles",
          where: [{ field: "id", value: baseId }],
        }),
      ).resolves.not.toBeNull();
    });
  });
};
