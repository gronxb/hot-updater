import type {
  NotifyAppReadyAnalyticsEvent,
  NotifyAppReadyResult,
  PersistedUpdateStrategy,
} from "./notifyAppReadyTypes";

type RawNotifyAppReadyResult = {
  readonly crashedBundleId: unknown;
  readonly fromBundleId: unknown;
  readonly status: unknown;
  readonly toBundleId: unknown;
  readonly updateStrategy: unknown;
};

type NotifyAppReadyNativeDependencies = {
  readonly getActiveBundleId: () => string;
  readonly resolveBundleId: (bundleId: string | null) => string;
};

export type NotifyAppReadyReadResult = {
  readonly analyticsEvent: NotifyAppReadyAnalyticsEvent | null;
  readonly pending: boolean;
  readonly result: NotifyAppReadyResult;
};

const EMPTY_RAW_RESULT = {
  crashedBundleId: undefined,
  fromBundleId: undefined,
  status: undefined,
  toBundleId: undefined,
  updateStrategy: undefined,
} as const satisfies RawNotifyAppReadyResult;

const readRawObject = (value: unknown): RawNotifyAppReadyResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return EMPTY_RAW_RESULT;
  }

  return {
    crashedBundleId:
      "crashedBundleId" in value ? value.crashedBundleId : undefined,
    fromBundleId: "fromBundleId" in value ? value.fromBundleId : undefined,
    status: "status" in value ? value.status : undefined,
    toBundleId: "toBundleId" in value ? value.toBundleId : undefined,
    updateStrategy:
      "updateStrategy" in value ? value.updateStrategy : undefined,
  };
};

const readRawResult = (value: unknown): RawNotifyAppReadyResult => {
  if (typeof value !== "string") {
    return readRawObject(value);
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return readRawObject(parsed);
  } catch {
    return EMPTY_RAW_RESULT;
  }
};

const readDirectionalBundleId = (
  value: unknown,
  resolveBundleId: NotifyAppReadyNativeDependencies["resolveBundleId"],
): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const bundleId = value.trim();
  return bundleId.length > 0 ? resolveBundleId(bundleId) : null;
};

const isPersistedUpdateStrategy = (
  value: unknown,
): value is PersistedUpdateStrategy => {
  return value === "appVersion" || value === "fingerprint";
};

const getPublicResult = (
  rawResult: RawNotifyAppReadyResult,
  dependencies: NotifyAppReadyNativeDependencies,
): NotifyAppReadyResult => {
  if (
    rawResult.status === "UPDATE_APPLIED" ||
    rawResult.status === "PROMOTED"
  ) {
    const fromBundleId = readDirectionalBundleId(
      rawResult.fromBundleId,
      dependencies.resolveBundleId,
    );
    const toBundleId = readDirectionalBundleId(
      rawResult.toBundleId,
      dependencies.resolveBundleId,
    );
    if (fromBundleId && toBundleId) {
      return { fromBundleId, status: "UPDATE_APPLIED", toBundleId };
    }
  }

  if (rawResult.status === "RECOVERED") {
    const fromBundleId =
      readDirectionalBundleId(
        rawResult.fromBundleId,
        dependencies.resolveBundleId,
      ) ??
      readDirectionalBundleId(
        rawResult.crashedBundleId,
        dependencies.resolveBundleId,
      );
    const toBundleId =
      readDirectionalBundleId(
        rawResult.toBundleId,
        dependencies.resolveBundleId,
      ) ?? (fromBundleId ? dependencies.getActiveBundleId() : null);
    if (fromBundleId && toBundleId) {
      return { fromBundleId, status: "RECOVERED", toBundleId };
    }
  }

  return { status: "UNCHANGED" };
};

const getAnalyticsEvent = (
  rawResult: RawNotifyAppReadyResult,
  resolveBundleId: NotifyAppReadyNativeDependencies["resolveBundleId"],
): NotifyAppReadyAnalyticsEvent | null => {
  if (!isPersistedUpdateStrategy(rawResult.updateStrategy)) {
    return null;
  }

  const fromBundleId = readDirectionalBundleId(
    rawResult.fromBundleId,
    resolveBundleId,
  );
  const toBundleId = readDirectionalBundleId(
    rawResult.toBundleId,
    resolveBundleId,
  );
  if (!fromBundleId || !toBundleId) {
    return null;
  }

  if (
    rawResult.status === "UPDATE_APPLIED" ||
    rawResult.status === "PROMOTED"
  ) {
    return {
      fromBundleId,
      toBundleId,
      type: "UPDATE_APPLIED",
      updateStrategy: rawResult.updateStrategy,
    };
  }

  if (rawResult.status === "RECOVERED") {
    return {
      fromBundleId,
      toBundleId,
      type: "RECOVERED",
      updateStrategy: rawResult.updateStrategy,
    };
  }

  return null;
};

export const readNativeNotifyAppReady = (
  value: unknown,
  dependencies: NotifyAppReadyNativeDependencies,
): NotifyAppReadyReadResult => {
  const rawResult = readRawResult(value);

  return {
    analyticsEvent: getAnalyticsEvent(rawResult, dependencies.resolveBundleId),
    pending: rawResult.status === "PENDING",
    result: getPublicResult(rawResult, dependencies),
  };
};
