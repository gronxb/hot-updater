import type { DatabaseChange, DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundleRowFixture,
  createChannelRowFixture,
} from "./databaseTestFixtures";

type BundleTestState = DatabasePluginTestState<DatabasePlugin>;

const commit = (plugin: DatabasePlugin, ...changes: DatabaseChange[]) =>
  plugin.commit({ changes });

const insertBundle = (plugin: DatabasePlugin, suffix: string) => {
  const row = createBundleRowFixture(suffix);
  const channel = createChannelRowFixture(row.channel);
  return {
    row,
    result: commit(
      plugin,
      {
        model: "channels",
        operation: "insert",
        row: channel,
        onConflict: "ignore",
      },
      { model: "bundles", operation: "insert", row },
    ),
  };
};

export const registerDatabasePluginBundleTests = (
  state: BundleTestState,
): void => {
  describe("bundles table", () => {
    it("inserts and finds a bundle row by id", async () => {
      const plugin = state.getPlugin();
      const { row, result } = insertBundle(plugin, "1");

      await expect(result).resolves.toEqual({ committed: true });
      await expect(plugin.models.bundles.findById(row.id)).resolves.toEqual(
        row,
      );
    });

    it("updates explicit false, null, and empty-array values", async () => {
      const plugin = state.getPlugin();
      const { row, result } = insertBundle(plugin, "2");
      await result;

      await expect(
        commit(plugin, {
          model: "bundles",
          operation: "update",
          where: { id: row.id },
          update: { enabled: false, message: null, target_cohorts: [] },
        }),
      ).resolves.toEqual({ committed: true });
      await expect(
        plugin.models.bundles.findById(row.id),
      ).resolves.toMatchObject({
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
        await plugin.models.channels.insert({
          row: createChannelRowFixture(row.channel),
          onConflict: "returnExisting",
        });
        await commit(plugin, {
          model: "bundles",
          operation: "insert",
          row,
        });
      }

      await expect(
        plugin.models.bundles.findMany({
          where: { enabled: true },
          limit: 1,
          offset: 1,
          orderBy: { field: "id", direction: "asc" },
        }),
      ).resolves.toEqual([rows[2]]);
      await expect(
        plugin.models.bundles.count({ enabled: true }),
      ).resolves.toBe(2);
    });

    it("returns an indexed conflict when an update target is missing", async () => {
      await expect(
        commit(state.getPlugin(), {
          model: "bundles",
          operation: "update",
          where: { id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
          update: { enabled: false },
        }),
      ).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 0, reason: "not_found" },
      });
    });

    it("deletes one bundle by id without a generic predicate", async () => {
      const plugin = state.getPlugin();
      const first = insertBundle(plugin, "41");
      const second = insertBundle(plugin, "42");
      await Promise.all([first.result, second.result]);

      await commit(plugin, {
        model: "bundles",
        operation: "delete",
        where: { id: first.row.id },
      });

      await expect(
        plugin.models.bundles.findById(first.row.id),
      ).resolves.toBeNull();
      await expect(
        plugin.models.bundles.findById(second.row.id),
      ).resolves.toEqual(second.row);
    });

    it("rejects duplicate bundle ids", async () => {
      const plugin = state.getPlugin();
      const first = insertBundle(plugin, "51");
      await first.result;

      await expect(
        commit(plugin, {
          model: "bundles",
          operation: "insert",
          row: first.row,
        }),
      ).rejects.toThrow();
    });
  });
};
