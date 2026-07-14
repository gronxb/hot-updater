import { describe, expect, it } from "vitest";

import { setupDatabaseAdapterTestSuite } from "../../../test-utils/src/setupDatabaseAdapterTestSuite";
import { prismaAdapter } from "./prisma";
import { createPrismaTestHarness } from "./prismaTestClient";

const harness = createPrismaTestHarness();

setupDatabaseAdapterTestSuite({
  name: "prismaAdapter v2",
  migrate: () => undefined,
  createAdapter: () =>
    prismaAdapter({ prisma: harness.client, provider: "postgresql" }),
  reset: () => harness.reset(),
  dispose: () => undefined,
});

describe("prismaAdapter capabilities", () => {
  it("returns an adapter object instead of a callable factory", () => {
    const adapter = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });

    expect(adapter).toBeTypeOf("object");
    expect(adapter.name).toBe("prisma");
    expect(adapter.adapterName).toBe("prisma");
    expect(adapter.provider).toBe("postgresql");
  });

  it("omits transaction when callback transactions are unavailable", () => {
    const { $transaction: _transaction, ...client } = harness.client;

    const adapter = prismaAdapter({ prisma: client, provider: "postgresql" });

    expect(adapter.transaction).toBeUndefined();
  });

  it("requires callback transactions for emulated relations", () => {
    const { $transaction: _transaction, ...client } = harness.client;

    expect(() =>
      prismaAdapter({
        prisma: client,
        provider: "postgresql",
        relationMode: "prisma",
      }),
    ).toThrow('relation mode "prisma" requires callback transactions');
  });

  it("guards target fields against a concurrent clear", async () => {
    harness.reset();
    const adapter = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });
    await adapter.create({
      model: "channels",
      data: { id: "channel-production", name: "production" },
    });
    await adapter.create({
      model: "bundles",
      data: {
        id: "bundle-race",
        platform: "ios",
        should_force_update: false,
        enabled: true,
        file_hash: "hash",
        git_commit_hash: null,
        message: null,
        channel: "production",
        channel_id: "channel-production",
        storage_uri: "storage://bundle",
        target_app_version: "1.0.0",
        fingerprint_hash: "fingerprint",
        metadata: {},
        rollout_cohort_count: 1000,
        target_cohorts: null,
        manifest_storage_uri: null,
        manifest_file_hash: null,
        asset_base_storage_uri: null,
      },
    });
    harness.clearTargetBeforeNextBundleUpdate(
      "bundle-race",
      "fingerprint_hash",
    );

    await expect(
      adapter.update({
        model: "bundles",
        where: [{ field: "id", value: "bundle-race" }],
        update: { target_app_version: null },
      }),
    ).rejects.toThrow("bundle target update was not applied");
    await expect(
      adapter.findOne({
        model: "bundles",
        where: [{ field: "id", value: "bundle-race" }],
      }),
    ).resolves.toMatchObject({
      target_app_version: "1.0.0",
      fingerprint_hash: null,
    });
  });

  it("uses serializable transactions for emulated relation mutations", async () => {
    harness.reset();
    const adapter = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
      relationMode: "prisma",
    });
    const bundle = {
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: "hash",
      git_commit_hash: null,
      message: null,
      channel: "production",
      channel_id: "channel-production",
      storage_uri: "storage://bundle",
      target_app_version: "1.0.0",
      fingerprint_hash: null,
      metadata: {},
      rollout_cohort_count: 1000,
      target_cohorts: null,
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    };
    await adapter.create({
      model: "channels",
      data: { id: "channel-production", name: "production" },
    });
    await adapter.create({
      model: "bundles",
      data: { ...bundle, id: "bundle-base" },
    });
    await adapter.create({
      model: "bundles",
      data: { ...bundle, id: "bundle-target" },
    });
    await adapter.create({
      model: "bundle_patches",
      data: {
        id: "patch-1",
        bundle_id: "bundle-target",
        base_bundle_id: "bundle-base",
        base_file_hash: "base-hash",
        patch_file_hash: "patch-hash",
        patch_storage_uri: "storage://patch",
        order_index: 0,
      },
    });
    await adapter.delete({
      model: "bundles",
      where: [{ field: "id", value: "bundle-target" }],
    });

    expect(harness.getTransactionOptions()).toEqual(
      Array.from({ length: 4 }, () => ({ isolationLevel: "Serializable" })),
    );
  });

  it("rolls back patch cleanup when a bundle cascade delete fails", async () => {
    harness.reset();
    const adapter = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });
    await adapter.create({
      model: "channels",
      data: { id: "channel-production", name: "production" },
    });
    const bundle = {
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: "hash",
      git_commit_hash: null,
      message: null,
      channel: "production",
      channel_id: "channel-production",
      storage_uri: "storage://bundle",
      target_app_version: "1.0.0",
      fingerprint_hash: null,
      metadata: {},
      rollout_cohort_count: 1000,
      target_cohorts: null,
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    };
    await adapter.create({
      model: "bundles",
      data: { ...bundle, id: "bundle-base" },
    });
    await adapter.create({
      model: "bundles",
      data: { ...bundle, id: "bundle-target" },
    });
    await adapter.create({
      model: "bundle_patches",
      data: {
        id: "patch-1",
        bundle_id: "bundle-target",
        base_bundle_id: "bundle-base",
        base_file_hash: "base-hash",
        patch_file_hash: "patch-hash",
        patch_storage_uri: "storage://patch",
        order_index: 0,
      },
    });

    harness.failNextBundleDelete();
    await expect(
      adapter.delete({
        model: "bundles",
        where: [{ field: "id", value: "bundle-target" }],
      }),
    ).rejects.toThrow("injected bundle delete failure");

    await expect(
      adapter.findOne({
        model: "bundles",
        where: [{ field: "id", value: "bundle-target" }],
      }),
    ).resolves.toMatchObject({ id: "bundle-target" });
    await expect(
      adapter.findMany({
        model: "bundle_patches",
        where: [{ field: "id", value: "patch-1" }],
      }),
    ).resolves.toHaveLength(1);
  });
});
