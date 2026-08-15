import type {
  CreateBundleEventRequest,
  CreateBundleEventRequestBase,
} from "./domain";
import {
  AnalyticsBadRequestError,
  AnalyticsPayloadTooLargeError,
} from "./errors";

const SDK_VERSION_HEADER = "Hot-Updater-SDK-Version";
const MAX_EVENT_STRING_LENGTH = 1_024;
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
  "updateStrategy",
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
    value.length > MAX_EVENT_STRING_LENGTH
  ) {
    throw new AnalyticsBadRequestError(`Invalid event field: ${key}`);
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
    throw new AnalyticsPayloadTooLargeError(EVENT_BODY_MAX_BYTES);
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
      throw new AnalyticsPayloadTooLargeError(EVENT_BODY_MAX_BYTES);
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
      throw new AnalyticsBadRequestError("Invalid event payload");
    }
    throw error;
  }
}

function requireEvent(
  payload: unknown,
  sdkVersion: string | null,
): CreateBundleEventRequest {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => !eventKeys.has(key))
  ) {
    throw new AnalyticsBadRequestError("Invalid event payload");
  }
  const platform = requireStringField(payload, "platform");
  if (platform !== "ios" && platform !== "android") {
    throw new AnalyticsBadRequestError("Invalid event field: platform");
  }
  const base: CreateBundleEventRequestBase = {
    installId: requireStringField(payload, "installId"),
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
    sdkVersion,
  };
  const type = requireStringField(payload, "type");
  switch (type) {
    case "UPDATE_APPLIED":
    case "RECOVERED": {
      const updateStrategy = requireStringField(payload, "updateStrategy");
      if (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion") {
        throw new AnalyticsBadRequestError(
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
        throw new AnalyticsBadRequestError("Invalid unchanged event shape");
      }
      return {
        ...base,
        type,
        fromBundleId: null,
        updateStrategy: null,
      };
    default:
      throw new AnalyticsBadRequestError("Invalid event field: type");
  }
}

export async function parseBundleEventRequest(
  request: Request,
): Promise<CreateBundleEventRequest> {
  const payload = await parseJson(request);
  const sdkVersion = request.headers.get(SDK_VERSION_HEADER)?.trim() ?? null;
  if (
    sdkVersion !== null &&
    (sdkVersion.length === 0 || sdkVersion.length > MAX_EVENT_STRING_LENGTH)
  ) {
    throw new AnalyticsBadRequestError("Invalid SDK version header");
  }
  return requireEvent(payload, sdkVersion);
}
