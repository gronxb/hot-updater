import {
  isRecord,
  type NotifyAppReadyPayload,
  type Platform,
} from "./supabaseTelemetryTypes";

type LifecycleStatus = "ACTIVE" | "RECOVERED";

const readString = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const property = value[key];
  return typeof property === "string" && property.length > 0 ? property : null;
};

const readOptionalString = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | null => {
  const property = value[key];
  if (property === undefined) return null;
  return typeof property === "string" && property.length > 0 ? property : null;
};

const parsePlatform = (value: string | null): Platform | null => {
  switch (value) {
    case "android":
    case "ios":
      return value;
    default:
      return null;
  }
};

const parseStatus = (value: string | null): LifecycleStatus | null => {
  switch (value) {
    case "ACTIVE":
    case "RECOVERED":
      return value;
    default:
      return null;
  }
};

export const parseNotifyAppReadyPayload = (
  value: unknown,
):
  | { readonly kind: "valid"; readonly payload: NotifyAppReadyPayload }
  | { readonly kind: "invalid" } => {
  if (!isRecord(value)) return { kind: "invalid" };

  const bundleId = readString(value, "bundleId");
  const channel = readString(value, "channel");
  const eventId = readString(value, "eventId");
  const installId = readString(value, "installId");
  const platform = parsePlatform(readString(value, "platform"));
  const status = parseStatus(readString(value, "status"));
  const observedAt = readOptionalString(value, "observedAt");

  if (!bundleId || !channel || !eventId || !installId || !platform || !status) {
    return { kind: "invalid" };
  }

  if (observedAt !== null && Number.isNaN(Date.parse(observedAt))) {
    return { kind: "invalid" };
  }

  switch (status) {
    case "ACTIVE":
      return {
        kind: "valid",
        payload:
          observedAt === null
            ? { bundleId, channel, eventId, installId, platform, status }
            : {
                bundleId,
                channel,
                eventId,
                installId,
                observedAt,
                platform,
                status,
              },
      };
    case "RECOVERED": {
      const crashedBundleId = readString(value, "crashedBundleId");
      if (!crashedBundleId) return { kind: "invalid" };
      return {
        kind: "valid",
        payload:
          observedAt === null
            ? {
                bundleId,
                channel,
                crashedBundleId,
                eventId,
                installId,
                platform,
                status,
              }
            : {
                bundleId,
                channel,
                crashedBundleId,
                eventId,
                installId,
                observedAt,
                platform,
                status,
              },
      };
    }
  }
};

export const readJsonBody = async (
  request: Request,
): Promise<
  { readonly kind: "valid"; readonly value: unknown } | { readonly kind: "invalid" }
> => {
  try {
    return { kind: "valid", value: await request.json() };
  } catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return { kind: "invalid" };
    }
    throw error;
  }
};
