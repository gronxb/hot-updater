import type { DatabaseChange, DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import { createBundleRowFixture } from "./databaseTestFixtures";

type QueryTestState = DatabasePluginTestState<DatabasePlugin>;

const commit = (plugin: DatabasePlugin, ...changes: DatabaseChange[]) =>
  plugin.commit({ changes });

const seedRows = async (plugin: DatabasePlugin) => {
  const rows = [
    createBundleRowFixture("501"),
    createBundleRowFixture("502"),
    {
      ...createBundleRowFixture("503"),
      platform: "android" as const,
    },
  ];
  for (const row of rows) {
    await commit(plugin, {
      model: "bundles",
      operation: "insert",
      row,
    });
  }
  return rows;
};

export const registerDatabasePluginQueryTests = (
  state: QueryTestState,
): void => {
  describe("bundle access patterns", () => {
    it("supports the id range used by cursor and update queries", async () => {
      const plugin = state.getPlugin();
      const rows = await seedRows(plugin);

      const result = await plugin.models.bundles.findMany({
        where: { id: { gte: rows[1]!.id, lt: rows[2]!.id } },
        limit: 100,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      });

      expect(result.map(({ id }) => id)).toEqual([rows[1]!.id]);
    });

    it("supports the artifact platform filter", async () => {
      const plugin = state.getPlugin();
      const rows = await seedRows(plugin);

      await expect(
        plugin.models.bundles.findMany({
          where: {
            platform: "ios",
          },
          limit: 100,
          offset: 0,
          orderBy: { field: "id", direction: "asc" },
        }),
      ).resolves.toEqual([rows[0], rows[1]]);
    });

    it("supports id sets for patch hydration", async () => {
      const plugin = state.getPlugin();
      const rows = await seedRows(plugin);

      const result = await plugin.models.bundles.findMany({
        where: { id: { in: [rows[0]!.id, rows[2]!.id] } },
        limit: 100,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      });

      expect(result.map(({ id }) => id)).toEqual([rows[0]!.id, rows[2]!.id]);
    });

    it("returns an empty page for an empty id set", async () => {
      await expect(
        state.getPlugin().models.bundles.findMany({
          where: { id: { in: [] } },
          limit: 100,
          offset: 0,
          orderBy: { field: "id", direction: "asc" },
        }),
      ).resolves.toEqual([]);
    });
  });
};
