import { describe, expect, it } from "vitest";

import { setupDatabaseAdapterTestSuite } from "../../../test-utils/src/setupDatabaseAdapterTestSuite";
import { prismaAdapter } from "./prisma";
import { createPrismaTestHarness } from "./prismaTestClient";

const harness = createPrismaTestHarness();

const containsMode = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsMode);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, nested]) => key === "mode" || containsMode(nested),
  );
};

const createModeRejectingClient = (capturedWhere: unknown[]) => {
  const delegate = {
    count: () => Promise.resolve(0),
    create: () => Promise.resolve({}),
    deleteMany: () => Promise.resolve({}),
    findFirst: () => Promise.resolve(null),
    findMany: (args: Readonly<Record<string, unknown>>) => {
      const where = args["where"];
      capturedWhere.push(where);
      if (containsMode(where)) {
        throw new TypeError("connector received unsupported Prisma mode");
      }
      return Promise.resolve([]);
    },
    update: () => Promise.resolve({}),
  };
  const client = {
    bundles: delegate,
    bundle_patches: delegate,
    bundle_channels: delegate,
    bundle_events: delegate,
    $transaction: <TResult>(
      callback: (transactionClient: object) => Promise<TResult>,
    ): Promise<TResult> => callback(client),
  };
  return client;
};

const identityWhere = [
  {
    field: "username",
    operator: "contains",
    value: "alice",
    mode: "insensitive",
  },
  {
    field: "user_id",
    operator: "contains",
    value: "alice",
    mode: "insensitive",
    connector: "OR",
  },
  {
    field: "install_id",
    operator: "contains",
    value: "alice",
    mode: "insensitive",
    connector: "OR",
  },
] as const;

const identityPrismaWhere = {
  OR: [
    {
      OR: [
        { username: { contains: "alice" } },
        { user_id: { contains: "alice" } },
      ],
    },
    { install_id: { contains: "alice" } },
  ],
};

setupDatabaseAdapterTestSuite({
  name: "prismaAdapter v2",
  migrate: () => undefined,
  createAdapter: () =>
    prismaAdapter({ prisma: harness.client, provider: "postgresql" }),
  reset: () => harness.reset(),
  dispose: () => undefined,
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

describe("prismaAdapter capabilities", () => {
  it.each(["sqlite", "mysql"] as const)(
    "omits unsupported mode and keeps identity OR predicates for %s",
    async (provider) => {
      // Given
      const capturedWhere: unknown[] = [];
      const adapter = prismaAdapter({
        prisma: createModeRejectingClient(capturedWhere),
        provider,
      });

      // When
      await adapter.findMany({
        model: "bundle_events",
        where: identityWhere,
      });

      // Then
      expect(capturedWhere).toEqual([identityPrismaWhere]);
    },
  );

  it.each(["sqlite", "mysql"] as const)(
    "threads provider into callback-transaction identity queries for %s",
    async (provider) => {
      // Given
      const capturedWhere: unknown[] = [];
      const adapter = prismaAdapter({
        prisma: createModeRejectingClient(capturedWhere),
        provider,
      });

      // When
      await adapter.transaction?.((transaction) =>
        transaction.findMany({
          model: "bundle_events",
          where: identityWhere,
        }),
      );

      // Then
      expect(capturedWhere).toEqual([identityPrismaWhere]);
    },
  );

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

describe("prismaAdapter bundle_events distinct semantics", () => {
  it("counts distinct installs and keeps the latest row per install", async () => {
    harness.reset();
    const adapter = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });

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
    const adapter = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });

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
