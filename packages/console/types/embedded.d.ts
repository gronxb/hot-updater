import type { ReactElement } from "react";

export type BundleFilters = {
  after?: string;
  before?: string;
  channel?: string;
  limit?: string;
  page?: number;
  platform?: "ios" | "android";
};

export type ConsoleBundle = {
  id: string;
  [key: string]: unknown;
};

export type ConsolePagination = {
  currentPage: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  total: number;
  totalPages: number;
};

export type ConsoleApiClient = {
  createBundle: (bundle: ConsoleBundle) => Promise<{
    bundleId: string;
    success: boolean;
  }>;
  deleteBundle: (params: { bundleId: string }) => Promise<{
    success: boolean;
  }>;
  getBundle: (params: { bundleId: string }) => Promise<ConsoleBundle | null>;
  getBundleChildCounts: (params: {
    bundleIds: string[];
  }) => Promise<Record<string, number>>;
  getBundleChildren: (params: {
    baseBundleId: string;
  }) => Promise<ConsoleBundle[]>;
  getBundleDownloadUrl: (params: {
    bundleId: string;
  }) => Promise<{ fileUrl: string }>;
  getBundles: (filters?: BundleFilters) => Promise<{
    data: ConsoleBundle[];
    pagination?: ConsolePagination;
  }>;
  getChannels: () => Promise<string[]>;
  getConfig: () => Promise<{
    console?: {
      gitUrl?: string;
      port?: number;
      [key: string]: unknown;
    };
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
    bundle: ConsoleBundle;
    success: boolean;
  }>;
  updateBundle: (params: {
    bundle: Partial<ConsoleBundle>;
    bundleId: string;
  }) => Promise<{
    bundle: ConsoleBundle;
    success: boolean;
  }>;
};

export type HotUpdaterConsoleProps = {
  api: ConsoleApiClient;
  initialBundleId?: string;
  initialExpandedBundleId?: string;
  initialFilters?: BundleFilters;
};

export declare function HotUpdaterConsole(
  props: HotUpdaterConsoleProps,
): ReactElement;
