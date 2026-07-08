import type { Bundle } from "@hot-updater/plugin-core";
import type { ConfigInput } from "@hot-updater/plugin-core";
import type { PaginationInfo } from "@hot-updater/plugin-core";
import { createContext, type ReactNode, useContext } from "react";

export type BundleFilters = {
  after?: string;
  before?: string;
  channel?: string;
  limit?: string;
  page?: number;
  platform?: "ios" | "android";
};

export type ConsoleApiClient = {
  createBundle: (bundle: Bundle) => Promise<{
    bundleId: string;
    success: boolean;
  }>;
  deleteBundle: (params: { bundleId: string }) => Promise<{
    success: boolean;
  }>;
  getBundle: (params: { bundleId: string }) => Promise<Bundle | null>;
  getBundleChildCounts: (params: {
    bundleIds: string[];
  }) => Promise<Record<string, number>>;
  getBundleChildren: (params: { baseBundleId: string }) => Promise<Bundle[]>;
  getBundleDownloadUrl: (params: {
    bundleId: string;
  }) => Promise<{ fileUrl: string }>;
  getBundles: (filters?: BundleFilters) => Promise<{
    data: Bundle[];
    pagination?: PaginationInfo;
  }>;
  getChannels: () => Promise<string[]>;
  getConfig: () => Promise<{
    console?: ConfigInput["console"];
  }>;
  getConfigLoaded: () => Promise<{
    configLoaded: boolean;
  }>;
  promoteBundle: (params: {
    action: "copy" | "move";
    bundleId: string;
    nextBundleId?: string;
    targetChannel: string;
  }) => Promise<{
    bundle: Bundle;
    success: boolean;
  }>;
  updateBundle: (params: {
    bundle: Partial<Bundle>;
    bundleId: string;
  }) => Promise<{
    bundle: Bundle;
    success: boolean;
  }>;
};

const ConsoleApiClientContext = createContext<ConsoleApiClient | null>(null);

export function ConsoleApiClientProvider({
  api,
  children,
}: {
  api: ConsoleApiClient;
  children: ReactNode;
}) {
  return (
    <ConsoleApiClientContext.Provider value={api}>
      {children}
    </ConsoleApiClientContext.Provider>
  );
}

export function useConsoleApiClient() {
  const api = useContext(ConsoleApiClientContext);

  if (!api) {
    throw new Error("HotUpdaterConsole requires a ConsoleApiClientProvider.");
  }

  return api;
}
