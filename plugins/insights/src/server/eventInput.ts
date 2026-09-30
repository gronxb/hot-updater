import { createUUIDv7, isUUIDv7 } from "@hot-updater/plugin-core";

import type {
  BundleEventFailureInput,
  CreateBundleEventRequest,
  CreateBundleEventRequestBase,
} from "./domain";
import {
  InsightsBadRequestError,
  InsightsPayloadTooLargeError,
} from "./errors";
import type { BundleEventRow } from "./eventRow";

const MAX_EVENT_STRING_LENGTH = 1_024;
const MAX_IDENTITY_LENGTH = 255;
export const EVENT_BODY_MAX_BYTES = 16 * 1_024;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringField(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = payload[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EVENT_STRING_LENGTH ||
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      new TextEncoder().encode(value),
    ) !== value
  ) {
    throw new InsightsBadRequestError(`Invalid event field: ${key}`);
  }
  return value;
}

function requireNullableStringField(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  if (payload[key] === null) return null;
  return requireStringField(payload, key);
}

function requireIdentityField(
  payload: Readonly<Record<string, unknown>>,
  key: "installId" | "userId",
): string {
  const value = requireStringField(payload, key);
  if (value.length > MAX_IDENTITY_LENGTH) {
    throw new InsightsBadRequestError(`Invalid event field: ${key}`);
  }
  return value;
}

/**
 * The report's idempotency key, when the client sends one: it creates the
 * UUIDv7 once and repeats it on every retry of that report.
 */
function readEventId(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = payload.eventId;
  if (value === undefined) return undefined;
  if (!isUUIDv7(value)) {
    throw new InsightsBadRequestError("Invalid event field: eventId");
  }
  return value;
}

/** One value of an open set: any other value reads as `unknown`. */
const oneOf = <const T extends string>(
  values: readonly T[],
  value: unknown,
): T | "unknown" => (values.includes(value as T) ? (value as T) : "unknown");

const STAGES = ["check", "download", "install"] as const;
const REASONS = [
  "network",
  "http",
  "invalid_response",
  "hash_mismatch",
  "signature",
  "patch",
  "extract",
  "storage",
] as const;
const RESOURCES = [
  "catalog",
  "artifact",
  "manifest",
  "file",
  "patch",
  "archive",
] as const;
const TRANSPORTS = [
  "timeout",
  "dns",
  "tls",
  "connection",
  "offline",
  "cancelled",
] as const;
const DELIVERIES = ["patch", "manifest", "archive"] as const;

/** A storage error code or an Android exit reason: letters, digits, and `._-`. */
const CODE = /^[A-Za-z0-9._-]{1,64}$/;
const readCode = (value: unknown): string | undefined =>
  typeof value === "string" && CODE.test(value) ? value : undefined;

const readMetadata = (
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  isRecord(payload.metadata) ? payload.metadata : {};

/**
 * What an UPDATE_FAILED report says failed. It never refuses the report: an
 * unknown value of a set reads as `unknown`, a missing or malformed failure
 * as an unknown stage and reason, and a malformed optional field is left out,
 * as is a null one.
 */
function readFailure(value: unknown): BundleEventFailureInput {
  const failure = isRecord(value) ? value : {};
  const httpStatus = failure.httpStatus;
  const originCode = readCode(failure.originCode);
  const previousProcessExit = readCode(failure.previousProcessExit);
  return {
    stage: oneOf(STAGES, failure.stage),
    reason: oneOf(REASONS, failure.reason),
    ...(failure.resource == null
      ? {}
      : { resource: oneOf(RESOURCES, failure.resource) }),
    ...(Number.isSafeInteger(httpStatus) &&
    (httpStatus as number) >= 100 &&
    (httpStatus as number) <= 599
      ? { httpStatus: httpStatus as number }
      : {}),
    ...(failure.transport == null
      ? {}
      : { transport: oneOf(TRANSPORTS, failure.transport) }),
    ...(originCode === undefined ? {} : { originCode }),
    ...(previousProcessExit === undefined ? {} : { previousProcessExit }),
  };
}

async function readBoundedText(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  const declaredByteLength = Number(contentLength);
  if (
    contentLength !== null &&
    Number.isSafeInteger(declaredByteLength) &&
    declaredByteLength > EVENT_BODY_MAX_BYTES
  ) {
    throw new InsightsPayloadTooLargeError(EVENT_BODY_MAX_BYTES);
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > EVENT_BODY_MAX_BYTES) {
      await reader.cancel();
      throw new InsightsPayloadTooLargeError(EVENT_BODY_MAX_BYTES);
    }
    text += decoder.decode(result.value, { stream: true });
  }
  return text + decoder.decode();
}

async function parseJson(request: Request): Promise<unknown> {
  const text = await readBoundedText(request);
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new InsightsBadRequestError("Invalid event payload");
    }
    throw error;
  }
}

