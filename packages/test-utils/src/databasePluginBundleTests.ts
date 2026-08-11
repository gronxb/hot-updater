import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import { createBundleRowFixture } from "./databaseTestFixtures";

type BundleTestState = DatabasePluginTestState<DatabasePlugin>;

const insertBundle = (plugin: DatabasePlugin, suffix: string) => {
  const row = createBundleRowFixture(suffix);
  return {
    row,
    result: plugin.commit({
      operation: "insert",
      bundleId: row.id,
      changes: [{ table: "bundles", operation: "insert", row }],
    }),
  };
};

export const registerDatabasePluginBundleTests = (
  state: BundleTestState,
): void => {
  describe("bundles table", () => {
    it("inserts and finds a bundle row by id", async () => {
      const plugin = state.getPlugin();
      const { row, result } = insertBundle(plugin, "1");

      await expect(result).resolves.toEqual({ applied: true });
      await expect(plugin.bundles.findById(row.id)).resolves.toEqual(row);
    });

    it("updates explicit false, null, and empty-array values", async () => {
      const plugin = state.getPlugin();
      const { row, result } = insertBundle(plugin, "2");
      await result;

      await expect(
        plugin.commit({
          operation: "update",
          bundleId: row.id,
          changes: [
            {
              table: "bundles",
              operation: "update",
              id: row.id,
              update: { enabled: false, message: null, target_cohorts: [] },
            },
          ],
        }),
      ).resolves.toEqual({ applied: true });
      await expect(plugin.bundles.findById(row.id)).resolves.toMatchObject({
        id: row.id,
        enabled: false,
        message: null,
        target_cohorts: [],
        file_hash: row.file_hash,
      });
    });

    it("filters, orders, offsets, limits, and counts bundle rows", async () => {
      const plugin = state.getPlugin();
      const rows = [
        { ...createBundleRowFixture("11"), enabled: false },
        createBundleRowFixture("12", "staging"),
        createBundleRowFixture("13"),
      ];
      for (const row of rows) {
        await plugin.commit({
          operation: "insert",
          bundleId: row.id,
          changes: [{ table: "bundles", operation: "insert", row }],
        });
      }

      await expect(
        plugin.bundles.findMany({
          where: { enabled: true },
          limit: 1,
          offset: 1,
          orderBy: { field: "id", direction: "asc" },
        }),
      ).resolves.toEqual([rows[2]]);
      await expect(plugin.bundles.count({ enabled: true })).resolves.toBe(2);
    });

    it("returns applied false when an update target is missing", async () => {
      await expect(
        state.getPlugin().commit({
          operation: "update",
          bundleId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          changes: [],
        }),
      ).resolves.toEqual({ applied: false });
    });

    it("deletes one bundle by id without a generic predicate", async () => {
      const plugin = state.getPlugin();
      const first = insertBundle(plugin, "41");
      const second = insertBundle(plugin, "42");
      await Promise.all([first.result, second.result]);

      await plugin.commit({
        operation: "delete",
        bundleId: first.row.id,
        changes: [{ table: "bundles", operation: "delete", id: first.row.id }],
      });

      await expect(plugin.bundles.findById(first.row.id)).resolves.toBeNull();
      await expect(plugin.bundles.findById(second.row.id)).resolves.toEqual(
        second.row,
      );
    });

    it("rejects duplicate bundle ids", async () => {
      const plugin = state.getPlugin();
      const first = insertBundle(plugin, "51");
      await first.result;

      await expect(
        plugin.commit({
          operation: "insert",
          bundleId: first.row.id,
          changes: [{ table: "bundles", operation: "insert", row: first.row }],
        }),
      ).rejects.toThrow();
    });
  });
};
