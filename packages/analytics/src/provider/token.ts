import { defineCapability } from "@hot-updater/plugin-core";

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

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const hasProviderMode = (value: object): boolean => {
  const mode = Reflect.get(value, "mode");
  if (mode === "dedicated") return true;
  const maximum = Reflect.get(value, "maxMatchingRows");
  return (
    mode === "bounded" &&
    typeof maximum === "number" &&
    Number.isFinite(maximum) &&
    maximum > 0
  );
};

const isAnalyticsProvider = (value: unknown): value is AnalyticsProvider =>
  isObject(value) &&
  hasProviderMode(value) &&
  providerMethods.every(
    (method) => typeof Reflect.get(value, method) === "function",
  ) &&
  (Reflect.get(value, "resolveAvailability") === undefined ||
    typeof Reflect.get(value, "resolveAvailability") === "function");

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
  const analytics = Reflect.get(value, "analytics");
  if (analytics === false) {
    return Object.freeze({
      analytics: false,
      analyticsQueries: Reflect.get(value, "analyticsQueries"),
      eventIngestion: Reflect.get(value, "eventIngestion"),
    });
  }
  if (analytics !== true || !hasProviderMode(value)) {
    throw new InvalidAnalyticsCapabilityError();
  }
  const mode = Reflect.get(value, "mode");
  if (mode === "dedicated") {
    return Object.freeze({
      analytics: true,
      analyticsQueries: Reflect.get(value, "analyticsQueries"),
      eventIngestion: Reflect.get(value, "eventIngestion"),
      mode,
    });
  }
  const maxMatchingRows = Reflect.get(value, "maxMatchingRows");
  if (typeof maxMatchingRows !== "number") {
    throw new InvalidAnalyticsCapabilityError();
  }
  return Object.freeze({
    analytics: true,
    analyticsQueries: Reflect.get(value, "analyticsQueries"),
    eventIngestion: Reflect.get(value, "eventIngestion"),
    maxMatchingRows,
    mode,
  });
};

export const parseAnalyticsProvider = (value: unknown): AnalyticsProvider => {
  if (!isAnalyticsProvider(value)) {
    throw new InvalidAnalyticsProviderError();
  }
  return Object.freeze(value);
};

export const analyticsProviderToken = defineCapability<AnalyticsProvider>({
  id: "analytics-provider@1",
  parse: parseAnalyticsProvider,
});

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
