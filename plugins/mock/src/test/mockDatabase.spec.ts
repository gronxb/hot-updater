import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  setupDatabasePluginTestSuite,
  setupDatabaseClientTestSuite,
  setupGetUpdateInfoTestSuite,
} from "../../../../packages/test-utils/src/index";
import {
  createMockDatabaseData,
  mockDatabase,
  type MockDatabaseData,
} from "../mockDatabase";

const DEFAULT_LATENCY = { min: 0, max: 0 } as const;

let data: MockDatabaseData;

const resetData = (): void => {
  data.bundles.clear();
  data.bundlePatches.clear();
};

const createPlugin = (): DatabasePlugin =>
  mockDatabase({ data, latency: DEFAULT_LATENCY });

beforeEach(() => {
  resetData();
});

data = createMockDatabaseData();

setupDatabasePluginTestSuite({
  name: "mock fixed-model database plugin",
  createPlugin,
  migrate: () => undefined,
  reset: resetData,
  dispose: () => undefined,
});

setupDatabaseClientTestSuite({
  name: "mock database aggregate client",
  createPlugin,
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: resetData,
  dispose: () => undefined,
});

setupGetUpdateInfoTestSuite({
  getUpdateInfo: async (bundles, args) => {
    resetData();
    const plugin = createPlugin();
    const client = createDatabaseClient(plugin);
    for (const bundle of bundles) {
      await client.insertBundle(bundle);
    }
    return plugin.getUpdateInfo?.(args) ?? null;
  },
});

describe("mock database provider", () => {
  it("rolls back all table changes when an atomic batch rejects", async () => {
    const plugin = createPlugin();
    const row = {
      id: "bundle-rollback",
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: "hash",
      git_commit_hash: null,
      message: null,
      channel: "rollback",
      storage_uri: "storage://bundle.zip",
      target_app_version: "1.0.0",
      fingerprint_hash: null,
      metadata: {},
      rollout_cohort_count: 1000,
      target_cohorts: null,
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    };
    if (plugin.commitBatch === undefined) {
      throw new Error("mock database must support atomic batches");
    }

    await expect(
      plugin.commitBatch([
        {
          operation: "insert",
          bundleId: row.id,
          changes: [{ table: "bundles", operation: "insert", row }],
        },
        {
          operation: "insert",
          bundleId: "invalid-owner",
          changes: [
            {
              table: "bundle_patches",
              operation: "insert",
              row: {
                id: "invalid-patch",
                bundle_id: "invalid-owner",
                base_bundle_id: row.id,
                base_file_hash: row.file_hash,
                patch_file_hash: "patch-hash",
                patch_storage_uri: "storage://patch",
                order_index: 0,
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow("foreign-key");

    await expect(plugin.bundles.findById(row.id)).resolves.toBeNull();
  });
});
