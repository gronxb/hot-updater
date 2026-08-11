import { NIL_UUID } from "@hot-updater/core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  createBundlePatchRowFixture,
  createBundleRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { setupDatabasePluginTestSuite } from "../../../test-utils/src/setupDatabasePluginTestSuite";
import { mongoAdapter } from "./mongodb";
import { createMongoBundleWhere } from "./mongodbQuery";
import { createMongoTestHarness } from "./mongodbTestClient";

const harness = createMongoTestHarness();

setupDatabasePluginTestSuite({
  name: "mongoAdapter v2",
  migrate: () => undefined,
  createPlugin: () =>
    mongoAdapter({ client: harness.client, transactions: true }),
  reset: () => harness.reset(),
  dispose: () => harness.close(),
});

describe("mongoAdapter capabilities", () => {
  it("returns an adapter without an unsafe atomic-batch fallback", () => {
    const plugin = mongoAdapter({ client: harness.client });
    expect(plugin.name).toBe("mongodb");
    expect(plugin.adapterName).toBe("mongodb");
    expect(plugin.provider).toBe("mongodb");
    expect(plugin.commitBatch).toBeUndefined();
    expect(Reflect.has(plugin, "transaction")).toBe(false);
  });

  it("rejects a cross-table commit when transactions are disabled", async () => {
    const plugin = mongoAdapter({ client: harness.client });
    const owner = createBundleRowFixture("970");
    const patch = createBundlePatchRowFixture(
      "971",
      owner.id,
      createBundleRowFixture("972").id,
    );

    await expect(
      plugin.commit({
        operation: "insert",
        bundleId: owner.id,
        changes: [
          { table: "bundles", operation: "insert", row: owner },
          { table: "bundle_patches", operation: "insert", row: patch },
        ],
      }),
    ).rejects.toMatchObject({ name: "DatabaseAtomicCommitUnsupportedError" });
  });

  it("recovers a tombstoned bundle when an aggregate delete is retried", async () => {
    harness.reset();
    const client = createDatabaseClient(
      mongoAdapter({ client: harness.client }),
    );
    const bundle = {
      id: "bundle-retry",
      platform: "ios" as const,
      shouldForceUpdate: false,
      enabled: true,
      fileHash: "bundle-retry-hash",
      gitCommitHash: null,
      message: null,
      channel: "production",
      storageUri: "storage://bundle-retry",
      targetAppVersion: "1.0.0",
      fingerprintHash: null,
    };
    await client.insertBundle(bundle);

    harness.failNextBundleTombstone();
    await expect(client.deleteBundleById(bundle.id)).rejects.toThrow(
      "injected tombstone failure",
    );
    await expect(client.deleteBundleById(bundle.id)).resolves.toBeUndefined();
    await expect(client.insertBundle(bundle)).resolves.toBeUndefined();
    await expect(client.getBundleById(bundle.id)).resolves.toMatchObject({
      id: bundle.id,
      channel: "production",
    });
  });

  it("rejects malformed stored rows in the update-info fast path", async () => {
    harness.reset();
    const plugin = mongoAdapter({ client: harness.client });
    const row = createBundleRowFixture("972");
    await plugin.commit({
      operation: "insert",
      bundleId: row.id,
      changes: [{ table: "bundles", operation: "insert", row }],
    });
    harness.setBundleField(row.id, "should_force_update", "false");
    const getUpdateInfo = plugin.getUpdateInfo;
    if (getUpdateInfo === undefined) throw new Error("fast path unavailable");

    await expect(
      getUpdateInfo({
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      }),
    ).rejects.toThrow("Invalid MongoDB plugin data");
  });
});

describe("MongoDB low-level predicate translation", () => {
  it("composes connectors left to right", () => {
    expect(
      createMongoBundleWhere([
        { field: "id", value: "first" },
        { field: "id", value: "second", connector: "OR" },
        { field: "enabled", value: true, connector: "AND" },
      ]),
    ).toEqual({
      $and: [
        {
          $or: [
            { $expr: { $eq: ["$id", { $literal: "first" }] } },
            { $expr: { $eq: ["$id", { $literal: "second" }] } },
          ],
        },
        { $expr: { $eq: ["$enabled", { $literal: true }] } },
      ],
    });
  });

  it("escapes insensitive string patterns", () => {
    expect(
      createMongoBundleWhere([
        {
          field: "message",
          operator: "contains",
          value: "release.*",
          mode: "insensitive",
        },
      ]),
    ).toEqual({
      $expr: {
        $regexMatch: {
          input: { $ifNull: ["$message", ""] },
          regex: { $literal: "release\\.\\*" },
          options: "i",
        },
      },
    });
  });

  it("preserves empty set semantics", () => {
    expect(
      createMongoBundleWhere([{ field: "id", operator: "in", value: [] }]),
    ).toEqual({ $expr: { $in: ["$id", { $literal: [] }] } });
    expect(
      createMongoBundleWhere([{ field: "id", operator: "not_in", value: [] }]),
    ).toEqual({
      $expr: { $not: [{ $in: ["$id", { $literal: [] }] }] },
    });
  });
});
