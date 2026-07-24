import type { CreateBundleEventRequest } from "../domain";
import { AnalyticsBadRequestError } from "./support";

const SDK_VERSION_HEADER = "Hot-Updater-SDK-Version";
const MAX_EVENT_STRING_LENGTH = 1024;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireStringField = (
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const value = payload[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EVENT_STRING_LENGTH
  ) {
    throw new AnalyticsBadRequestError(`Invalid event field: ${key}`);
  }
  return value;
};

const requireNullableStringField = (
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const value = payload[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_EVENT_STRING_LENGTH) {
    throw new AnalyticsBadRequestError(`Invalid event field: ${key}`);
  }
  return value;
};

const parseJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new AnalyticsBadRequestError("Invalid event payload");
    }
    throw error;
  }
};

const requirePlatform = (
  payload: Readonly<Record<string, unknown>>,
): "ios" | "android" => {
  const platform = requireStringField(payload, "platform");
  if (platform !== "ios" && platform !== "android") {
    throw new AnalyticsBadRequestError("Invalid event field: platform");
  }
  return platform;
};

const requireUpdateStrategy = (
  payload: Readonly<Record<string, unknown>>,
): "fingerprint" | "appVersion" => {
  const updateStrategy = requireStringField(payload, "updateStrategy");
  if (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion") {
    throw new AnalyticsBadRequestError("Invalid event field: updateStrategy");
  }
  return updateStrategy;
};

const requireEvent = (
  payload: unknown,
  sdkVersion: string | null,
): CreateBundleEventRequest => {
  if (!isRecord(payload)) {
    throw new AnalyticsBadRequestError("Invalid event payload");
  }
  const type = requireStringField(payload, "type");
  const platform = requirePlatform(payload);
  const base = {
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
  switch (type) {
    case "UPDATE_APPLIED":
    case "RECOVERED":
      return {
        ...base,
        type,
        fromBundleId: requireStringField(payload, "fromBundleId"),
        updateStrategy: requireUpdateStrategy(payload),
      };
    case "UNCHANGED":
      if (payload.fromBundleId !== null) {
        throw new AnalyticsBadRequestError("Invalid event field: fromBundleId");
      }
      if (payload.updateStrategy !== null) {
        throw new AnalyticsBadRequestError(
          "Invalid event field: updateStrategy",
        );
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
};

export const parseBundleEventRequest = async (
  request: Request,
): Promise<CreateBundleEventRequest> => {
  const payload = await parseJson(request);
  const sdkVersion = request.headers.get(SDK_VERSION_HEADER)?.trim() ?? null;
  if (
    sdkVersion !== null &&
    (sdkVersion.length === 0 || sdkVersion.length > MAX_EVENT_STRING_LENGTH)
  ) {
    throw new AnalyticsBadRequestError("Invalid SDK version header");
  }
  return requireEvent(payload, sdkVersion);
};
