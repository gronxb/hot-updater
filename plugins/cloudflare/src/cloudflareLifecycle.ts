import { createTelemetryAnalyticsEvent } from "@hot-updater/plugin-core";

import type { CloudflareTelemetryD1Database } from "./cloudflareTelemetryD1";

export type CloudflareLifecycleStatus = "ACTIVE" | "RECOVERED";
export type CloudflareLifecycleEventType = "active" | "recovered";
export type CloudflareLifecyclePlatform = "ios" | "android";

export type CloudflareLifecycleRecordInput = {
  readonly bundleId: string;
  readonly channel: string;
  readonly crashedBundleId?: string;
  readonly eventId: string;
  readonly installId: string;
  readonly observedAt?: string;
  readonly platform: CloudflareLifecyclePlatform;
  readonly status: CloudflareLifecycleStatus;
};

export type ParsedCloudflareLifecycleRecord = CloudflareLifecycleRecordInput & {
  readonly eventType: CloudflareLifecycleEventType;
  readonly observedAt: string;
};

export type CloudflareNotifyAppReadyResponse = {
  readonly accepted: true;
  readonly deduped: boolean;
};

const readRecordValue = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.entries(value).find(([entryKey]) => entryKey === key)?.[1];
};

const readRequiredString = (value: unknown, key: string): string | null => {
  const field = readRecordValue(value, key);
  return typeof field === "string" && field.length > 0 ? field : null;
};

const readOptionalString = (
  value: unknown,
  key: string,
): string | undefined => {
  const field = readRecordValue(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

const readPlatform = (value: unknown): CloudflareLifecyclePlatform | null => {
  const platform = readRequiredString(value, "platform");
  if (platform === "ios" || platform === "android") {
    return platform;
  }
  return null;
};

const readStatus = (value: unknown): CloudflareLifecycleStatus | null => {
  const status = readRequiredString(value, "status");
  if (status === "ACTIVE" || status === "RECOVERED") {
    return status;
  }
  return null;
};

const parseObservedAt = (value: string | undefined): string | null => {
  if (value === undefined) {
    return new Date().toISOString();
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const canonicalInput = value.includes(".")
    ? value
    : value.replace("Z", ".000Z");
  const observedAt = new Date(timestamp).toISOString();
  return observedAt === canonicalInput ? observedAt : null;
};

const assertNever = (value: never): never => {
  throw new TypeError(`Unexpected lifecycle status: ${value}`);
};

const eventTypeForStatus = (
  status: CloudflareLifecycleStatus,
): CloudflareLifecycleEventType => {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "RECOVERED":
      return "recovered";
    default:
      return assertNever(status);
  }
};

export const parseCloudflareLifecycleRecord = (
  value: unknown,
): ParsedCloudflareLifecycleRecord | null => {
  const bundleId = readRequiredString(value, "bundleId");
  const channel = readRequiredString(value, "channel");
  const eventId = readRequiredString(value, "eventId");
  const installId = readRequiredString(value, "installId");
  const platform = readPlatform(value);
  const status = readStatus(value);
  const crashedBundleId = readOptionalString(value, "crashedBundleId");
  const observedAt = parseObservedAt(readOptionalString(value, "observedAt"));

  if (
    !bundleId ||
    !channel ||
    !eventId ||
    !installId ||
    !platform ||
    !status ||
    !observedAt
  ) {
    return null;
  }

  if (status === "RECOVERED" && crashedBundleId === undefined) {
    return null;
  }

  return {
    bundleId,
    channel,
    crashedBundleId,
    eventId,
    eventType: eventTypeForStatus(status),
    installId,
    observedAt,
    platform,
    status,
  };
};

export const recordCloudflareLifecycleEvent = async (
  db: CloudflareTelemetryD1Database,
  event: ParsedCloudflareLifecycleRecord,
): Promise<CloudflareNotifyAppReadyResponse> => {
  const analyticsEvent = createTelemetryAnalyticsEvent(
    event,
    new Date().toISOString(),
  );
  const insertResult = await db
    .prepare(`
      INSERT INTO analytics_events (
        id,
        event_type,
        payload,
        observed_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `)
    .bind(
      analyticsEvent.id,
      analyticsEvent.eventType,
      JSON.stringify(analyticsEvent.payload),
      analyticsEvent.observedAt,
      analyticsEvent.receivedAt,
    )
    .run();
  const insertMeta = readRecordValue(insertResult, "meta");
  const insertChanges = readRecordValue(insertMeta, "changes");
  const rowsWritten = readRecordValue(insertMeta, "rows_written");
  const inserted =
    typeof insertChanges === "number"
      ? insertChanges > 0
      : typeof rowsWritten === "number"
        ? rowsWritten > 0
        : true;
  if (!inserted) {
    return { accepted: true, deduped: true };
  }

  return { accepted: true, deduped: false };
};
