import { createClient } from "@supabase/supabase-js";

import { resolveSupabaseServiceRoleKey } from "./supabaseConfig";
import {
  assertTelemetryKeyShape,
  createKeyResponse,
  hashTelemetryKey,
} from "./supabaseTelemetryKey";
import {
  normalizeObservedAt,
  readLifecycleMetrics,
  recordMetricDelta,
} from "./supabaseTelemetryMetrics";
import {
  parseNotifyAppReadyPayload,
  readJsonBody,
} from "./supabaseTelemetryPayload";
import {
  TELEMETRY_KEY_ROW_ID,
  createSupabaseError,
  isDuplicateError,
  type NotifyAppReadyResult,
  type SupabaseTelemetryConfig,
  type SupabaseTelemetryOperations,
} from "./supabaseTelemetryTypes";
import type { Database } from "./types";

export type {
  LifecycleMetrics,
  NotifyAppReadyPayload,
  NotifyAppReadyResponse,
  NotifyAppReadyResult,
  SupabaseTelemetryConfig,
  SupabaseTelemetryOperations,
  TelemetryKeyResponse,
  TelemetryKeyState,
} from "./supabaseTelemetryTypes";

export const createSupabaseTelemetryOperations = (
  config: SupabaseTelemetryConfig,
): SupabaseTelemetryOperations => {
  const supabase = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  );

  return {
    authenticateTelemetryKey: async (telemetryKey) => {
      if (!assertTelemetryKeyShape(telemetryKey)) return false;

      const { data, error } = await supabase
        .from("telemetry_keys")
        .select("key_hash")
        .eq("id", TELEMETRY_KEY_ROW_ID)
        .maybeSingle();

      if (error) {
        throw createSupabaseError("Failed to read telemetry key", error);
      }
      if (!data) return false;

      return data.key_hash === (await hashTelemetryKey(telemetryKey));
    },

    getTelemetryKeyState: async () => {
      const { data, error } = await supabase
        .from("telemetry_keys")
        .select("key_suffix")
        .eq("id", TELEMETRY_KEY_ROW_ID)
        .maybeSingle();

      if (error) {
        throw createSupabaseError("Failed to read telemetry key state", error);
      }

      return data ? { telemetryKeySuffix: data.key_suffix } : null;
    },

    issueTelemetryKey: () => createKeyResponse(supabase),
    rotateTelemetryKey: () => createKeyResponse(supabase),

    recordLifecycleEvent: async (payload) => {
      const observedAt = normalizeObservedAt(payload.observedAt);
      const receivedAt = new Date().toISOString();
      const crashedBundleId =
        payload.status === "RECOVERED" ? payload.crashedBundleId : null;
      const { error } = await supabase.from("bundle_lifecycle_events").insert({
        bundle_id: payload.bundleId,
        channel: payload.channel,
        crashed_bundle_id: crashedBundleId,
        event_id: payload.eventId,
        install_id: payload.installId,
        observed_at: observedAt,
        platform: payload.platform,
        received_at: receivedAt,
        status: payload.status,
      });

      if (isDuplicateError(error)) {
        return { accepted: true, deduped: true };
      }
      if (error) {
        throw createSupabaseError("Failed to store lifecycle event", error);
      }

      await recordMetricDelta(supabase, {
        active: 1,
        bundleId: payload.bundleId,
        channel: payload.channel,
        observedAt,
        platform: payload.platform,
        recovered: 0,
      });

      switch (payload.status) {
        case "ACTIVE":
          break;
        case "RECOVERED":
          await recordMetricDelta(supabase, {
            active: 0,
            bundleId: payload.crashedBundleId,
            channel: payload.channel,
            observedAt,
            platform: payload.platform,
            recovered: 1,
          });
          break;
      }

      return { accepted: true, deduped: false };
    },

    readLifecycleMetrics: () => readLifecycleMetrics(supabase),
  };
};

export const createSupabaseNotifyAppReadyResult = async ({
  operations,
  request,
}: {
  readonly operations: SupabaseTelemetryOperations;
  readonly request: Request;
}): Promise<NotifyAppReadyResult> => {
  const url = new URL(request.url);
  if (
    request.headers.get("authorization") ||
    request.headers.get("cookie") ||
    url.searchParams.has("telemetryKey") ||
    url.searchParams.has("x-hot-updater-telemetry-key")
  ) {
    return {
      body: { error: "Runtime telemetry must use x-hot-updater-telemetry-key" },
      status: 401,
    };
  }

  const telemetryKey = request.headers.get("x-hot-updater-telemetry-key");
  if (!telemetryKey || !assertTelemetryKeyShape(telemetryKey)) {
    return { body: { error: "Telemetry key rejected" }, status: 401 };
  }

  const authenticated = await operations.authenticateTelemetryKey(telemetryKey);
  if (!authenticated) {
    return { body: { error: "Telemetry key rejected" }, status: 401 };
  }

  const body = await readJsonBody(request);
  if (body.kind === "invalid") {
    return { body: { error: "Invalid JSON body" }, status: 400 };
  }

  const parsed = parseNotifyAppReadyPayload(body.value);
  if (parsed.kind === "invalid") {
    return { body: { error: "Invalid notifyAppReady payload" }, status: 400 };
  }

  try {
    return {
      body: await operations.recordLifecycleEvent(parsed.payload),
      status: 202,
    };
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.warn("Bundle lifecycle telemetry write failed", error.message);
      return {
        body: { error: "Lifecycle telemetry write failed" },
        status: 500,
      };
    }
    console.warn("Bundle lifecycle telemetry write failed");
    return { body: { error: "Lifecycle telemetry write failed" }, status: 500 };
  }
};
