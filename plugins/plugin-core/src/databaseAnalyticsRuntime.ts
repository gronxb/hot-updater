import type {
  DatabaseAnalyticsOperations,
  HotUpdaterContext,
  TelemetryKeyResult,
  TelemetryKeyState,
  TelemetryLifecycleMetrics,
  TelemetryLifecyclePayload,
  TelemetryLifecycleRecordResult,
} from "./types";

const TELEMETRY_KEY_BYTES = 32;
const TELEMETRY_KEY_PREFIX = "hutk_";
const TELEMETRY_KEY_SUFFIX_LENGTH = 8;

export interface DatabaseAnalyticsRuntime<TContext = unknown> {
  authenticateTelemetryKey?: (
    telemetryKey: string,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<boolean>;
  getTelemetryKeyState?: (
    context?: HotUpdaterContext<TContext>,
  ) => Promise<TelemetryKeyState | null>;
  issueTelemetryKey?: (
    context?: HotUpdaterContext<TContext>,
  ) => Promise<TelemetryKeyResult>;
  readLifecycleMetrics?: (
    context?: HotUpdaterContext<TContext>,
  ) => Promise<TelemetryLifecycleMetrics>;
  recordLifecycleEvent?: (
    payload: TelemetryLifecyclePayload,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<TelemetryLifecycleRecordResult>;
  rotateTelemetryKey?: (
    context?: HotUpdaterContext<TContext>,
  ) => Promise<TelemetryKeyResult>;
}

const createTelemetryKey = (): string => {
  const bytes = new Uint8Array(TELEMETRY_KEY_BYTES);
  crypto.getRandomValues(bytes);
  const entropy = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${TELEMETRY_KEY_PREFIX}${entropy}`;
};

const telemetryKeySuffix = (telemetryKey: string): string =>
  telemetryKey.slice(-TELEMETRY_KEY_SUFFIX_LENGTH);

const hashTelemetryKey = async (telemetryKey: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(telemetryKey),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const hasTelemetryKeyShape = (value: string): boolean =>
  value.startsWith(TELEMETRY_KEY_PREFIX) &&
  value.length > TELEMETRY_KEY_PREFIX.length;

const safeEqual = (left: string, right: string): boolean => {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < maxLength; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
};

const issueTelemetryKey = async <TContext>(
  upsertTelemetryKeyCredential: NonNullable<
    DatabaseAnalyticsOperations<TContext>["upsertTelemetryKeyCredential"]
  >,
  context?: HotUpdaterContext<TContext>,
): Promise<TelemetryKeyResult> => {
  const telemetryKey = createTelemetryKey();
  const suffix = telemetryKeySuffix(telemetryKey);
  await upsertTelemetryKeyCredential(
    {
      keyHash: await hashTelemetryKey(telemetryKey),
      telemetryKeySuffix: suffix,
    },
    context,
  );

  return {
    telemetryKey,
    telemetryKeySuffix: suffix,
  };
};

export const createDatabaseAnalyticsRuntime = <TContext = unknown>(
  analytics: DatabaseAnalyticsOperations<TContext>,
): DatabaseAnalyticsRuntime<TContext> => {
  const runtime: DatabaseAnalyticsRuntime<TContext> = {};

  const getTelemetryKeyCredential = analytics.getTelemetryKeyCredential;
  if (getTelemetryKeyCredential) {
    runtime.authenticateTelemetryKey = async (telemetryKey, context) => {
      if (!hasTelemetryKeyShape(telemetryKey)) return false;

      const credential = await getTelemetryKeyCredential(context);
      if (
        !credential ||
        telemetryKeySuffix(telemetryKey) !== credential.telemetryKeySuffix
      ) {
        return false;
      }

      return safeEqual(
        await hashTelemetryKey(telemetryKey),
        credential.keyHash,
      );
    };

    runtime.getTelemetryKeyState = async (context) => {
      const credential = await getTelemetryKeyCredential(context);
      return credential
        ? { telemetryKeySuffix: credential.telemetryKeySuffix }
        : null;
    };
  }

  const upsertTelemetryKeyCredential = analytics.upsertTelemetryKeyCredential;
  if (upsertTelemetryKeyCredential) {
    runtime.issueTelemetryKey = (context) =>
      issueTelemetryKey(upsertTelemetryKeyCredential, context);
    runtime.rotateTelemetryKey = (context) =>
      issueTelemetryKey(upsertTelemetryKeyCredential, context);
  }

  const getLifecycleMetrics = analytics.getLifecycleMetrics;
  if (getLifecycleMetrics) {
    runtime.readLifecycleMetrics = (context) => getLifecycleMetrics(context);
  }

  const insertLifecycleEvent = analytics.insertLifecycleEvent;
  if (insertLifecycleEvent) {
    runtime.recordLifecycleEvent = (payload, context) =>
      insertLifecycleEvent(payload, context);
  }

  return runtime;
};
