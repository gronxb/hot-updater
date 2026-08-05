import {
  InvalidAnalyticsCapabilityError,
  InvalidAnalyticsProviderError,
} from "../errors";
import type { AnalyticsProvider, ReportedAnalyticsCapability } from "./types";

const providerMethods = [
  "appendBundleEvent",
  "getBundleEventSummary",
  "getBundleEventAnalytics",
  "getBundleEventOverview",
  "getActiveInstallationOverview",
  "searchInstallations",
  "getInstallationHistory",
] as const;

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasProviderMode(value: object): boolean {
  const mode = Reflect.get(value, "mode");
  if (mode === "dedicated") return true;
  const maximum = Reflect.get(value, "maxMatchingRows");
  return (
    mode === "bounded" &&
    typeof maximum === "number" &&
    Number.isSafeInteger(maximum) &&
    maximum > 0
  );
}

function isAnalyticsProvider(value: unknown): value is AnalyticsProvider {
  return (
    isObject(value) &&
    hasProviderMode(value) &&
    providerMethods.every(
      (method) => typeof Reflect.get(value, method) === "function",
    ) &&
    (Reflect.get(value, "resolveAvailability") === undefined ||
      typeof Reflect.get(value, "resolveAvailability") === "function")
  );
}

export const parseReportedAnalyticsCapability = (
  value: unknown,
): ReportedAnalyticsCapability => {
  if (
    !isObject(value) ||
    typeof Reflect.get(value, "eventIngestion") !== "boolean" ||
    typeof Reflect.get(value, "analyticsQueries") !== "boolean"
  ) {
    throw new InvalidAnalyticsCapabilityError();
  }
  const analyticsQueries = Reflect.get(value, "analyticsQueries");
  const eventIngestion = Reflect.get(value, "eventIngestion");
  const analytics = Reflect.get(value, "analytics");
  if (
    typeof analyticsQueries !== "boolean" ||
    typeof eventIngestion !== "boolean"
  ) {
    throw new InvalidAnalyticsCapabilityError();
  }
  if (analytics === false) {
    return Object.freeze({
      analytics: false,
      analyticsQueries,
      eventIngestion,
    });
  }
  if (analytics !== true || !hasProviderMode(value)) {
    throw new InvalidAnalyticsCapabilityError();
  }
  const mode = Reflect.get(value, "mode");
  if (mode === "dedicated") {
    return Object.freeze({
      analytics: true,
      analyticsQueries,
      eventIngestion,
      mode,
    });
  }
  const maxMatchingRows = Reflect.get(value, "maxMatchingRows");
  if (typeof maxMatchingRows !== "number") {
    throw new InvalidAnalyticsCapabilityError();
  }
  return Object.freeze({
    analytics: true,
    analyticsQueries,
    eventIngestion,
    maxMatchingRows,
    mode: "bounded",
  });
};

export const parseAnalyticsProvider = (value: unknown): AnalyticsProvider => {
  if (!isAnalyticsProvider(value)) throw new InvalidAnalyticsProviderError();
  return value;
};

export const resolveAnalyticsCapability = async (
  provider: AnalyticsProvider,
  signal: AbortSignal,
): Promise<ReportedAnalyticsCapability> => {
  if (provider.resolveAvailability !== undefined) {
    return parseReportedAnalyticsCapability(
      await provider.resolveAvailability(signal),
    );
  }
  return provider.mode === "bounded"
    ? Object.freeze({
        analytics: true,
        analyticsQueries: true,
        eventIngestion: true,
        maxMatchingRows: provider.maxMatchingRows,
        mode: "bounded",
      })
    : Object.freeze({
        analytics: true,
        analyticsQueries: true,
        eventIngestion: true,
        mode: "dedicated",
      });
};
