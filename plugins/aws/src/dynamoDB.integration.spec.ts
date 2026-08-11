import { createDatabaseClient } from "@hot-updater/plugin-core";
import {
  setupDatabasePluginTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DynamoDBIntegrationFixture } from "./dynamoDB.integration-fixture";

const fixture = new DynamoDBIntegrationFixture();
const createPlugin = () => fixture.createPlugin();
const clearTable = () => fixture.reset();

beforeAll(() => fixture.start(), 120_000);
afterAll(() => fixture.stop());

setupDatabasePluginTestSuite({
  name: "DynamoDB fixed-model database plugin",
  createPlugin,
  migrate: () => undefined,
  reset: clearTable,
  dispose: () => undefined,
});

setupGetUpdateInfoTestSuite({
  getUpdateInfo: async (bundles, args) => {
    await clearTable();
    const plugin = createPlugin();
    const database = createDatabaseClient(plugin);
    for (const bundle of bundles) await database.insertBundle(bundle);
    if (!plugin.getUpdateInfo) {
      throw new Error("DynamoDB database plugin has no update-check fast path");
    }
    return plugin.getUpdateInfo(args);
  },
});

describe("DynamoDB aggregate mutations", () => {
  beforeEach(clearTable);

  it("atomically inserts and replaces bundle patches", async () => {
    const database = createDatabaseClient(createPlugin());
    const baseBundle = {
      id: "00000000-0000-0000-0000-000000000901",
      platform: "ios",
      shouldForceUpdate: false,
      enabled: true,
      fileHash: "base-hash",
      gitCommitHash: null,
      message: "base",
      channel: "production",
      storageUri: "storage://base.zip",
      targetAppVersion: "1.0.0",
      fingerprintHash: null,
      metadata: {},
    } as const;
    const bundle = {
      ...baseBundle,
      id: "00000000-0000-0000-0000-000000000902",
      fileHash: "bundle-hash",
      patches: [
        {
          baseBundleId: baseBundle.id,
          baseFileHash: baseBundle.fileHash,
          patchFileHash: "first-patch-hash",
          patchStorageUri: "storage://first.patch",
        },
      ],
    };
    await database.insertBundle(baseBundle);

    await database.insertBundle(bundle);
    await database.updateBundleById(bundle.id, {
      patches: [
        {
          baseBundleId: baseBundle.id,
          baseFileHash: baseBundle.fileHash,
          patchFileHash: "replacement-patch-hash",
          patchStorageUri: "storage://replacement.patch",
        },
      ],
    });

    await expect(database.getBundleById(bundle.id)).resolves.toMatchObject({
      patches: [
        {
          baseBundleId: baseBundle.id,
          patchFileHash: "replacement-patch-hash",
        },
      ],
    });
  });
});
