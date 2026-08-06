import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import { createBundleRowFixture } from "./databaseTestFixtures";

type BundleTestState = DatabasePluginTestState<DatabasePlugin>;

export const registerDatabasePluginBundleTests = (
  state: BundleTestState,
): void => {
  describe("bundles", () => {
    it("creates a row and returns only selected fields", async () => {
      const bundle = createBundleRowFixture("1");

      const created = await state
        .getPlugin()
        .create({ model: "bundles", data: bundle, select: ["id", "channel"] });

      expect(created).toEqual({
        id: bundle.id,
        channel: bundle.channel,
      });
      await expect(
        state.getPlugin().findOne({
          model: "bundles",
          where: [{ field: "id", value: bundle.id }],
        }),
      ).resolves.toEqual(bundle);
    });

    it("returns null when no bundle matches", async () => {
      await expect(
        state.getPlugin().findOne({
          model: "bundles",
          where: [
            {
              field: "id",
              value: "ffffffff-ffff-ffff-ffff-ffffffffffff",
            },
          ],
        }),
      ).resolves.toBeNull();
    });

    it("updates explicit false, null, and empty-array values", async () => {
      const bundle = createBundleRowFixture("2");
      await state.getPlugin().create({ model: "bundles", data: bundle });

      const updated = await state.getPlugin().update({
        model: "bundles",
        where: [{ field: "id", value: bundle.id }],
        update: { enabled: false, message: null, target_cohorts: [] },
      });

      expect(updated).toMatchObject({
        id: bundle.id,
        enabled: false,
        message: null,
        target_cohorts: [],
      });
      expect(updated?.file_hash).toBe(bundle.file_hash);
    });

    it("filters, orders, offsets, and limits before returning rows", async () => {
      const first = { ...createBundleRowFixture("11"), enabled: false };
      const second = createBundleRowFixture("12", "staging");
      const third = createBundleRowFixture("13");
      for (const bundle of [first, second, third]) {
        await state.getPlugin().create({ model: "bundles", data: bundle });
      }

      const rows = await state.getPlugin().findMany({
        model: "bundles",
        where: [
          { field: "enabled", value: true },
          {
            field: "channel",
            value: "staging",
            operator: "ne",
            connector: "AND",
          },
        ],
        sortBy: { field: "id", direction: "desc" },
        offset: 0,
        limit: 1,
      });

      expect(rows).toEqual([third]);
    });

    it("uses the same predicates for count", async () => {
      const enabled = createBundleRowFixture("21");
      const disabled = { ...createBundleRowFixture("22"), enabled: false };
      for (const bundle of [enabled, disabled]) {
        await state.getPlugin().create({ model: "bundles", data: bundle });
      }

      await expect(
        state.getPlugin().count({
          model: "bundles",
          where: [{ field: "enabled", value: false }],
        }),
      ).resolves.toBe(1);
    });

    it("treats an empty in predicate as matching no rows", async () => {
      await state
        .getPlugin()
        .create({ model: "bundles", data: createBundleRowFixture("31") });

      await expect(
        state.getPlugin().findMany({
          model: "bundles",
          where: [{ field: "id", value: [], operator: "in" }],
        }),
      ).resolves.toEqual([]);
    });

    it("deletes every matching bundle row", async () => {
      for (const suffix of ["41", "42"]) {
        await state
          .getPlugin()
          .create({ model: "bundles", data: createBundleRowFixture(suffix) });
      }

      await state.getPlugin().delete({
        model: "bundles",
        where: [{ field: "channel", value: "production" }],
      });

      await expect(
        state.getPlugin().findMany({ model: "bundles" }),
      ).resolves.toEqual([]);
    });

    it("rejects duplicate bundle ids", async () => {
      const bundle = createBundleRowFixture("51");
      await state.getPlugin().create({ model: "bundles", data: bundle });

      await expect(
        state.getPlugin().create({ model: "bundles", data: bundle }),
      ).rejects.toThrow();
    });
  });
};