function requireEvent(payload: unknown): CreateBundleEventRequest {
  // Fields this server does not know are ignored, not refused, so a report
  // from a newer SDK that adds one still records on an older server.
  if (!isRecord(payload)) {
    throw new InsightsBadRequestError("Invalid event payload");
  }
  const platform = requireStringField(payload, "platform");
  if (platform !== "ios" && platform !== "android") {
    throw new InsightsBadRequestError("Invalid event field: platform");
  }
  const eventId = readEventId(payload);
  const base: CreateBundleEventRequestBase = {
    ...(eventId === undefined ? {} : { eventId }),
    installId: requireIdentityField(payload, "installId"),
    toBundleId: requireStringField(payload, "toBundleId"),
    ...(payload.userId === undefined
      ? {}
      : { userId: requireIdentityField(payload, "userId") }),
    platform,
    appVersion: requireStringField(payload, "appVersion"),
    channel: requireStringField(payload, "channel"),
    cohort: requireStringField(payload, "cohort"),
    fingerprintHash: requireNullableStringField(payload, "fingerprintHash"),
    sdkVersion:
      payload.sdkVersion === undefined
        ? null
        : requireNullableStringField(payload, "sdkVersion"),
    fromReleaseId: requireNullableStringField(payload, "fromReleaseId"),
    toReleaseId: requireNullableStringField(payload, "toReleaseId"),
  };
  const type = requireStringField(payload, "type");
  const movement = () => {
    const updateStrategy = requireStringField(payload, "updateStrategy");
    if (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion") {
      throw new InsightsBadRequestError("Invalid event field: updateStrategy");
    }
    return {
      ...base,
      fromBundleId: requireStringField(payload, "fromBundleId"),
      updateStrategy,
    } as const;
  };
  const metadata = readMetadata(payload);
  switch (type) {
    case "UPDATE_DOWNLOADED": {
      const delivery = metadata.delivery;
      const read = {
        ...(delivery == null ? {} : { delivery: oneOf(DELIVERIES, delivery) }),
        ...(metadata.patchFallback === true
          ? { patchFallback: true as const }
          : {}),
      };
      return {
        ...movement(),
        type,
        ...(Object.keys(read).length === 0 ? {} : { metadata: read }),
      };
    }
    case "UPDATE_APPLIED":
      return { ...movement(), type };
    case "RECOVERED": {
      const previousProcessExit = readCode(metadata.previousProcessExit);
      return {
        ...movement(),
        type,
        ...(previousProcessExit === undefined
          ? {}
          : { metadata: { previousProcessExit } }),
      };
    }
    case "UPDATE_FAILED":
      return {
        ...movement(),
        type,
        metadata: { failure: readFailure(metadata.failure) },
      };
    case "UNCHANGED":
      if (payload.fromBundleId !== null || payload.updateStrategy !== null) {
        throw new InsightsBadRequestError("Invalid unchanged event shape");
      }
      return {
        ...base,
        type,
        fromBundleId: null,
        updateStrategy: null,
      };
    default:
      throw new InsightsBadRequestError("Invalid event field: type");
  }
}

export async function parseBundleEventRequest(
  request: Request,
): Promise<CreateBundleEventRequest> {
  const payload = await parseJson(request);
  return requireEvent(payload);
}

export function createBundleEventRow(
  input: CreateBundleEventRequest,
): BundleEventRow {
  input = requireEvent(input);
  const base = {
    app_version: input.appVersion,
    channel: input.channel,
    from_release_id: input.fromReleaseId,
    // The client's ID makes a retried report the same row, which records once.
    id: input.eventId ?? createUUIDv7(),
    install_id: input.installId,
    platform: input.platform,
    received_at_ms: Date.now(),
    to_bundle_id: input.toBundleId,
    to_release_id: input.toReleaseId,
    user_id: input.userId ?? null,
  };
  const metadata = {
    cohort: input.cohort,
    fingerprint_hash: input.fingerprintHash,
    sdk_version: input.sdkVersion ?? null,
    update_strategy: input.updateStrategy,
  };
  switch (input.type) {
    case "UPDATE_DOWNLOADED": {
      const { delivery, patchFallback } = input.metadata ?? {};
      return {
        ...base,
        from_bundle_id: input.fromBundleId,
        type: input.type,
        metadata: {
          ...metadata,
          ...(delivery === undefined ? {} : { delivery }),
          ...(patchFallback ? { patch_fallback: true } : {}),
        },
      };
    }
    case "UPDATE_APPLIED":
      return {
        ...base,
        from_bundle_id: input.fromBundleId,
        type: input.type,
        metadata,
      };
    case "RECOVERED": {
      const exit = input.metadata?.previousProcessExit;
      return {
        ...base,
        from_bundle_id: input.fromBundleId,
        type: input.type,
        metadata: {
          ...metadata,
          ...(exit === undefined ? {} : { previous_process_exit: exit }),
        },
      };
    }
    case "UPDATE_FAILED": {
      const { failure } = input.metadata;
      return {
        ...base,
        from_bundle_id: input.fromBundleId,
        type: input.type,
        metadata: {
          ...metadata,
          failure: {
            stage: failure.stage,
            reason: failure.reason,
            ...(failure.resource === undefined
              ? {}
              : { resource: failure.resource }),
            ...(failure.httpStatus === undefined
              ? {}
              : { http_status: failure.httpStatus }),
            ...(failure.transport === undefined
              ? {}
              : { transport: failure.transport }),
            ...(failure.originCode === undefined
              ? {}
              : { origin_code: failure.originCode }),
            ...(failure.previousProcessExit === undefined
              ? {}
              : { previous_process_exit: failure.previousProcessExit }),
          },
        },
      };
    }
    case "UNCHANGED":
      return {
        ...base,
        from_bundle_id: null,
        type: input.type,
        metadata,
      };
  }
}
