import type { SupabaseClient } from "@supabase/supabase-js";

import type { SupabaseServiceRoleConfig } from "./supabaseConfig";
import type { Database } from "./types";

export const TELEMETRY_KEY_PREFIX = "hutk_";
export const TELEMETRY_KEY_SUFFIX_LENGTH = 8;
export const TELEMETRY_KEY_ROW_ID = "default";

export type SupabaseTelemetryClient = SupabaseClient<Database>;
export type SupabaseTelemetryConfig = SupabaseServiceRoleConfig;

export type Platform = "android" | "ios";

type NotifyAppReadyBasePayload = {
  readonly bundleId: string;
  readonly channel: string;
  readonly eventId: string;
  readonly installId: string;
  readonly observedAt?: string;
  readonly platform: Platform;
};

export type NotifyAppReadyPayload =
  | (NotifyAppReadyBasePayload & {
      readonly status: "ACTIVE";
    })
  | (NotifyAppReadyBasePayload & {
      readonly crashedBundleId: string;
      readonly status: "RECOVERED";
    });

export type NotifyAppReadyResponse = {
  readonly accepted: true;
  readonly deduped: boolean;
};

export type NotifyAppReadyResult = {
  readonly body: NotifyAppReadyResponse | { readonly error: string };
  readonly status: 202 | 400 | 401 | 500;
};

export type TelemetryKeyResponse = {
  readonly telemetryKey: string;
  readonly telemetryKeySuffix: string;
};

export type TelemetryKeyState = {
  readonly telemetryKeySuffix: string;
};

export type LifecycleMetricsBundle = {
  readonly active: number;
  readonly bundleId: string;
  readonly channel: string;
  readonly lastSeenAt: string | null;
  readonly platform: Platform;
  readonly recovered: number;
};

export type LifecycleMetricsSeriesPoint = {
  readonly active: number;
  readonly bucketStart: string;
  readonly bundleId: string;
  readonly recovered: number;
};

export type LifecycleMetrics = {
  readonly bundles: readonly LifecycleMetricsBundle[];
  readonly series: readonly LifecycleMetricsSeriesPoint[];
  readonly totals: {
    readonly active: number;
    readonly recovered: number;
  };
};

export type MetricsDelta = {
  readonly active: number;
  readonly bundleId: string;
  readonly channel: string;
  readonly observedAt: string;
  readonly platform: Platform;
  readonly recovered: number;
};

export type SupabaseTelemetryOperations = {
  readonly authenticateTelemetryKey: (telemetryKey: string) => Promise<boolean>;
  readonly getTelemetryKeyState: () => Promise<TelemetryKeyState | null>;
  readonly issueTelemetryKey: () => Promise<TelemetryKeyResponse>;
  readonly readLifecycleMetrics: () => Promise<LifecycleMetrics>;
  readonly recordLifecycleEvent: (
    payload: NotifyAppReadyPayload,
  ) => Promise<NotifyAppReadyResponse>;
  readonly rotateTelemetryKey: () => Promise<TelemetryKeyResponse>;
};

export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createSupabaseError = (
  message: string,
  error: unknown,
): Error => {
  if (isRecord(error) && typeof error.message === "string") {
    return new Error(`${message}: ${error.message}`);
  }

  return new Error(message);
};

export const isDuplicateError = (error: unknown): boolean =>
  isRecord(error) && error.code === "23505";
