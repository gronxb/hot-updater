import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  DatabasePluginInputError,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createBundleRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { setupDatabasePluginTestSuite } from "../../../test-utils/src/setupDatabasePluginTestSuite";
import { mongoAdapter } from "./mongodb";
import { createMongoBundleWhere } from "./mongodbQuery";
import { createMongoTestHarness } from "./mongodbTestClient";

const harness = createMongoTestHarness();

setupDatabasePluginTestSuite({
  name: "mongoAdapter v2",
  migrate: () => undefined,
  createPlugin: () => mongoAdapter({ client: harness.client }),
  reset: () => harness.reset(),
  dispose: () => harness.close(),
});

describe("mongoAdapter capabilities", () => {
  it("rejects count distinct before a provider operation", async () => {
    harness.reset();
    const plugin = mongoAdapter({ client: harness.client });

    const operation = plugin.count({
      model: "bundles",
      distinct: ["channel"],
    });

    await expect(operation).rejects.toBeInstanceOf(DatabasePluginInputError);
    await expect(operation).rejects.toMatchObject({
      code: "invalid-operation",
    });
    expect(harness.getOperationCount()).toBe(0);
  });

  it("rejects findMany distinctOn before a provider operation", async () => {
    harness.reset();
    const plugin = mongoAdapter({ client: harness.client });

    const operation = plugin.findMany({
      model: "bundles",
      orderBy: [{ field: "channel", direction: "asc" }],
      distinctOn: { fields: ["channel"] },
    });

    await expect(operation).rejects.toBeInstanceOf(DatabasePluginInputError);
    await expect(operation).rejects.toMatchObject({
      code: "invalid-operation",
    });
    expect(harness.getOperationCount()).toBe(0);
  });

  it("returns an plugin object without an unsafe transaction fallback", () => {
    const plugin = mongoAdapter({ client: harness.client });
    expect(plugin).toBeTypeOf("object");
    expect(plugin.name).toBe("mongodb");
    expect(plugin.adapterName).toBe("mongodb");
    expect(plugin.provider).toBe("mongodb");
    expect(plugin.transaction).toBeUndefined();
  });

  it("removes a patch inserted concurrently with bundle deletion", async () => {
    harness.reset();
    harness.setBeforeBundlePatchInsert(undefined);
    const plugin = mongoAdapter({ client: harness.client });
    const bundle = {
      id: "bundle-production",
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: "bundle-hash",
      git_commit_hash: null,
      message: null,
      channel: "production",
      storage_uri: "storage://bundle",
      target_app_version: "1.0.0",
      fingerprint_hash: null,
      metadata: {},
      rollout_cohort_count: 1,
      target_cohorts: null,
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    };
    await plugin.create({ model: "bundles", data: bundle });

    let releaseInsert: (() => void) | undefined;
    const insertReleased = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let observeInsert: (() => void) | undefined;
    const insertObserved = new Promise<void>((resolve) => {
      observeInsert = resolve;
    });
    harness.setBeforeBundlePatchInsert(async () => {
      observeInsert?.();
      await insertReleased;
    });

    const createPatch = plugin.create({
      model: "bundle_patches",
      data: {
        id: "patch-production",
        bundle_id: bundle.id,
        base_bundle_id: bundle.id,
        base_file_hash: bundle.file_hash,
        patch_file_hash: "patch-hash",
        patch_storage_uri: "storage://patch",
        order_index: 0,
      },
    });
    await insertObserved;
    await plugin.delete({
      model: "bundles",
      where: [{ field: "id", value: bundle.id }],
    });
    releaseInsert?.();

    await expect(createPatch).rejects.toThrow("references a missing bundle");
    await expect(plugin.findMany({ model: "bundle_patches" })).resolves.toEqual(
      [],
    );
    harness.setBeforeBundlePatchInsert(undefined);
  });

  it("recovers a tombstoned bundle when an aggregate delete is retried", async () => {
    harness.reset();
    const plugin = mongoAdapter({ client: harness.client });
    const client = createDatabaseClient(plugin);
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
      channel: "production",
      id: bundle.id,
    });
  });

  it("rejects malformed stored bundle rows in the update-info fast path", async () => {
    harness.reset();
    const plugin = mongoAdapter({ client: harness.client });
    const bundle = createBundleRowFixture("972");
    await plugin.create({ model: "bundles", data: bundle });
    harness.setBundleField(bundle.id, "should_force_update", "false");
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

describe("MongoDB query translation", () => {
  it("reads only the literal match when the selector value starts with a dollar sign", async () => {
    harness.reset();
    const plugin = mongoAdapter({ client: harness.client });
    const target = { ...createBundleRowFixture("810"), id: "$channel" };
    const distractor = createBundleRowFixture("811");
    await plugin.create({ model: "bundles", data: target });
    await plugin.create({
      model: "bundles",
      data: { ...distractor, channel: distractor.id },
    });

    const bundles = await plugin.findMany({
      model: "bundles",
      where: [{ field: "id", value: "$channel" }],
    });

    expect(bundles).toMatchObject([{ id: target.id }]);
  });

  it("updates only the literal match when the selector value starts with a dollar sign", async () => {
    harness.reset();
    const plugin = mongoAdapter({ client: harness.client });
    const target = { ...createBundleRowFixture("820"), id: "$channel" };
    const distractor = createBundleRowFixture("821");
    await plugin.create({ model: "bundles", data: target });
    await plugin.create({
      model: "bundles",
      data: { ...distractor, channel: distractor.id },
    });

    const updated = await plugin.update({
      model: "bundles",
      where: [{ field: "id", value: "$channel" }],
      update: { enabled: false },
    });

    expect(updated).toMatchObject({ id: target.id, enabled: false });
    await expect(
      plugin.findOne({
        model: "bundles",
        where: [{ field: "id", value: target.id }],
      }),
    ).resolves.toMatchObject({ enabled: false });
    await expect(
      plugin.findOne({
        model: "bundles",
        where: [{ field: "id", value: distractor.id }],
      }),
    ).resolves.toMatchObject({ enabled: true });
  });

  it("deletes only the literal match when the selector value starts with a dollar sign", async () => {
    harness.reset();
    const plugin = mongoAdapter({ client: harness.client });
    const target = { ...createBundleRowFixture("830"), id: "$channel" };
    const distractor = createBundleRowFixture("831");
    await plugin.create({ model: "bundles", data: target });
    await plugin.create({
      model: "bundles",
      data: { ...distractor, channel: distractor.id },
    });

    await plugin.delete({
      model: "bundles",
      where: [{ field: "id", value: "$channel" }],
    });

    await expect(plugin.findMany({ model: "bundles" })).resolves.toMatchObject([
      { id: distractor.id },
    ]);
  });

  it("composes connectors left to right", () => {
    const where = createMongoBundleWhere([
      { field: "id", value: "first" },
      { field: "id", value: "second", connector: "OR" },
      { field: "enabled", value: true, connector: "AND" },
    ]);

    expect(where).toEqual({
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

  it("escapes insensitive string pattern predicates", () => {
    const where = createMongoBundleWhere([
      {
        field: "message",
        operator: "contains",
        value: "release.*",
        mode: "insensitive",
      },
    ]);

    expect(where).toEqual({
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

  it("wraps normalized and comparison selector values as literals", () => {
    expect(
      createMongoBundleWhere([
        {
          field: "message",
          value: "$CHANNEL",
          mode: "insensitive",
        },
      ]),
    ).toEqual({
      $expr: {
        $eq: [
          { $toLower: { $ifNull: ["$message", ""] } },
          { $literal: "$channel" },
        ],
      },
    });
    expect(
      createMongoBundleWhere([
        { field: "rollout_cohort_count", operator: "gte", value: 5 },
      ]),
    ).toEqual({
      $and: [
        { $expr: { $ne: ["$rollout_cohort_count", null] } },
        { $expr: { $gte: ["$rollout_cohort_count", { $literal: 5 }] } },
      ],
    });
  });
});
