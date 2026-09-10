import {
  createDatabaseClient,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  setupDatabasePluginTestSuite,
  setupDatabaseClientTestSuite,
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
  data.channels.clear();
  data.apiKeys.clear();
  data.releaseCatalogs.clear();
  data.releases.clear();
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

describe("mock database provider", () => {
  it("serializes concurrent channel inserts and returns the canonical row", async () => {
    const plugin = createPlugin();

    const results = await Promise.all([
      plugin.models.channels.insert({
        row: { id: "mock-channel-a", name: "production" },
        onConflict: "returnExisting",
      }),
      plugin.models.channels.insert({
        row: { id: "mock-channel-b", name: "production" },
        onConflict: "returnExisting",
      }),
    ]);

    expect(results).toEqual([
      {
        row: { id: "mock-channel-a", name: "production" },
        inserted: true,
      },
      {
        row: { id: "mock-channel-a", name: "production" },
        inserted: false,
      },
    ]);
    expect(data.channels).toEqual(
      new Map([
        ["mock-channel-a", { id: "mock-channel-a", name: "production" }],
      ]),
    );
  });

  it("rolls back all table changes when an atomic batch rejects", async () => {
    const plugin = createPlugin();
    const row = {
      id: "bundle-rollback",
      platform: "ios" as const,
      file_hash: "hash",
      git_commit_hash: null,
      storage_uri: "storage://bundle.zip",
      archive_byte_size: 3_000_000_001,
      metadata: {},
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    };
    await expect(
      plugin.commit({
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: { id: "channel-rollback", name: "rollback" },
            onConflict: "ignore",
          },
          {
            model: "bundles",
            operation: "insert",
            row,
          },
          {
            model: "bundlePatches",
            operation: "insert",
            row: {
              id: "invalid-patch",
              bundle_id: "invalid-owner",
              base_bundle_id: row.id,
              base_file_hash: row.file_hash,
              patch_file_hash: "patch-hash",
              patch_storage_uri: "storage://patch",
              byte_size: 3_000_000_002,
              order_index: 0,
            },
          },
        ],
      }),
    ).rejects.toThrow("foreign-key");

    await expect(plugin.models.bundles.findById(row.id)).resolves.toBeNull();
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
  });
});
