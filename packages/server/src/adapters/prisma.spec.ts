import type { DatabaseWhere } from "@hot-updater/plugin-core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { setupDatabasePluginTestSuite } from "../../../test-utils/src/setupDatabasePluginTestSuite";
import { prismaAdapter, type PrismaConfig } from "./prisma";
import { createPrismaTestHarness } from "./prismaTestClient";

const harness = createPrismaTestHarness();

setupDatabasePluginTestSuite({
  name: "prismaAdapter v2",
  migrate: () => undefined,
  createPlugin: () =>
    prismaAdapter({ prisma: harness.client, provider: "postgresql" }),
  reset: () => harness.reset(),
  dispose: () => undefined,
});

const expectWhereRejectedBeforePrisma = async (
  provider: PrismaConfig["provider"],
  where: readonly DatabaseWhere<"bundles">[],
): Promise<void> => {
  const local = createPrismaTestHarness();
  const findMany = vi.spyOn(local.client.bundles, "findMany");
  const updateMany = vi.spyOn(local.client.bundles, "updateMany");
  const deleteMany = vi.spyOn(local.client.bundles, "deleteMany");
  const plugin = prismaAdapter({ prisma: local.client, provider });

  await expect(
    plugin.findMany({ model: "bundles", where }),
  ).rejects.toMatchObject({ code: "invalid-operation" });
  await expect(
    plugin.update({
      model: "bundles",
      where,
      update: { enabled: false },
    }),
  ).rejects.toMatchObject({ code: "invalid-update-selector" });
  await expect(
    plugin.delete({ model: "bundles", where }),
  ).rejects.toMatchObject({ code: "invalid-operation" });
  expect(findMany).not.toHaveBeenCalled();
  expect(updateMany).not.toHaveBeenCalled();
  expect(deleteMany).not.toHaveBeenCalled();
};

describe("prismaAdapter capabilities", () => {
  it("excludes MongoDB from the public configuration", () => {
    expectTypeOf<"mongodb">().not.toMatchTypeOf<PrismaConfig["provider"]>();
  });

  it.each([
    {
      name: "an unsupported sensitive mode",
      provider: "sqlite",
      where: [
        {
          field: "message",
          operator: "contains",
          value: "Alpha",
          mode: "sensitive",
        },
      ],
    },
    {
      name: "an unverified CockroachDB sensitive mode",
      provider: "cockroachdb",
      where: [
        {
          field: "message",
          operator: "contains",
          value: "Alpha",
          mode: "sensitive",
        },
      ],
    },
    {
      name: "an insensitive mode",
      provider: "postgresql",
      where: [
        {
          field: "message",
          value: "Alpha",
          mode: "insensitive",
        },
      ],
    },
    {
      name: "a backend pattern metacharacter",
      provider: "postgresql",
      where: [{ field: "message", operator: "contains", value: "%" }],
    },
  ] satisfies readonly {
    readonly name: string;
    readonly provider: PrismaConfig["provider"];
    readonly where: readonly DatabaseWhere<"bundles">[];
  }[])("rejects $name before Prisma I/O", ({ provider, where }) =>
    expectWhereRejectedBeforePrisma(provider, where),
  );

  it("forwards supported sensitive mode explicitly", async () => {
    const local = createPrismaTestHarness();
    const findMany = vi.spyOn(local.client.bundles, "findMany");
    const plugin = prismaAdapter({
      prisma: local.client,
      provider: "postgresql",
    });

    await plugin.findMany({
      model: "bundles",
      where: [
        {
          field: "message",
          operator: "contains",
          value: "Alpha",
          mode: "sensitive",
        },
      ],
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          message: { contains: "Alpha", mode: "default" },
        },
      }),
    );
  });

  it("rejects unsupported distinct queries", async () => {
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });

    await expect(
      plugin.count({ model: "bundles", distinct: ["channel"] }),
    ).rejects.toMatchObject({ code: "invalid-operation" });
    await expect(
      plugin.findMany({
        model: "bundles",
        orderBy: [{ field: "channel", direction: "asc" }],
        distinctOn: { fields: ["channel"] },
      }),
    ).rejects.toMatchObject({ code: "invalid-operation" });
  });

  it("returns an plugin object instead of a callable factory", () => {
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });

    expect(plugin).toBeTypeOf("object");
    expect(plugin.name).toBe("prisma");
    expect(plugin.adapterName).toBe("prisma");
    expect(plugin.provider).toBe("postgresql");
  });

  it("rejects MongoDB before creating the Prisma implementation", () => {
    expect(() =>
      Reflect.apply(prismaAdapter, undefined, [
        { prisma: harness.client, provider: "mongodb" },
      ]),
    ).toThrow("Prisma adapter does not support MongoDB");
  });

  it("omits transaction when callback transactions are unavailable", () => {
    const { $transaction: _transaction, ...client } = harness.client;

    const plugin = prismaAdapter({ prisma: client, provider: "postgresql" });

    expect(plugin.transaction).toBeUndefined();
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
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });
    await plugin.create({
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
      plugin.update({
        model: "bundles",
        where: [{ field: "id", value: "bundle-race" }],
        update: { target_app_version: null },
      }),
    ).rejects.toThrow("bundle target update was not applied");
    await expect(
      plugin.findOne({
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
    const plugin = prismaAdapter({
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
    await plugin.create({
      model: "bundles",
      data: { ...bundle, id: "bundle-base" },
    });
    await plugin.create({
      model: "bundles",
      data: { ...bundle, id: "bundle-target" },
    });
    await plugin.create({
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
    await plugin.delete({
      model: "bundles",
      where: [{ field: "id", value: "bundle-target" }],
    });

    expect(harness.getTransactionOptions()).toEqual(
      Array.from({ length: 4 }, () => ({ isolationLevel: "Serializable" })),
    );
  });

  it("does not delete patches before a foreign-key bundle delete fails", async () => {
    harness.reset();
    const { $transaction: _transaction, ...client } = harness.client;
    const plugin = prismaAdapter({
      prisma: client,
      provider: "postgresql",
    });
    const bundle = {
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: "hash",
      git_commit_hash: null,
      message: null,
      channel: "production",
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
    await plugin.create({
      model: "bundles",
      data: { ...bundle, id: "bundle-base" },
    });
    await plugin.create({
      model: "bundles",
      data: { ...bundle, id: "bundle-target" },
    });
    await plugin.create({
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
      plugin.delete({
        model: "bundles",
        where: [{ field: "id", value: "bundle-target" }],
      }),
    ).rejects.toThrow("injected bundle delete failure");

    await expect(
      plugin.findOne({
        model: "bundles",
        where: [{ field: "id", value: "bundle-target" }],
      }),
    ).resolves.toMatchObject({ id: "bundle-target" });
    await expect(
      plugin.findMany({
        model: "bundle_patches",
        where: [{ field: "id", value: "patch-1" }],
      }),
    ).resolves.toHaveLength(1);
  });
});
