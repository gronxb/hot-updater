import { createUUIDv7, type BundleEventRow } from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  assertWellFormedInsightsString,
  INSIGHTS_INGEST_BODY_MAX_BYTES,
  INSIGHTS_STRING_MAX_CODE_UNITS,
} from "@hot-updater/plugin-core/internal";

import {
  InsightsBadRequestError,
  InsightsPayloadTooLargeError,
} from "./errors";

type CreateBundleEventRequestBase = {
  readonly installId: string;
  readonly toBundleId: string;
  readonly userId?: string;
  readonly username?: string;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
  readonly sdkVersion?: string | null;
  readonly fromReleaseId: string | null;
  readonly toReleaseId: string | null;
};

type CreateBundleEventRequest =
  | (CreateBundleEventRequestBase & {
      readonly type: "UPDATE_APPLIED" | "RECOVERED" | "RELEASE_ADOPTED";
      readonly fromBundleId: string;
      readonly updateStrategy: "fingerprint" | "appVersion";
    })
  | (CreateBundleEventRequestBase & {
      readonly type: "UNCHANGED";
      readonly fromBundleId: null;
      readonly updateStrategy: null;
    });

const EVENT_BODY_MAX_BYTES = INSIGHTS_INGEST_BODY_MAX_BYTES;

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
  options: { readonly allowEmpty?: boolean } = {},
): string {
  const value = payload[key];
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > INSIGHTS_STRING_MAX_CODE_UNITS
  ) {
    throw new InsightsBadRequestError(`Invalid event field: ${key}`);
  }
  try {
    assertWellFormedInsightsString(value);
  } catch {
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
  const decoder = new TextDecoder("utf-8", { fatal: true });
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
    try {
      text += decoder.decode(result.value, { stream: true });
    } catch (error) {
      await reader.cancel();
      if (error instanceof TypeError) {
        throw new InsightsBadRequestError("Invalid event payload");
      }
      throw error;
    }
  }
  try {
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) {
      throw new InsightsBadRequestError("Invalid event payload");
    }
    throw error;
  }
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
    installId: requireStringField(payload, "installId", { allowEmpty: true }),
    toBundleId: requireStringField(payload, "toBundleId"),
    ...(payload.userId === undefined
      ? {}
      : { userId: requireStringField(payload, "userId") }),
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
  const base = {
    id: createUUIDv7(),
    install_id: input.installId,
    user_id: input.userId ?? null,
    username: input.username ?? null,
    from_release_id: input.fromReleaseId,
    to_release_id: input.toReleaseId,
    to_bundle_id: input.toBundleId,
    platform: input.platform,
    app_version: input.appVersion,
    channel: input.channel,
    cohort: input.cohort,
    fingerprint_hash: input.fingerprintHash,
    sdk_version: input.sdkVersion ?? null,
    received_at_ms: Date.now(),
  };
  const row: BundleEventRow =
    input.type === "UNCHANGED"
      ? {
          ...base,
          type: input.type,
          from_bundle_id: null,
          update_strategy: null,
        }
      : {
          ...base,
          type: input.type,
          from_bundle_id: input.fromBundleId,
          update_strategy: input.updateStrategy,
        };
  assertInsightsEventContract(row);
  return row;
}
