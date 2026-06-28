import { AsyncLocalStorage } from "node:async_hooks";

import type { ConfigResponse } from "@hot-updater/cli-tools";
import type {
  DatabasePlugin,
  NodeStoragePlugin,
} from "@hot-updater/plugin-core";

export type HostedConsoleProject = {
  id: string;
  workspaceId: string;
  name?: string;
  slug?: string;
};

export type HostedConsoleBundleMetricsSummary = {
  active: number;
  recovered: number;
  lastSeenAt?: string | null;
};

export type HostedConsoleBundleMetricsPoint = {
  active: number;
  bucketStart: string;
  recovered: number;
};

export type HostedConsoleBundleMetrics = {
  active: number;
  recovered: number;
  lastSeenAt?: string | null;
  series: readonly HostedConsoleBundleMetricsPoint[];
};

export type HostedConsoleBundleMetricsProvider = {
  getBundleMetricsSummaries: (
    bundleIds: readonly string[],
  ) => Promise<Record<string, HostedConsoleBundleMetricsSummary>>;
  getBundleMetrics?: (
    bundleId: string,
  ) => Promise<HostedConsoleBundleMetrics | null>;
};

export type HostedConsoleContext = {
  project: HostedConsoleProject;
  console?: ConfigResponse["console"];
  database: () => Promise<DatabasePlugin> | DatabasePlugin;
  bundleMetrics?: () =>
    | Promise<HostedConsoleBundleMetricsProvider>
    | HostedConsoleBundleMetricsProvider;
  storage: () => Promise<NodeStoragePlugin> | NodeStoragePlugin;
};

const hostedConsoleContextStorage =
  new AsyncLocalStorage<HostedConsoleContext>();

const unsupportedBuild = () => {
  throw new Error("Hosted console mode does not support native build plugins.");
};

export const runWithHostedConsoleContext = <T>(
  context: HostedConsoleContext,
  callback: () => T,
): T => hostedConsoleContextStorage.run(context, callback);

export const getHostedConsoleContext = () =>
  hostedConsoleContextStorage.getStore() ?? null;

export const getHostedConsoleInfo = () => {
  const context = getHostedConsoleContext();

  if (!context) {
    return { mode: "local" as const };
  }

  return {
    mode: "hosted" as const,
    project: context.project,
  };
};

export const createHostedConfig = (
  context: HostedConsoleContext,
): ConfigResponse =>
  ({
    build: unsupportedBuild,
    cacheDir: null,
    compressStrategy: "zip",
    console: {
      port: 1422,
      ...context.console,
    },
    database: context.database,
    fingerprint: {
      debug: false,
      extraSources: [],
      ignorePaths: [],
    },
    nativeBuild: {
      android: {},
      ios: {},
    },
    patch: {
      enabled: true,
      maxBaseBundles: 3,
    },
    platform: {
      android: {
        androidManifestPaths: [],
        stringResourcePaths: [],
      },
      ios: {
        infoPlistPaths: [],
      },
    },
    releaseChannel: "production",
    signing: {
      enabled: false,
      privateKeyPath: "",
    },
    storage: context.storage,
    updateStrategy: "appVersion",
  }) as ConfigResponse;
