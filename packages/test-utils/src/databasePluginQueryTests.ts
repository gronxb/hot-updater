import type {
  DatabaseBundleMutation,
  DatabasePlugin,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import { createBundleRowFixture } from "./databaseTestFixtures";

type QueryTestState = DatabasePluginTestState<DatabasePlugin>;

const commit = (plugin: DatabasePlugin, mutation: DatabaseBundleMutation) =>
  plugin.commit({ mutations: [mutation] });

const seedRows = async (plugin: DatabasePlugin) => {
  const rows = [
    {
      ...createBundleRowFixture("501"),
      target_app_version: null,
      fingerprint_hash: "fingerprint-501",
    },
    createBundleRowFixture("502", "preview"),
    {
      ...createBundleRowFixture("503"),
      platform: "android" as const,
      target_app_version: "2.0.0",
    },
  ];
  for (const row of rows) {
    await commit(plugin, {
      operation: "insert",
      bundleId: row.id,
      changes: [{ table: "bundles", operation: "insert", row }],
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

      const result = await plugin.bundles.findMany({
        where: { id: { gte: rows[1]!.id, lt: rows[2]!.id } },
        limit: 100,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      });

      expect(result.map(({ id }) => id)).toEqual([rows[1]!.id]);
    });

    it("supports exact domain filters without arbitrary field predicates", async () => {
      const plugin = state.getPlugin();
      const rows = await seedRows(plugin);

      await expect(
        plugin.bundles.findMany({
          where: {
            channel: "production",
            platform: "ios",
            enabled: true,
            fingerprintHash: "fingerprint-501",
          },
          limit: 100,
          offset: 0,
          orderBy: { field: "id", direction: "asc" },
        }),
      ).resolves.toEqual([rows[0]]);
      await expect(
        plugin.bundles.findMany({
          where: { targetAppVersionNotNull: true },
          limit: 100,
          offset: 0,
          orderBy: { field: "id", direction: "asc" },
        }),
      ).resolves.toEqual([rows[1], rows[2]]);
    });

    it("supports id sets for patch hydration", async () => {
      const plugin = state.getPlugin();
      const rows = await seedRows(plugin);

      const result = await plugin.bundles.findMany({
        where: { id: { in: [rows[0]!.id, rows[2]!.id] } },
        limit: 100,
        offset: 0,
        orderBy: { field: "id", direction: "asc" },
      });

      expect(result.map(({ id }) => id)).toEqual([rows[0]!.id, rows[2]!.id]);
    });

    it("returns an empty page for an empty id set", async () => {
      await expect(
        state.getPlugin().bundles.findMany({
          where: { id: { in: [] } },
          limit: 100,
          offset: 0,
          orderBy: { field: "id", direction: "asc" },
        }),
      ).resolves.toEqual([]);
    });
  });
};
