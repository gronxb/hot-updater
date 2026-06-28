import type { ReactElement } from "react";

export type BundleFilters = {
  readonly after?: string;
  readonly before?: string;
  readonly channel?: string;
  readonly limit?: string;
  readonly page?: number;
  readonly platform?: "ios" | "android";
};

export type ConsoleBundle = {
  readonly id: string;
  readonly metrics?: {
    readonly active: number;
    readonly lastSeenAt?: string | null;
    readonly recovered: number;
  };
  readonly storageUri?: string;
  readonly [key: string]: unknown;
};

export type ConsoleBundleMetricsPoint = {
  readonly active: number;
  readonly bucketStart: string;
  readonly recovered: number;
};

export type ConsoleBundleMetrics = {
  readonly active: number;
  readonly lastSeenAt?: string | null;
  readonly recovered: number;
  readonly series: readonly ConsoleBundleMetricsPoint[];
};

export type ConsoleApiClient = {
  readonly createBundle: (bundle: ConsoleBundle) => Promise<{
    readonly bundleId: string;
    readonly success: boolean;
  }>;
  readonly deleteBundle: (params: { readonly bundleId: string }) => Promise<{
    readonly success: boolean;
  }>;
  readonly getBundle: (params: {
    readonly bundleId: string;
  }) => Promise<ConsoleBundle | null>;
  readonly getBundleChildCounts: (params: {
    readonly bundleIds: string[];
  }) => Promise<Record<string, number>>;
  readonly getBundleChildren: (params: {
    readonly baseBundleId: string;
  }) => Promise<ConsoleBundle[]>;
  readonly getBundleDownloadUrl: (params: {
    readonly bundleId: string;
  }) => Promise<{ readonly fileUrl: string }>;
  readonly getBundleMetrics?: (params: {
    readonly bundleId: string;
  }) => Promise<ConsoleBundleMetrics | null>;
  readonly getBundles: (filters?: BundleFilters) => Promise<{
    readonly data: ConsoleBundle[];
    readonly pagination?: unknown;
  }>;
  readonly getChannels: () => Promise<string[]>;
  readonly getConfig: () => Promise<unknown>;
  readonly getConfigLoaded: () => Promise<{ readonly configLoaded: boolean }>;
  readonly promoteBundle: (params: {
    readonly action: "copy" | "move";
    readonly bundleId: string;
    readonly nextBundleId?: string;
    readonly targetChannel: string;
  }) => Promise<{ readonly bundle: ConsoleBundle; readonly success: boolean }>;
  readonly updateBundle: (params: {
    readonly bundle: Partial<ConsoleBundle>;
    readonly bundleId: string;
  }) => Promise<{ readonly bundle: ConsoleBundle; readonly success: boolean }>;
};

export type HotUpdaterConsoleProps = {
  readonly api: ConsoleApiClient;
  readonly initialBundleId?: string;
  readonly initialExpandedBundleId?: string;
  readonly initialFilters?: BundleFilters;
  readonly project?: {
    readonly id?: string;
    readonly name?: string;
    readonly runtimeUrl?: string;
  };
};

export declare function HotUpdaterConsole(
  props: HotUpdaterConsoleProps,
): ReactElement;
