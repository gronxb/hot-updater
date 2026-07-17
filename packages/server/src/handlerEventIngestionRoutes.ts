import type { CreateBundleEventRequest } from "./db/types";
import { supportsAnalytics } from "./db/types";
import {
  HandlerBadRequestError,
  HandlerPayloadTooLargeError,
} from "./handlerErrors";
import { isPlatform } from "./handlerParameters";
import type { RouteHandler } from "./handlerTypes";

const SDK_VERSION_HEADER = "Hot-Updater-SDK-Version";
const MAX_EVENT_BODY_BYTES = 16 * 1024;
const MAX_EVENT_STRING_LENGTH = 1024;

const requireStringField = (
  payload: Record<string, unknown>,
  key: string,
): string => {
  const value = payload[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EVENT_STRING_LENGTH
  ) {
    throw new HandlerBadRequestError(`Invalid event field: ${key}`);
  }
  return value;
};

const requireNullableStringField = (
  payload: Record<string, unknown>,
  key: string,
): string | null => {
  const value = payload[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_EVENT_STRING_LENGTH) {
    throw new HandlerBadRequestError(`Invalid event field: ${key}`);
  }
  return value;
};

const readBundleEventBody = async (request: Request): Promise<unknown> => {
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_EVENT_BODY_BYTES
  ) {
    throw new HandlerPayloadTooLargeError();
  }
  if (!request.body) {
    throw new HandlerBadRequestError("Invalid event payload");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > MAX_EVENT_BODY_BYTES) {
      await reader.cancel();
      throw new HandlerPayloadTooLargeError();
    }
    text += decoder.decode(result.value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new HandlerBadRequestError("Invalid event payload");
    }
    throw error;
  }
};

const requireBundleEventPayload = (
  payload: unknown,
): CreateBundleEventRequest => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HandlerBadRequestError("Invalid event payload");
  }
  const record = payload as Record<string, unknown>;
  const type = requireStringField(record, "type");
  const platform = requireStringField(record, "platform");
  if (!isPlatform(platform)) {
    throw new HandlerBadRequestError("Invalid event field: platform");
  }
  const base = {
    installId: requireStringField(record, "installId"),
    toBundleId: requireStringField(record, "toBundleId"),
    ...(record.userId === undefined
      ? {}
      : { userId: requireStringField(record, "userId") }),
    ...(record.username === undefined
      ? {}
      : { username: requireStringField(record, "username") }),
    platform,
    appVersion: requireStringField(record, "appVersion"),
    channel: requireStringField(record, "channel"),
    cohort: requireStringField(record, "cohort"),
    fingerprintHash: requireNullableStringField(record, "fingerprintHash"),
  };
  switch (type) {
    case "UPDATE_APPLIED":
    case "RECOVERED": {
      const updateStrategy = requireStringField(record, "updateStrategy");
      if (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion") {
        throw new HandlerBadRequestError("Invalid event field: updateStrategy");
      }
      return {
        ...base,
        type,
        fromBundleId: requireStringField(record, "fromBundleId"),
        updateStrategy,
      };
    }
    case "UNCHANGED":
      if (record.fromBundleId !== null) {
        throw new HandlerBadRequestError("Invalid event field: fromBundleId");
      }
      if (record.updateStrategy !== null) {
        throw new HandlerBadRequestError("Invalid event field: updateStrategy");
      }
      return {
        ...base,
        type,
        fromBundleId: null,
        updateStrategy: null,
      };
    default:
      throw new HandlerBadRequestError("Invalid event field: type");
  }
};

export const createEventIngestionRouteHandlers = <TContext>(): Record<
  string,
  RouteHandler<TContext>
> => ({
  appendBundleEvent: async (_params, request, api, context) => {
    if (!supportsAnalytics(api)) {
      return new Response(null, { status: 404 });
    }
    const payload = requireBundleEventPayload(
      await readBundleEventBody(request),
    );
    const sdkVersion = request.headers.get(SDK_VERSION_HEADER)?.trim() ?? null;
    if (
      sdkVersion !== null &&
      (sdkVersion.length === 0 || sdkVersion.length > MAX_EVENT_STRING_LENGTH)
    ) {
      throw new HandlerBadRequestError("Invalid SDK version header");
    }
    const event: CreateBundleEventRequest & {
      readonly sdkVersion: string | null;
    } = { ...payload, sdkVersion };
    await api.appendBundleEvent(event, context);
    return new Response(null, { status: 204 });
  },
});
