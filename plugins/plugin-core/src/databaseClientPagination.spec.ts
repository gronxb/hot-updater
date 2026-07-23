import type { Bundle } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import { createBlobDatabasePlugin } from "./createBlobDatabasePlugin";
import { createDatabasePlugin } from "./createDatabasePlugin";
import { createDatabaseClient } from "./databaseClient";
import { loadBundleRows } from "./databaseClientReads";
import type { BundleRow } from "./types";

const createBundle = (id: string): Bundle => ({
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
  it("hydrates only the selected bundle row", async () => {
    // Given
    const store = new Map<string, unknown>();
    const plugin = createBlobDatabasePlugin({
      name: "pagination-memory",
      plugin: () => ({
        apiBasePath: "/api/check-update",
        listObjects: async (prefix) =>
          [...store.keys()].filter((key) => key.startsWith(prefix)),
        loadObject: async (key) => store.get(key) ?? null,
        uploadObject: async (key, value) => void store.set(key, value),
        compareAndSwapObject: async (key, expected, value) => {
          if (
            JSON.stringify(store.get(key) ?? null) !== JSON.stringify(expected)
          ) {
            return false;
          }
          store.set(key, value);
          return true;
        },
        invalidatePaths: async () => undefined,
      }),
    });
    const client = createDatabaseClient(plugin);
    for (const id of ["001", "002", "003"]) {
      await client.insertBundle(createBundle(id));
    }
    const findMany = vi.spyOn(plugin, "findMany");

    // When
    const page = await client.getBundles({
      limit: 1,
      orderBy: { field: "id", direction: "desc" },
    });

    // Then
    const patchQueries = findMany.mock.calls.flatMap(([input]) =>
      input.model === "bundle_patches" ? [input] : [],
    );
    expect(page.data.map(({ id }) => id)).toEqual(["003"]);
    expect(patchQueries).toHaveLength(1);
    expect(patchQueries[0]?.where).toEqual([
      { field: "bundle_id", operator: "in", value: ["003"] },
    ]);
  });

  it("pushes a one-row owner page into the provider for 1,001 bundles", async () => {
    // Given
    const bundles = Array.from({ length: 1_001 }, (_, index) => ({
      id: `bundle-${String(index).padStart(4, "0")}`,
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: `hash-${index}`,
      git_commit_hash: null,
      message: null,
      channel: `release-${index}`,
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
    const plugin = createDatabasePlugin({
      name: "channel-pagination",
      plugin: () => ({
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
      }),
    });

    // When
    const result = await createDatabaseClient(plugin).getBundles({
      limit: 1,
      orderBy: { field: "id", direction: "desc" },
    });

    // Then
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
    // Given
    const capturedRows: BundleRow[] = Array.from({ length: 150 }, (_, index) =>
      bundlesRow(createBundle(String(index).padStart(3, "0"))),
    );
    let inserted = false;
    const plugin = createDatabasePlugin({
      name: "moving-pagination",
      plugin: () => ({
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
      }),
    });

    // When
    const rows = await loadBundleRows(plugin);

    // Then
    expect(rows).toHaveLength(150);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(150);
    expect(rows.map(({ id }) => id)).not.toContain("-01");
    expect(rows.at(-1)?.id).toBe("149");
  });
});

const bundlesRow = (bundle: Bundle): BundleRow => ({
  id: bundle.id,
  platform: bundle.platform,
  should_force_update: bundle.shouldForceUpdate,
  enabled: bundle.enabled,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash,
  message: bundle.message,
  channel: bundle.channel,
  storage_uri: bundle.storageUri,
  target_app_version: bundle.targetAppVersion,
  fingerprint_hash: bundle.fingerprintHash,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});
