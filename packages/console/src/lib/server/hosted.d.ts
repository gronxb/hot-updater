import type { ConfigResponse } from "@hot-updater/cli-tools";
import type {
  Bundle,
  DatabasePlugin,
  NodeStoragePlugin,
  TelemetryKeyResult,
  TelemetryKeyState,
} from "@hot-updater/plugin-core";

export type HostedConsoleProject = {
  readonly id: string;
  readonly workspaceId: string;
  readonly name?: string;
  readonly slug?: string;
};

export type HostedConsoleBundleMetricsSummary = {
  readonly active: number;
  readonly recovered: number;
  readonly lastSeenAt?: string | null;
};

export type HostedConsoleBundleMetricsPoint = {
  readonly active: number;
  readonly bucketStart: string;
  readonly recovered: number;
};

export type HostedConsoleBundleMetrics = {
  readonly active: number;
  readonly recovered: number;
  readonly lastSeenAt?: string | null;
  readonly series: readonly HostedConsoleBundleMetricsPoint[];
};

export type HostedConsoleBundleMetricsProvider = {
  readonly getBundleMetricsSummaries: (
    bundleIds: readonly string[],
  ) => Promise<Record<string, HostedConsoleBundleMetricsSummary>>;
  readonly getBundleMetrics?: (
    bundleId: string,
  ) => Promise<HostedConsoleBundleMetrics | null>;
};

export type HostedConsoleContext = {
  readonly project: HostedConsoleProject;
  readonly console?: ConfigResponse["console"];
  readonly database: () => Promise<DatabasePlugin> | DatabasePlugin;
  readonly bundleMetrics?: () =>
    | Promise<HostedConsoleBundleMetricsProvider>
    | HostedConsoleBundleMetricsProvider;
  readonly storage: () => Promise<NodeStoragePlugin> | NodeStoragePlugin;
};

export type GetBundlesInput = {
  readonly channel?: string;
  readonly platform?: "ios" | "android";
  readonly page?: number;
  readonly limit?: string;
  readonly after?: string;
  readonly before?: string;
};

export type GetBundleInput = {
  readonly bundleId: string;
};

export type GetBundleChildrenInput = {
  readonly baseBundleId: string;
};

export type GetBundleChildCountsInput = {
  readonly bundleIds: readonly string[];
};

export type GetBundleDownloadUrlInput = {
  readonly bundleId: string;
};

export type GetBundleMetricsInput = {
  readonly bundleId: string;
};

export type SetTelemetryKeyActiveInput = {
  readonly active: boolean;
};

export type UpdateBundleInput = {
  readonly bundleId: string;
  readonly bundle: Partial<Bundle>;
};

export type PromoteBundleInput = {
  readonly action: "copy" | "move";
  readonly bundleId: string;
  readonly nextBundleId?: string;
  readonly targetChannel: string;
};

export type DeleteBundleInput = {
  readonly bundleId: string;
};

export declare const runWithHostedConsoleContext: <T>(
  context: HostedConsoleContext,
  callback: () => T,
) => T;

export declare const getHostedConsoleContext: () => HostedConsoleContext | null;

export declare const getHostedConsoleInfo: () =>
  | { readonly mode: "local" }
  | {
      readonly mode: "hosted";
      readonly project: HostedConsoleProject;
    };

export declare const createHostedConfig: (
  context: HostedConsoleContext,
) => ConfigResponse;

export declare const getConfigOperation: () => Promise<{
  readonly capabilities: {
    readonly telemetry: boolean;
    readonly telemetryKey: boolean;
  };
  readonly console: ConfigResponse["console"];
  readonly hosted: ReturnType<typeof getHostedConsoleInfo>;
}>;

export declare const getChannelsOperation: () => Promise<string[]>;

export declare const getConfigLoadedOperation: () => Promise<{
  readonly configLoaded: boolean;
}>;

export declare const getTelemetryKeyStateOperation: () => Promise<TelemetryKeyState | null>;

export declare const issueTelemetryKeyOperation: () => Promise<TelemetryKeyResult>;

export declare const rotateTelemetryKeyOperation: () => Promise<TelemetryKeyResult>;

export declare const setTelemetryKeyActiveOperation: (input: {
  readonly active: boolean;
}) => Promise<{ readonly active: boolean }>;

export declare const getBundlesOperation: (
  input?: GetBundlesInput,
) => ReturnType<DatabasePlugin["bundles"]["list"]>;

export declare const getBundleOperation: (
  input: GetBundleInput,
) => Promise<Bundle | null>;

export declare const getBundleChildrenOperation: (
  input: GetBundleChildrenInput,
) => Promise<Bundle[]>;

export declare const getBundleChildCountsOperation: (
  input: GetBundleChildCountsInput,
) => Promise<Record<string, number>>;

export declare const getBundleDownloadUrlOperation: (
  input: GetBundleDownloadUrlInput,
) => Promise<{ readonly fileUrl: string }>;

export declare const getBundleMetricsOperation: (
  input: GetBundleMetricsInput,
) => Promise<HostedConsoleBundleMetrics | null>;

export declare const updateBundleOperation: (
  input: UpdateBundleInput,
) => Promise<{ readonly success: true; readonly bundle: Bundle }>;

export declare const promoteBundleOperation: (
  input: PromoteBundleInput,
) => Promise<{ readonly success: true; readonly bundle: Bundle }>;

export declare const createBundleOperation: (
  bundle: Bundle,
) => Promise<{ readonly success: true; readonly bundleId: string }>;

export declare const deleteBundleOperation: (
  input: DeleteBundleInput,
) => Promise<{ readonly success: true }>;
