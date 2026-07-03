import {
  createDatabaseAnalyticsRuntime,
  createTelemetryAnalyticsEvent,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import { resolveSupabaseServiceRoleKey } from "./supabaseConfig";
import {
  getTelemetryKeyCredential,
  setTelemetryKeyActive,
  upsertTelemetryKeyCredential,
} from "./supabaseTelemetryKey";
import { getLifecycleMetrics } from "./supabaseTelemetryMetrics";
import {
  parseNotifyAppReadyPayload,
  readJsonBody,
} from "./supabaseTelemetryPayload";
import {
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

const toJsonRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Analytics event payload must be a JSON object.");
  }
  return value as Record<string, unknown>;
};

export const createSupabaseTelemetryOperations = (
  config: SupabaseTelemetryConfig,
): SupabaseTelemetryOperations => {
  const supabase = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  );

  return {
    getTelemetryKeyCredential: () => getTelemetryKeyCredential(supabase),
    setTelemetryKeyActive: (active) => setTelemetryKeyActive(supabase, active),
    upsertTelemetryKeyCredential: (credential) =>
      upsertTelemetryKeyCredential(supabase, credential),

    insertLifecycleEvent: async (payload) => {
      const recoveredBundleId =
        payload.status === "RECOVERED"
          ? (payload.crashedBundleId ?? null)
          : null;
      if (payload.status === "RECOVERED" && recoveredBundleId === null) {
        throw new TypeError(
          "Recovered lifecycle events require crashedBundleId.",
        );
      }

      const event = createTelemetryAnalyticsEvent(payload);
      const { error } = await supabase.from("analytics_events").insert({
        event_type: event.eventType,
        id: event.id,
        observed_at: event.observedAt,
        payload: toJsonRecord(event.payload),
        received_at: event.receivedAt,
      });

      if (isDuplicateError(error)) {
        return { accepted: true, deduped: true };
      }
      if (error) {
        throw createSupabaseError("Failed to store lifecycle event", error);
      }

      return { accepted: true, deduped: false };
    },

    getLifecycleMetrics: () => getLifecycleMetrics(supabase),
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
  const analytics = createDatabaseAnalyticsRuntime(operations);
  const authenticateTelemetryKey = analytics.authenticateTelemetryKey;
  const recordLifecycleEvent = analytics.recordLifecycleEvent;
  if (!telemetryKey) {
    return { body: { error: "Telemetry key rejected" }, status: 401 };
  }

  const authenticated =
    (await authenticateTelemetryKey?.(telemetryKey)) ?? false;
  if (!authenticated) {
    return { body: { error: "Telemetry key rejected" }, status: 401 };
  }
  if (!recordLifecycleEvent) {
    return { body: { error: "Lifecycle telemetry write failed" }, status: 500 };
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
      body: await recordLifecycleEvent(parsed.payload),
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
