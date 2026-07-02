import type {
  DatabaseAnalyticsOperations,
  TelemetryKeyResult as PluginTelemetryKeyResult,
} from "@hot-updater/plugin-core";

export const TELEMETRY_KEY_PREFIX = "hutk_";
export const TELEMETRY_KEY_SUFFIX_LENGTH = 8;
export const TELEMETRY_KEY_BYTES = 32;
export const TELEMETRY_KEY_DOC_ID = "current";
export const TELEMETRY_KEYS_COLLECTION = "telemetry_keys";
export const LIFECYCLE_EVENTS_COLLECTION = "bundle_lifecycle_events";
export const LIFECYCLE_METRICS_COLLECTION = "bundle_lifecycle_metrics";
export const LIFECYCLE_BUCKETS_COLLECTION = "bundle_lifecycle_metric_buckets";

export const LifecycleStatus = {
  Active: "ACTIVE",
  Recovered: "RECOVERED",
} as const;

export type LifecycleStatusValue =
  (typeof LifecycleStatus)[keyof typeof LifecycleStatus];

export type Platform = "ios" | "android";

export type TelemetryKeyResult = PluginTelemetryKeyResult;

export type LifecyclePayload = {
  readonly bundleId: string;
  readonly channel: string;
  readonly crashedBundleId?: string;
  readonly eventId: string;
  readonly installId: string;
  readonly observedAt: string;
  readonly platform: Platform;
  readonly status: LifecycleStatusValue;
};

export type LifecycleRecordResult = {
  readonly accepted: true;
  readonly deduped: boolean;
};

export type BundleLifecycleMetricsBundle = {
  readonly active: number;
  readonly bundleId: string;
  readonly channel?: string;
  readonly lastSeenAt: string | null;
  readonly platform?: Platform;
  readonly recovered: number;
};

export type BundleLifecycleMetricsSeriesPoint = {
  readonly active: number;
  readonly bucketStart: string;
  readonly bundleId: string;
  readonly recovered: number;
};

export type FirebaseBundleLifecycleMetrics = {
  readonly bundles: readonly BundleLifecycleMetricsBundle[];
  readonly series: readonly BundleLifecycleMetricsSeriesPoint[];
  readonly totals: {
    readonly active: number;
    readonly recovered: number;
  };
};

export type FirebaseTelemetryOperations = Required<
  Pick<
    DatabaseAnalyticsOperations,
    | "getLifecycleMetrics"
    | "getTelemetryKeyCredential"
    | "insertLifecycleEvent"
    | "upsertTelemetryKeyCredential"
  >
>;

export type NotifyAppReadyResult = {
  readonly body:
    | LifecycleRecordResult
    | {
        readonly error: string;
      };
  readonly status: 202 | 400 | 401 | 500;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

export const readOptionalString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const field = value[key];
  if (field === undefined) return undefined;
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

export const readCount = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;

export const parsePlatform = (
  value: string | undefined,
): Platform | undefined => {
  if (value === "ios" || value === "android") return value;
  return undefined;
};

export const isTelemetryKeyFormat = (telemetryKey: string): boolean =>
  telemetryKey.startsWith(TELEMETRY_KEY_PREFIX) &&
  telemetryKey.length > TELEMETRY_KEY_PREFIX.length;
