import type { Bundle } from "@hot-updater/core";
import {
  createDatabaseClient,
  type BundleRow,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  setupDatabaseAdapterTestSuite,
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
  data.channels.clear();
};

const createAdapter = (): DatabaseAdapter =>
  mockDatabase({ data, latency: DEFAULT_LATENCY });

beforeEach(() => {
  resetData();
});

data = createMockDatabaseData();

setupDatabaseAdapterTestSuite({
  name: "mock database adapter v2",
  createAdapter,
  migrate: () => undefined,
  reset: resetData,
  dispose: () => undefined,
  capabilities: { transaction: true },
});

setupDatabaseClientTestSuite({
  name: "mock database aggregate client",
  createAdapter,
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: resetData,
  dispose: () => undefined,
});

setupGetUpdateInfoTestSuite({
  getUpdateInfo: async (bundles, args) => {
    resetData();
    const adapter = createAdapter();
    const client = createDatabaseClient(adapter);
    for (const bundle of bundles) {
      await client.insertBundle(bundle);
    }
    return adapter.getUpdateInfo?.(args) ?? null;
  },
});

describe("mock database provider", () => {
  it("rolls back all fixed-model changes when a transaction rejects", async () => {
    const adapter = createAdapter();

    await expect(
      adapter.transaction?.(async (transaction) => {
        await transaction.create({
          model: "channels",
          data: { id: "channel-rollback", name: "rollback" },
        });
        throw new Error("rollback fixture");
      }),
    ).rejects.toThrow("rollback fixture");

    await expect(
      adapter.findOne({
        model: "channels",
        where: [{ field: "id", value: "channel-rollback" }],
      }),
    ).resolves.toBeNull();
  });

  it("rejects duplicate channel names", async () => {
    const adapter = createAdapter();
    await adapter.create({
      model: "channels",
      data: { id: "channel-production", name: "production" },
    });

    await expect(
      adapter.create({
        model: "channels",
        data: { id: "channel-production-copy", name: "production" },
      }),
    ).rejects.toMatchObject({
      constraint: "channels.name.unique",
    });
  });

  it("rejects bundles whose channel id does not exist", async () => {
    const adapter = createAdapter();
    const bundle = {
      id: "00000000-0000-0000-0000-000000000001",
      platform: "ios",
      should_force_update: false,
      enabled: true,
      file_hash: "hash",
      git_commit_hash: null,
      message: null,
      channel_id: "missing-channel",
      storage_uri: "storage://bundle.zip",
      target_app_version: "1.0.0",
      fingerprint_hash: null,
      metadata: {},
      rollout_cohort_count: 1000,
      target_cohorts: null,
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    } satisfies BundleRow;

    await expect(
      adapter.create({ model: "bundles", data: bundle }),
    ).rejects.toMatchObject({
      constraint: "bundles.channel_id.foreign-key",
    });
  });

  it("runs the update hook once after an aggregate mutation", async () => {
    const onDatabaseUpdated = vi.fn(async () => undefined);
    const adapter = mockDatabase(
      { data, latency: DEFAULT_LATENCY },
      { onDatabaseUpdated },
    );
    const bundle: Bundle = {
      id: "00000000-0000-0000-0000-000000000001",
      platform: "ios",
      shouldForceUpdate: false,
      enabled: true,
      fileHash: "hash",
      gitCommitHash: null,
      message: null,
      channel: "production",
      storageUri: "storage://bundle.zip",
      targetAppVersion: "1.0.0",
      fingerprintHash: null,
    };

    await createDatabaseClient(adapter).insertBundle(bundle);

    expect(onDatabaseUpdated).toHaveBeenCalledTimes(1);
  });
});
