import { createDatabaseAnalyticsRuntime } from "@hot-updater/plugin-core";
import { Hono } from "hono";

import {
  LifecycleStatus,
  isRecord,
  isTelemetryKeyFormat,
  parsePlatform,
  readOptionalString,
  readString,
  type FirebaseTelemetryOperations,
  type LifecyclePayload,
  type LifecycleStatusValue,
  type NotifyAppReadyResult,
} from "./firebaseTelemetryTypes";

const parseStatus = (
  value: string | undefined,
): LifecycleStatusValue | undefined => {
  if (value === LifecycleStatus.Active || value === LifecycleStatus.Recovered) {
    return value;
  }
  return undefined;
};

const parseObservedAt = (value: string | undefined): string | undefined => {
  const observedAt = value ?? new Date().toISOString();
  const timestamp = Date.parse(observedAt);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
};

const parseLifecyclePayload = (
  value: unknown,
): LifecyclePayload | undefined => {
  if (!isRecord(value)) return undefined;

  const bundleId = readString(value, "bundleId");
  const channel = readString(value, "channel");
  const eventId = readString(value, "eventId");
  const installId = readString(value, "installId");
  const platform = parsePlatform(readString(value, "platform"));
  const status = parseStatus(readString(value, "status"));
  const observedAt = parseObservedAt(readOptionalString(value, "observedAt"));
  const crashedBundleId = readOptionalString(value, "crashedBundleId");

  if (
    !bundleId ||
    !channel ||
    !eventId ||
    !installId ||
    !platform ||
    !status ||
    !observedAt
  ) {
    return undefined;
  }

  if (status === LifecycleStatus.Recovered && !crashedBundleId) {
    return undefined;
  }

  return {
    bundleId,
    channel,
    crashedBundleId,
    eventId,
    installId,
    observedAt,
    platform,
    status,
  };
};

const hasQueryCredential = (request: Request): boolean => {
  const url = new URL(request.url);
  return (
    url.searchParams.has("x-hot-updater-telemetry-key") ||
    url.searchParams.has("telemetryKey") ||
    url.searchParams.has("telemetry_key") ||
    url.searchParams.has("authorization") ||
    url.searchParams.has("cookie")
  );
};

const readTelemetryKey = (
  request: Request,
):
  | { readonly kind: "accepted"; readonly telemetryKey: string }
  | {
      readonly kind: "rejected";
      readonly invalidChannel: boolean;
    } => {
  if (
    request.headers.has("authorization") ||
    request.headers.has("cookie") ||
    hasQueryCredential(request)
  ) {
    return { kind: "rejected", invalidChannel: true };
  }

  const telemetryKey = request.headers.get("x-hot-updater-telemetry-key");
  if (!telemetryKey || !isTelemetryKeyFormat(telemetryKey)) {
    return { kind: "rejected", invalidChannel: false };
  }

  return { kind: "accepted", telemetryKey };
};

export const createNotifyAppReadyResult = async ({
  operations,
  request,
}: {
  readonly operations: FirebaseTelemetryOperations;
  readonly request: Request;
}): Promise<NotifyAppReadyResult> => {
  const analytics = createDatabaseAnalyticsRuntime(operations);
  const authenticateTelemetryKey = analytics.authenticateTelemetryKey;
  const recordLifecycleEvent = analytics.recordLifecycleEvent;
  const credential = readTelemetryKey(request);
  if (credential.kind === "rejected") {
    return {
      body: {
        error: credential.invalidChannel
          ? "Runtime telemetry must use x-hot-updater-telemetry-key"
          : "Telemetry key rejected",
      },
      status: 401,
    };
  }

  if (!(await authenticateTelemetryKey?.(credential.telemetryKey))) {
    return { body: { error: "Telemetry key rejected" }, status: 401 };
  }
  if (!recordLifecycleEvent) {
    return { body: { error: "Lifecycle telemetry write failed" }, status: 500 };
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return { body: { error: "Invalid JSON body" }, status: 400 };
    }
    return { body: { error: "Invalid JSON body" }, status: 400 };
  }

  const payload = parseLifecyclePayload(body);
  if (!payload) {
    return { body: { error: "Invalid notifyAppReady payload" }, status: 400 };
  }

  try {
    return {
      body: await recordLifecycleEvent(payload),
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

export const createFirebaseTelemetryApp = (
  operations: FirebaseTelemetryOperations,
) => {
  const app = new Hono();

  app.post("/api/notify-app-ready", async (c) => {
    const result = await createNotifyAppReadyResult({
      operations,
      request: c.req.raw,
    });

    switch (result.status) {
      case 202:
        return c.json(result.body, 202);
      case 400:
        return c.json(result.body, 400);
      case 401:
        return c.json(result.body, 401);
      case 500:
        return c.json(result.body, 500);
    }
  });

  return app;
};
