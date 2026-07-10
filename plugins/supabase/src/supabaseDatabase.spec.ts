import { PGlite } from "@electric-sql/pglite";
import type { Bundle, GetBundlesArgs } from "@hot-updater/core";
import { toBundleReadModel } from "@hot-updater/plugin-core";
import {
  stageDatabaseRuntimeBundleDelete,
  stageDatabaseRuntimeBundleInsert,
  stageDatabaseRuntimeBundleUpdate,
} from "@hot-updater/server/db";
import {
  setupBundleMethodsTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  supabaseDatabase,
  type SupabaseDatabaseRuntime,
} from "./supabaseDatabase";

describe("supabaseDatabase official Kysely path", () => {
  const db = new PGlite();
  const plugin: SupabaseDatabaseRuntime = supabaseDatabase({
    dialect: new PGliteDialect(db),
  });

  const migrate = async () => {
    const migrator = plugin.createMigrator?.();
    if (!migrator) {
      throw new Error("supabaseDatabase did not expose a migrator");
    }
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();
  };

  const readBundle = async (bundleId: string): Promise<Bundle | null> => {
    const record = await plugin.bundles.getById({ bundleId });
    if (!record) return null;

    const patches = await plugin.bundlePatches.list({
      where: { bundleId },
      orderBy: { field: "orderIndex", direction: "asc" },
      limit: 1000,
    });
    return toBundleReadModel(record, patches.data);
  };

  const writeBundle = async (bundle: Bundle): Promise<void> => {
    await stageDatabaseRuntimeBundleInsert(plugin, { bundle });
    await plugin.commit();
  };

  const updateBundle = async (
    bundleId: string,
    patch: Partial<Bundle>,
  ): Promise<void> => {
    await stageDatabaseRuntimeBundleUpdate(plugin, {
      bundleId,
      patch,
    });
    await plugin.commit();
  };

  const deleteBundle = async (bundleId: string): Promise<void> => {
    await stageDatabaseRuntimeBundleDelete(plugin, bundleId);
    await plugin.commit();
  };

  beforeAll(async () => {
    await migrate();
  });

  beforeEach(async () => {
    await db.exec("delete from bundle_patches; delete from bundles;");
  });

  afterAll(async () => {
    await plugin.close?.();
    await db.close();
  });

  it("creates a Kysely-backed Postgres runtime from a supplied dialect", () => {
    expect(plugin.adapterName).toBe("kysely");
    expect(plugin.provider).toBe("postgresql");
    expect(plugin.createMigrator).toBeTypeOf("function");
  });

  setupBundleMethodsTestSuite({
    getBundleById: readBundle,
    getChannels: async () => {
      const result = await plugin.bundles.list({ limit: 1000 });
      return Array.from(
        new Set(result.data.map((bundle) => bundle.channel)),
      ).sort();
    },
    insertBundle: writeBundle,
    getBundles: async (options) => {
      const result = await plugin.bundles.list(options);
      const bundles = await Promise.all(
        result.data.map((bundle) => readBundle(bundle.id)),
      );
      return {
        ...result,
        data: bundles.filter((bundle): bundle is Bundle => bundle !== null),
        pagination: {
          ...result.pagination,
          total: result.pagination.total ?? result.data.length,
          currentPage: result.pagination.currentPage ?? 1,
          totalPages:
            result.pagination.totalPages ??
            (result.data.length === 0
              ? 0
              : Math.ceil(result.data.length / options.limit)),
        },
      };
    },
    updateBundleById: updateBundle,
    deleteBundleById: deleteBundle,
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: async (bundles: Bundle[], args: GetBundlesArgs) => {
      await db.exec("delete from bundle_patches; delete from bundles;");
      for (const bundle of bundles) {
        await writeBundle(bundle);
      }

      return plugin.updateInfo?.get(args) ?? null;
    },
  });

  it("attaches update bundles without exposing internal fields", async () => {
    const currentBundle: Bundle = {
      channel: "production",
      enabled: true,
      fileHash: "current-file-hash",
      fingerprintHash: "fingerprint-hash",
      gitCommitHash: "current-git-hash",
      id: "018f0000-0000-7000-8000-000000000001",
      message: "current",
      metadata: {},
      platform: "ios",
      shouldForceUpdate: false,
      storageUri: "storage://app/current.zip",
      targetAppVersion: "1.0.0",
    };
    const targetBundle: Bundle = {
      ...currentBundle,
      fileHash: "target-file-hash",
      gitCommitHash: "target-git-hash",
      id: "018f0000-0000-7000-8000-000000000002",
      message: "target",
      storageUri: "storage://app/target.zip",
    };

    await writeBundle(currentBundle);
    await writeBundle(targetBundle);

    const updateInfo = await plugin.updateInfo?.get({
      _updateStrategy: "fingerprint",
      bundleId: currentBundle.id,
      channel: "production",
      fingerprintHash: "fingerprint-hash",
      minBundleId: "00000000-0000-0000-0000-000000000000",
      platform: "ios",
    });

    expect(updateInfo).toEqual({
      fileHash: "target-file-hash",
      id: targetBundle.id,
      message: "target",
      shouldForceUpdate: false,
      status: "UPDATE",
      storageUri: "storage://app/target.zip",
    });
    expect(Object.getOwnPropertyNames(updateInfo ?? {})).not.toContain(
      "__hotUpdaterBundle",
    );
    expect(Object.getOwnPropertyNames(updateInfo ?? {})).not.toContain(
      "__hotUpdaterCurrentBundle",
    );
    expect(JSON.stringify(updateInfo)).not.toContain("__hotUpdater");
  });
});
