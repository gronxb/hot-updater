import { createUUIDv7, type BundleEventRow } from "@hot-updater/plugin-core";

import type {
  CreateBundleEventRequest,
  CreateBundleEventRequestBase,
} from "./domain";
import {
  InsightsBadRequestError,
  InsightsPayloadTooLargeError,
} from "./errors";

const MAX_EVENT_STRING_LENGTH = 1_024;
const MAX_IDENTITY_LENGTH = 255;
export const EVENT_BODY_MAX_BYTES = 16 * 1_024;

const eventKeys = new Set([
  "type",
  "installId",
  "toBundleId",
  "userId",
  "username",
  "platform",
  "appVersion",
  "channel",
  "cohort",
  "fingerprintHash",
  "fromBundleId",
  "fromReleaseId",
  "toReleaseId",
  "updateStrategy",
  "sdkVersion",
]);

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
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => !eventKeys.has(key))
  ) {
    throw new InsightsBadRequestError("Invalid event payload");
  }
  const platform = requireStringField(payload, "platform");
  if (platform !== "ios" && platform !== "android") {
    throw new InsightsBadRequestError("Invalid event field: platform");
  }
  const base: CreateBundleEventRequestBase = {
    installId: requireIdentityField(payload, "installId"),
    toBundleId: requireStringField(payload, "toBundleId"),
    ...(payload.userId === undefined
      ? {}
      : { userId: requireIdentityField(payload, "userId") }),
    ...(payload.username === undefined
      ? {}
      : { username: requireStringField(payload, "username") }),
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
  switch (type) {
    case "UPDATE_APPLIED":
    case "RECOVERED":
    case "RELEASE_ADOPTED": {
      const updateStrategy = requireStringField(payload, "updateStrategy");
      if (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion") {
        throw new InsightsBadRequestError(
          "Invalid event field: updateStrategy",
        );
      }
      return {
        ...base,
        type,
        fromBundleId: requireStringField(payload, "fromBundleId"),
        updateStrategy,
      };
    }
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
    cohort: input.cohort,
    fingerprint_hash: input.fingerprintHash,
    from_release_id: input.fromReleaseId,
    id: createUUIDv7(),
    install_id: input.installId,
    platform: input.platform,
    received_at_ms: Date.now(),
    sdk_version: input.sdkVersion ?? null,
    to_bundle_id: input.toBundleId,
    to_release_id: input.toReleaseId,
    user_id: input.userId ?? null,
    username: input.username ?? null,
  };
  switch (input.type) {
    case "UPDATE_APPLIED":
    case "RECOVERED":
    case "RELEASE_ADOPTED":
      return {
        ...base,
        from_bundle_id: input.fromBundleId,
        type: input.type,
        update_strategy: input.updateStrategy,
      };
    case "UNCHANGED":
      return {
        ...base,
        from_bundle_id: null,
        type: input.type,
        update_strategy: null,
      };
  }
}
