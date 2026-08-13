import type { LegacyBundle } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import {
  createDatabasePlugin,
  createDatabasePluginAdapter,
} from "./createDatabasePlugin";
import { createDatabaseClient } from "./databaseClient";
import { loadBundleRows } from "./databaseClientReads";
import { createMemoryDatabasePlugin } from "./databasePluginMemory.testFixtures";
import type { BundleRow } from "./types";

const createBundle = (id: string): LegacyBundle => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: id,
  channel: "production",
  storageUri: `storage://${id}`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
});

describe("database client pagination", () => {
  it("loads a finite bundle id set with one domain query", async () => {
    const row = bundlesRow(createBundle("001"));
    const findMany = vi.fn(async () => [row]);
    const adapter = createDatabasePluginAdapter("finite-id-memory", {
      create: async () => row,
      update: async () => row,
      delete: async () => {},
      count: async () => 1,
      findOne: async () => row,
      findMany,
      insertChannel: async (input) => ({ row: input.row, inserted: true }),
      deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
    });
    const plugin = createDatabasePlugin({
      name: "finite-id-memory",
      ...adapter,
    });

    await expect(
      loadBundleRows(plugin, { id: { in: ["001", "002"] } }),
    ).resolves.toEqual([row]);
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, offset: 0 }),
    );
  });

  it("hydrates only the selected bundle row", async () => {
    const plugin = createMemoryDatabasePlugin();
    const client = createDatabaseClient(plugin);
    for (const id of ["001", "002", "003"]) {
      await client.insertBundle(createBundle(id));
    }
    const findPatches = vi.spyOn(
      plugin.models.bundlePatches,
      "findByBundleIds",
    );

    const page = await client.getBundles({
      limit: 1,
      orderBy: { field: "id", direction: "desc" },
    });

    expect(page.data.map(({ id }) => id)).toEqual(["003"]);
    expect(findPatches).toHaveBeenCalledOnce();
    expect(findPatches).toHaveBeenCalledWith(["003"]);
  });

  it("pushes a one-row owner page into the provider for 1,001 bundles", async () => {
    const bundles = Array.from({ length: 1_001 }, (_, index) => ({
      id: `bundle-${String(index).padStart(4, "0")}`,
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: `hash-${index}`,
      git_commit_hash: null,
      message: null,
      channel: `release-${index}`,
      channel_id: `channel-${index}`,
      storage_uri: `storage://bundle-${index}.zip`,
      target_app_version: "1.0.0",
      fingerprint_hash: null,
      metadata: {},
      rollout_cohort_count: 1000,
      target_cohorts: null,
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    }));
    const ownerQueries: unknown[] = [];
    const name = "channel-pagination";
    const plugin = createDatabasePlugin({
      name,
      ...createDatabasePluginAdapter(name, {
        create: async () => {
          throw new Error("not implemented");
        },
        update: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        count: async () => bundles.length,
        findOne: async () => null,
        findMany: async (input) => {
          if (input.model === "bundles") ownerQueries.push(input);
          const rows =
            input.model === "bundles"
              ? input.orderBy?.[0]?.direction === "desc"
                ? bundles.toReversed()
                : bundles
              : [];
          return rows.slice(input.offset, input.offset + input.limit);
        },
        insertChannel: async (input) => ({ row: input.row, inserted: true }),
        deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
      }),
    });

    const result = await createDatabaseClient(plugin).getBundles({
      limit: 1,
      orderBy: { field: "id", direction: "desc" },
    });

    expect(ownerQueries).toEqual([
      expect.objectContaining({
        model: "bundles",
        limit: 1,
        offset: 0,
        orderBy: [{ field: "id", direction: "desc" }],
      }),
    ]);
    expect(result.data.map(({ id }) => id)).toEqual(["bundle-1000"]);
    expect(result.pagination.total).toBe(1_001);
  });

  it("scans the captured bundle cutoff once when an insert moves order", async () => {
    const capturedRows: BundleRow[] = Array.from({ length: 150 }, (_, index) =>
      bundlesRow(createBundle(String(index).padStart(3, "0"))),
    );
    let inserted = false;
    const name = "moving-pagination";
    const plugin = createDatabasePlugin({
      name,
      ...createDatabasePluginAdapter(name, {
        create: async () => {
          throw new Error("not implemented");
        },
        update: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        count: async () => capturedRows.length,
        findOne: async () => null,
        findMany: async (input) => {
          if (input.model !== "bundles") return [];
          const idFilters = (input.where ?? []).filter(
            ({ field }) => field === "id",
          );
          const candidates = capturedRows.filter((row) =>
            idFilters.every(({ operator, value }) => {
              if (typeof value !== "string") return true;
              if (operator === "gt") return row.id > value;
              if (operator === "lte") return row.id <= value;
              return true;
            }),
          );
          const ordered =
            input.orderBy?.[0]?.direction === "desc"
              ? candidates.toReversed()
              : candidates;
          const page = ordered.slice(input.offset, input.offset + input.limit);
          if (!inserted && page.length === 100) {
            inserted = true;
            capturedRows.unshift(bundlesRow(createBundle("-01")));
          }
          return page;
        },
        insertChannel: async (input) => ({ row: input.row, inserted: true }),
        deleteChannel: async () => ({ deleted: false, reason: "not_found" }),
      }),
    });

    const rows = await loadBundleRows(plugin);

    expect(rows).toHaveLength(150);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(150);
    expect(rows.map(({ id }) => id)).not.toContain("-01");
    expect(rows.at(-1)?.id).toBe("149");
  });
});

const bundlesRow = (bundle: LegacyBundle): BundleRow => ({
  id: bundle.id,
  platform: bundle.platform,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash,
  storage_uri: bundle.storageUri,
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});
