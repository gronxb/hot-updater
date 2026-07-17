import { NIL_UUID } from "@hot-updater/core";
import {
  createDatabaseClient,
  databaseBundleEventSupport,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  createBundleRowFixture,
  createChannelRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { setupDatabaseAdapterTestSuite } from "../../../test-utils/src/setupDatabaseAdapterTestSuite";
import { createDatabaseAdapterCore } from "../db/databaseAdapterCore";
import { supportsBundleEvents } from "../db/types";
import { mongoAdapter } from "./mongodb";
import { createMongoBundleWhere } from "./mongodbQuery";
import { createMongoTestHarness } from "./mongodbTestClient";

const harness = createMongoTestHarness();

setupDatabaseAdapterTestSuite({
  name: "mongoAdapter v2",
  migrate: () => undefined,
  createAdapter: () => mongoAdapter({ client: harness.client }),
  reset: () => harness.reset(),
  dispose: () => harness.close(),
});

const createBundleEventRow = (
  id: string,
  installId: string,
  receivedAtMs: number,
) => ({
  id,
  type: "UPDATE_APPLIED" as const,
  install_id: installId,
  user_id: null,
  username: null,
  from_bundle_id: `from-${installId}`,
  to_bundle_id: `to-${installId}`,
  platform: "ios" as const,
  app_version: "1.0.0",
  channel: "production",
  cohort: "stable",
  update_strategy: "appVersion" as const,
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

describe("mongoAdapter capabilities", () => {
  it("returns an adapter object without an unsafe transaction fallback", () => {
    const adapter = mongoAdapter({ client: harness.client });
    const core = createDatabaseAdapterCore(adapter, async () => null);

    expect(adapter).toBeTypeOf("object");
    expect(adapter.name).toBe("mongodb");
    expect(adapter.adapterName).toBe("mongodb");
    expect(adapter.provider).toBe("mongodb");
    expect(adapter.transaction).toBeUndefined();
    expect(Reflect.get(adapter, databaseBundleEventSupport)).toBe(true);
    expect(supportsBundleEvents(core.api)).toBe(true);
  });

  it("removes a patch inserted concurrently with bundle deletion", async () => {
    harness.reset();
    harness.setBeforeBundlePatchInsert(undefined);
    const adapter = mongoAdapter({ client: harness.client });
    await adapter.create({
      model: "channels",
      data: { id: "channel-production", name: "production" },
    });
    const bundle = {
      id: "bundle-production",
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: "bundle-hash",
      git_commit_hash: null,
      message: null,
      channel: "production",
      channel_id: "channel-production",
      storage_uri: "storage://bundle",
      target_app_version: "1.0.0",
      fingerprint_hash: null,
      metadata: null,
      rollout_cohort_count: 1,
      target_cohorts: null,
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    };
    await adapter.create({ model: "bundles", data: bundle });

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

    const createPatch = adapter.create({
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
    await adapter.delete({
      model: "bundles",
      where: [{ field: "id", value: bundle.id }],
    });
    releaseInsert?.();

    await expect(createPatch).rejects.toThrow("references a missing bundle");
    await expect(
      adapter.findMany({ model: "bundle_patches" }),
    ).resolves.toEqual([]);
    harness.setBeforeBundlePatchInsert(undefined);
  });

  it("recovers a tombstoned bundle when an aggregate delete is retried", async () => {
    harness.reset();
    const adapter = mongoAdapter({ client: harness.client });
    const client = createDatabaseClient(adapter);
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
    const adapter = mongoAdapter({ client: harness.client });
    const bundle = createBundleRowFixture("972");
    await adapter.create({
      model: "channels",
      data: createChannelRowFixture("production"),
    });
    await adapter.create({ model: "bundles", data: bundle });
    harness.setBundleField(bundle.id, "should_force_update", "false");
    const getUpdateInfo = adapter.getUpdateInfo;
    if (getUpdateInfo === undefined) throw new Error("fast path unavailable");

    await expect(
      getUpdateInfo({
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      }),
    ).rejects.toThrow("Invalid MongoDB adapter data");
  });
});

describe("mongoAdapter bundle_events distinct semantics", () => {
  it("counts distinct installs and keeps the latest row per install", async () => {
    harness.reset();
    const adapter = mongoAdapter({ client: harness.client });

    await adapter.create({
      model: "bundle_events",
      data: createBundleEventRow("event-a-1", "install-a", 100),
    });
    await adapter.create({
      model: "bundle_events",
      data: createBundleEventRow("event-a-2", "install-a", 200),
    });
    await adapter.create({
      model: "bundle_events",
      data: createBundleEventRow("event-b-1", "install-b", 150),
    });
    await adapter.create({
      model: "bundle_events",
      data: createBundleEventRow("event-b-2", "install-b", 150),
    });

    await expect(
      adapter.count({ model: "bundle_events", distinct: ["install_id"] }),
    ).resolves.toBe(2);
    await expect(
      adapter.findMany({
        model: "bundle_events",
        distinctOn: { fields: ["install_id"] },
        orderBy: [
          { field: "install_id", direction: "asc" },
          { field: "received_at_ms", direction: "desc" },
          { field: "id", direction: "desc" },
        ],
      }),
    ).resolves.toMatchObject([
      { id: "event-a-2", install_id: "install-a", received_at_ms: 200 },
      { id: "event-b-2", install_id: "install-b", received_at_ms: 150 },
    ]);
  });
  it("honors explicit null ordering for bundle event queries", async () => {
    harness.reset();
    const adapter = mongoAdapter({ client: harness.client });

    await adapter.create({
      model: "bundle_events",
      data: createBundleEventRow("event-null", "install-a", 100),
    });
    await adapter.create({
      model: "bundle_events",
      data: {
        ...createBundleEventRow("event-user", "install-b", 200),
        user_id: "user-123",
      },
    });

    await expect(
      adapter.findMany({
        model: "bundle_events",
        orderBy: [
          { field: "user_id", direction: "asc", nulls: "first" },
          { field: "id", direction: "asc" },
        ],
      }),
    ).resolves.toMatchObject([
      { id: "event-null", user_id: null },
      { id: "event-user", user_id: "user-123" },
    ]);
  });
});

describe("MongoDB query translation", () => {
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
            { $expr: { $eq: ["$id", "first"] } },
            { $expr: { $eq: ["$id", "second"] } },
          ],
        },
        { $expr: { $eq: ["$enabled", true] } },
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
          regex: "release\\.\\*",
          options: "i",
        },
      },
    });
  });

  it("preserves empty set semantics", () => {
    expect(
      createMongoBundleWhere([{ field: "id", operator: "in", value: [] }]),
    ).toEqual({ $expr: { $in: ["$id", []] } });
    expect(
      createMongoBundleWhere([{ field: "id", operator: "not_in", value: [] }]),
    ).toEqual({ $expr: { $not: [{ $in: ["$id", []] }] } });
  });
});
