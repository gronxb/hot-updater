import type {
  AppUpdateInfo,
  Bundle,
  GetBundlesArgs,
  UpdateInfo,
} from "@hot-updater/core";
import type { StoragePlugin } from "@hot-updater/plugin-core";
import { createHandler } from "../handler";
import type { PaginationInfo } from "../types";
import type { HotUpdaterClient, Migrator } from "./ormCore";
import { createOrmDatabaseCore } from "./ormCore";
import { createPluginDatabaseCore } from "./pluginCore";
import {
  type DatabaseAdapter,
  isDatabasePlugin,
  isDatabasePluginFactory,
} from "./types";

export type { HotUpdaterClient, Migrator } from "./ormCore";

export { HotUpdaterDB } from "./ormCore";

export interface DatabaseAPI {
  getBundleById(id: string): Promise<Bundle | null>;
  getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null>;
  getAppUpdateInfo(args: GetBundlesArgs): Promise<AppUpdateInfo | null>;
  getChannels(): Promise<string[]>;
  getBundles(options: {
    where?: { channel?: string; platform?: string };
    limit: number;
    offset: number;
  }): Promise<{ data: Bundle[]; pagination: PaginationInfo }>;
  insertBundle(bundle: Bundle): Promise<void>;
  updateBundleById(bundleId: string, newBundle: Partial<Bundle>): Promise<void>;
  deleteBundleById(bundleId: string): Promise<void>;
}

type HotUpdaterAPI = DatabaseAPI & {
  handler: (request: Request) => Promise<Response>;

  adapterName: string;
  createMigrator: () => Migrator;
  generateSchema: HotUpdaterClient["generateSchema"];
};

type StoragePluginFactory = (args: { cwd: string }) => StoragePlugin;

interface HotUpdaterOptions {
  database: DatabaseAdapter;
  storagePlugins?: (StoragePlugin | StoragePluginFactory)[];
  basePath?: string;
  cwd?: string;
}

interface HotUpdaterCoreInternal {
  api: DatabaseAPI;
  adapterName: string;
  createMigrator: () => Migrator;
  generateSchema: HotUpdaterClient["generateSchema"];
}

export function createHotUpdater(options: HotUpdaterOptions): HotUpdaterAPI {
  const cwd = options.cwd ?? process.cwd();

  // Initialize storage plugins - call factories if they are functions
  const storagePlugins = (options?.storagePlugins ?? []).map((plugin) =>
    typeof plugin === "function" ? plugin({ cwd }) : plugin,
  );

  const resolveFileUrl = async (
    storageUri: string | null,
  ): Promise<string | null> => {
    if (!storageUri) {
      return null;
    }
    const url = new URL(storageUri);
    const protocol = url.protocol.replace(":", "");
    if (protocol === "http" || protocol === "https") {
      return storageUri;
    }
    const plugin = storagePlugins.find((p) => p.supportedProtocol === protocol);

    if (!plugin) {
      throw new Error(`No storage plugin for protocol: ${protocol}`);
    }
    const { fileUrl } = await plugin.getDownloadUrl(storageUri);
    if (!fileUrl) {
      throw new Error("Storage plugin returned empty fileUrl");
    }
    return fileUrl;
  };

  let core: HotUpdaterCoreInternal;

  const database = options.database;

  if (isDatabasePluginFactory(database) || isDatabasePlugin(database)) {
    const plugin = isDatabasePluginFactory(database)
      ? database({ cwd })
      : database;
    core = createPluginDatabaseCore(plugin, resolveFileUrl);
  } else {
    core = createOrmDatabaseCore({
      database,
      resolveFileUrl,
    });
  }

  return {
    ...core.api,
    handler: createHandler(
      core.api,
      options?.basePath ? { basePath: options.basePath } : {},
    ),
    adapterName: core.adapterName,
    createMigrator: core.createMigrator,
    generateSchema: core.generateSchema,
  };
}
