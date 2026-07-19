import type { Bundle } from "@hot-updater/core";
import { describe, expect, it, vi } from "vitest";

import { createBlobDatabaseAdapter } from "./createBlobDatabaseAdapter";
import { createDatabaseAdapter } from "./createDatabaseAdapter";
import { createDatabaseClient } from "./databaseClient";

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
    const adapter = createBlobDatabaseAdapter({
      name: "pagination-memory",
      adapter: () => ({
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
    const client = createDatabaseClient(adapter);
    for (const id of ["001", "002", "003"]) {
      await client.insertBundle(createBundle(id));
    }
    const findMany = vi.spyOn(adapter, "findMany");

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

  it("hydrates bundle channel values beyond the adapter default page size", async () => {
    const channels = Array.from({ length: 101 }, (_, index) => ({
      id: `channel-${index}`,
      name: `release-${index}`,
    }));
    const bundles = channels.map((channel, index) => ({
      id: `bundle-${String(index).padStart(3, "0")}`,
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: `hash-${index}`,
      git_commit_hash: null,
      message: null,
      channel: channel.name,
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
    const adapter = createDatabaseAdapter({
      name: "channel-pagination",
      adapter: () => ({
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
          const rows = input.model === "bundles" ? bundles : [];
          return rows.slice(input.offset, input.offset + input.limit);
        },
      }),
    });

    const result = await createDatabaseClient(adapter).getBundles({
      limit: 101,
      orderBy: { field: "id", direction: "asc" },
    });

    expect(result.data).toHaveLength(101);
    expect(result.data.map(({ channel }) => channel)).toEqual(
      channels.map(({ name }) => name),
    );
  });
});
