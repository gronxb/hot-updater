import type { Bundle } from "@hot-updater/core";
import {
  createDatabaseClient,
  type DatabasePlugin,
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

const createAdapter = (): DatabasePlugin =>
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
  capabilities: { getUpdateInfo: true, transaction: true },
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
          data: { id: "rollback" },
        });
        throw new Error("rollback fixture");
      }),
    ).rejects.toThrow("rollback fixture");

    await expect(
      adapter.findOne({
        model: "channels",
        where: [{ field: "id", value: "rollback" }],
      }),
    ).resolves.toBeNull();
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
