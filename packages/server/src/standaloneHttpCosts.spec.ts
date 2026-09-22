import type { BundleModelQuery } from "@hot-updater/plugin-core";
import { startHttpTestServer } from "@hot-updater/test-utils";
import { describe, expect, it, vi } from "vitest";

import { standaloneRepository } from "../../../plugins/standalone/src";
import { createBundleRowFixture } from "../../test-utils/src/databaseTestFixtures";
import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "./createHotUpdaterCore";

// Observe model calls below the real admin HTTP boundary.
describe("Standalone HTTP read costs", () => {
  it("counts with zero row/patch reads and preserves exact owner-row windows", async () => {
    const plugin = createInMemoryDatabasePlugin();
    const api = createHotUpdater({
      database: plugin,
      clientAccess: { type: "public" },
    });
    const server = await startHttpTestServer(api.handlers);
    try {
      const history = Array.from({ length: 350 }, (_, i) =>
        createBundleRowFixture(String(i + 1)),
      );
      const seeded = await server.admin("/database/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          changes: history.map((row) => ({
            model: "bundles",
            operation: "insert",
            row,
          })),
        }),
      });
      expect(seeded.status).toBe(200);
      const remote = standaloneRepository({
        baseUrl: seeded.url.replace(/\/database\/commit$/, ""),
      });
      const findById = vi.spyOn(plugin.models.bundles, "findById");
      const findMany = vi.spyOn(plugin.models.bundles, "findMany");
      const patches = vi.spyOn(plugin.models.bundlePatches, "findByBundleIds");
      const count = vi.spyOn(plugin.models.bundles, "count");
      const where = {
        platform: "ios" as const,
        id: { in: [history[1]!.id, history[3]!.id] },
      };

      await expect(remote.models.bundles.count(where)).resolves.toBe(2);
      expect(count).toHaveBeenCalledExactlyOnceWith(where);
      expect(findById).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
      expect(patches).not.toHaveBeenCalled();
      count.mockClear();

      const query: BundleModelQuery = {
        limit: 150,
        offset: 125,
        orderBy: { field: "id", direction: "asc" },
      };
      const result = await remote.models.bundles.findMany(query);
      expect(result).toEqual(history.slice(125, 275));
      expect(
        findMany.mock.calls.map(([window]) => ({
          offset: window.offset,
          limit: window.limit,
        })),
      ).toEqual([
        { offset: 125, limit: 100 },
        { offset: 225, limit: 50 },
      ]);
      expect(
        (
          await Promise.all(findMany.mock.results.map(({ value }) => value))
        ).flat(),
      ).toHaveLength(150);
      // The aggregate bundle protocol still counts and hydrates each returned page.
      expect(count).toHaveBeenCalledTimes(2);
      expect(patches.mock.calls.map(([ids]) => ids.length)).toEqual([100, 50]);
      expect(findById).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("keeps finite ID predicates and empty comparisons identical for count and list", async () => {
    const plugin = createInMemoryDatabasePlugin();
    const api = createHotUpdater({
      database: plugin,
      clientAccess: { type: "public" },
    });
    const server = await startHttpTestServer(api.handlers);
    try {
      const rows = [
        createBundleRowFixture("1"),
        createBundleRowFixture("2"),
        { ...createBundleRowFixture("3"), platform: "android" },
      ];
      await server.admin("/database/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          changes: rows.map((row) => ({
            model: "bundles",
            operation: "insert",
            row,
          })),
        }),
      });
      const query = `platform=ios&idIn=${rows[1]!.id}&idIn=${rows[2]!.id}`;
      const count = await server.admin(`/bundles/count?${query}`);
      expect(await count.json()).toEqual({ data: { count: 1 } });
      const list = await server.admin(`/bundles?${query}&offset=0&limit=1`);
      expect(await list.json()).toMatchObject({
        data: [{ id: rows[1]!.id }],
        pagination: { total: 1 },
      });
      expect(await (await server.admin("/bundles/count?idEq=")).json()).toEqual(
        { data: { count: 0 } },
      );
      expect(await (await server.admin("/bundles?idEq=")).json()).toMatchObject(
        { data: [], pagination: { total: 0 } },
      );
    } finally {
      await server.close();
    }
  });
});
