import { describe, expect, it } from "vitest";

import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  createBlobDatabaseAdapter,
} from "./createBlobDatabaseAdapter";
import { createDatabaseClient } from "./databaseClient";

const bundleId = "00000000-0000-0000-0000-000000000001";
const commonBundleRow = {
  id: bundleId,
  platform: "ios" as const,
  should_force_update: false,
  enabled: true,
  file_hash: "hash-1",
  git_commit_hash: null,
  message: "bundle-1",
  storage_uri: "storage://bundles/1.zip",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
};

describe("blob snapshot compatibility", () => {
  it("reads and rewrites the pre-normalization v2 shape", async () => {
    // Given
    const store = new Map<string, unknown>([
      [
        BLOB_DATABASE_SNAPSHOT_KEY,
        {
          version: 2,
          bundles: [{ ...commonBundleRow, channel: "production" }],
          bundle_patches: [],
          channels: [{ id: "production" }],
        },
      ],
    ]);
    const adapter = createBlobDatabaseAdapter({
      name: "compatibility-memory",
      adapter: () => ({
        apiBasePath: "/api/check-update",
        listObjects: async (prefix) =>
          [...store.keys()].filter((key) => key.startsWith(prefix)),
        loadObject: async (key) => store.get(key) ?? null,
        uploadObject: async (key, value) => void store.set(key, value),
        invalidatePaths: async () => undefined,
      }),
    });

    // When
    const bundle = await createDatabaseClient(adapter).getBundleById(bundleId);
    await adapter.create({
      model: "channels",
      data: { id: "channel-staging", name: "staging" },
    });

    // Then
    expect(bundle?.channel).toBe("production");
    expect(store.get(BLOB_DATABASE_SNAPSHOT_KEY)).toEqual({
      version: 2,
      bundles: [{ ...commonBundleRow, channel_id: "production" }],
      bundle_patches: [],
      channels: [
        { id: "channel-staging", name: "staging" },
        { id: "production", name: "production" },
      ],
    });
  });
});
