import { describe, expect, expectTypeOf, it } from "vitest";

import { setupDatabasePluginTestSuite } from "../../../test-utils/src/setupDatabasePluginTestSuite";
import {
  createPrismaInsightsSchemaProvisioner,
  prismaAdapter,
  type PrismaConfig,
} from "./prisma";
import { createPrismaTestHarness } from "./prismaTestClient";

const harness = createPrismaTestHarness();
const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000e001";

setupDatabasePluginTestSuite({
  name: "prismaAdapter v2",
  migrate: () => undefined,
  createPlugin: () =>
    prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
      insightsDatabaseNamespace,
    }),
  reset: () => harness.reset(),
  dispose: () => undefined,
});

const bundleRow = (id: string) => ({
  id,
  platform: "ios" as const,
  file_hash: "hash",
  git_commit_hash: null,
  storage_uri: "storage://bundle",
  archive_byte_size: 3_000_000_001,
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

const productionChannel = {
  id: "channel-production",
  name: "production",
} as const;

describe("prismaAdapter capabilities", () => {
  it("excludes MongoDB from the public configuration", () => {
    expectTypeOf<"mongodb">().not.toMatchTypeOf<PrismaConfig["provider"]>();
  });

  it("returns a named provider adapter", () => {
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
      insightsDatabaseNamespace,
    });

    expect(plugin.name).toBe("prisma");
    expect(plugin.adapterName).toBe("prisma");
    expect(plugin.provider).toBe("postgresql");
  });

  it("rejects MongoDB before creating the implementation", () => {
    expect(() =>
      Reflect.apply(prismaAdapter, undefined, [
        { prisma: harness.client, provider: "mongodb" },
      ]),
    ).toThrow("Prisma adapter does not support MongoDB");
  });

  it("does not expose low-level transactions", () => {
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
      insightsDatabaseNamespace,
    });

    expect(Reflect.has(plugin, "transaction")).toBe(false);
  });

  it("preserves non-schema core preflight failures", async () => {
    const connectionError = Object.assign(new Error("authentication failed"), {
      code: "P1000",
    });
    const provisioner = createPrismaInsightsSchemaProvisioner(
      {
        ...harness.client,
        $queryRawUnsafe: async () => {
          throw connectionError;
        },
      },
      "postgresql",
      insightsDatabaseNamespace,
    );

    await expect(provisioner.plan()).rejects.toBe(connectionError);
  });

  it("requires transactions for emulated relations", () => {
    const { $transaction: _transaction, ...client } = harness.client;

    expect(() =>
      prismaAdapter({
        prisma: client,
        provider: "postgresql",
        insightsDatabaseNamespace,
        relationMode: "prisma",
      }),
    ).toThrow('relation mode "prisma" requires callback transactions');
  });

  it("uses serializable transactions for emulated relation commits", async () => {
    harness.reset();
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
      insightsDatabaseNamespace,
      relationMode: "prisma",
    });
    const base = bundleRow("bundle-base");
    const owner = bundleRow("bundle-target");
    const patch = {
      id: "patch-1",
      bundle_id: owner.id,
      base_bundle_id: base.id,
      base_file_hash: "base-hash",
      patch_file_hash: "patch-hash",
      patch_storage_uri: "storage://patch",
      byte_size: 3_000_000_002,
      order_index: 0,
    };

    await plugin.models.channels.insert({
      row: productionChannel,
      onConflict: "returnExisting",
    });

    await plugin.commit({
      changes: [{ model: "bundles", operation: "insert", row: base }],
    });
    await plugin.commit({
      changes: [
        { model: "bundles", operation: "insert", row: owner },
        { model: "bundlePatches", operation: "insert", row: patch },
      ],
    });
    await plugin.commit({
      changes: [
        {
          model: "bundles",
          operation: "delete",
          where: { id: owner.id },
        },
      ],
    });

    expect(harness.getTransactionOptions()).toEqual(
      Array.from({ length: 3 }, () => ({ isolationLevel: "Serializable" })),
    );
  });

  it("uses serializable transactions for atomic CAS commits", async () => {
    harness.reset();
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
      insightsDatabaseNamespace,
    });

    await plugin.commit({
      changes: [
        { model: "bundles", operation: "insert", row: bundleRow("bundle") },
      ],
    });

    expect(harness.getTransactionOptions()).toEqual([
      { isolationLevel: "Serializable" },
    ]);
  });

  it("does not delete patches before a bundle delete fails", async () => {
    harness.reset();
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
      insightsDatabaseNamespace,
    });
    const base = bundleRow("bundle-base");
    const owner = bundleRow("bundle-target");
    const patch = {
      id: "patch-1",
      bundle_id: owner.id,
      base_bundle_id: base.id,
      base_file_hash: "base-hash",
      patch_file_hash: "patch-hash",
      patch_storage_uri: "storage://patch",
      byte_size: 3_000_000_002,
      order_index: 0,
    };
    await plugin.models.channels.insert({
      row: productionChannel,
      onConflict: "returnExisting",
    });
    for (const row of [base, owner]) {
      await plugin.commit({
        changes: [{ model: "bundles", operation: "insert", row }],
      });
    }
    await plugin.commit({
      changes: [{ model: "bundlePatches", operation: "insert", row: patch }],
    });

    harness.failNextBundleDelete();
    await expect(
      plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "delete",
            where: { id: owner.id },
          },
        ],
      }),
    ).rejects.toThrow("injected bundle delete failure");
    await expect(
      plugin.models.bundles.findById(owner.id),
    ).resolves.toMatchObject({
      id: owner.id,
    });
    await expect(
      plugin.models.bundlePatches.findByBundleIds([owner.id]),
    ).resolves.toEqual([patch]);
  });
});
