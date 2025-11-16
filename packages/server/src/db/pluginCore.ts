import type {
  AppUpdateInfo,
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import { getUpdateInfo as getUpdateInfoJS } from "@hot-updater/js";
import type { DatabasePlugin } from "@hot-updater/plugin-core";
import type { DatabaseAPI } from "./types";

export function createPluginDatabaseCore(
  plugin: DatabasePlugin,
  resolveFileUrl: (storageUri: string | null) => Promise<string | null>,
): {
  api: DatabaseAPI;
  adapterName: string;
  createMigrator: () => never;
  generateSchema: () => never;
} {
  const api: DatabaseAPI = {
    async getBundleById(id: string): Promise<Bundle | null> {
      return plugin.getBundleById(id);
    },

    async getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null> {
      const where: { channel?: string; platform?: string } = {};

      if ("platform" in args && args.platform) {
        where.platform = args.platform;
      }

      const channel =
        "channel" in args && args.channel ? args.channel : "production";
      where.channel = channel;

      const { pagination } = await plugin.getBundles({
        where,
        limit: 1,
        offset: 0,
      });

      if (pagination.total === 0) {
        return getUpdateInfoJS([], args);
      }

      const { data } = await plugin.getBundles({
        where,
        limit: pagination.total,
        offset: 0,
      });

      const bundles = data;
      return getUpdateInfoJS(bundles, args);
    },

    async getAppUpdateInfo(
      args: GetBundlesArgs,
    ): Promise<AppUpdateInfo | null> {
      const info = await this.getUpdateInfo(args);
      if (!info) {
        return null;
      }
      const { storageUri, ...rest } = info as UpdateInfo & {
        storageUri: string | null;
      };
      const fileUrl = await resolveFileUrl(storageUri ?? null);
      return { ...rest, fileUrl };
    },

    async getChannels(): Promise<string[]> {
      return plugin.getChannels();
    },

    async getBundles(options: {
      where?: { channel?: string; platform?: string };
      limit: number;
      offset: number;
    }) {
      return plugin.getBundles(options);
    },

    async insertBundle(bundle: Bundle): Promise<void> {
      await plugin.appendBundle(bundle);
      await plugin.commitBundle();
    },

    async updateBundleById(
      bundleId: string,
      newBundle: Partial<Bundle>,
    ): Promise<void> {
      await plugin.updateBundle(bundleId, newBundle);
      await plugin.commitBundle();
    },

    async deleteBundleById(bundleId: string): Promise<void> {
      const bundle = await plugin.getBundleById(bundleId);
      if (!bundle) {
        throw new Error("targetBundleId not found");
      }
      await plugin.deleteBundle(bundle);
      await plugin.commitBundle();
    },
  };

  return {
    api,
    adapterName: plugin.name,
    createMigrator: () => {
      throw new Error(
        "createMigrator is only available for Kysely/Prisma/Drizzle database adapters.",
      );
    },
    generateSchema: () => {
      throw new Error(
        "generateSchema is only available for Kysely/Prisma/Drizzle database adapters.",
      );
    },
  };
}
