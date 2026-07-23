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
  data.bundleEvents.clear();
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
  it("rolls back all fixed-model changes when a transaction rejects", async () => {
    const plugin = createPlugin();

    await expect(
      plugin.transaction?.(async (transaction) => {
        await transaction.create({
          model: "bundles",
          data: {
            id: "bundle-rollback",
            platform: "ios",
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
          },
        });
        throw new Error("rollback fixture");
      }),
    ).rejects.toThrow("rollback fixture");

    await expect(
      plugin.findOne({
        model: "bundles",
        where: [{ field: "id", value: "bundle-rollback" }],
      }),
    ).resolves.toBeNull();
  });
});
