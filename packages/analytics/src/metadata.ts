import type { HotUpdaterVersionMetadataContribution } from "@hot-updater/server/internal/first-party-plugin";

import { resolveAnalyticsCapability, type AnalyticsProvider } from "./provider";

const ANALYTICS_METADATA_KEYS = Object.freeze([
  "analytics",
  "analyticsQueries",
  "eventIngestion",
]);

const ANALYTICS_METADATA_OPTIONAL_KEYS = Object.freeze([
  "mode",
  "maxMatchingRows",
]);

const unavailableMetadata = Object.freeze({
  analytics: false,
  analyticsQueries: false,
  eventIngestion: false,
});

export const createUnavailableAnalyticsMetadata =
  (): HotUpdaterVersionMetadataContribution =>
    Object.freeze({
      keys: ANALYTICS_METADATA_KEYS,
      namespace: "analytics",
      target: "capabilities",
      async resolve() {
        return unavailableMetadata;
      },
    } satisfies HotUpdaterVersionMetadataContribution);

export const createAnalyticsMetadata = (
  provider: AnalyticsProvider,
): HotUpdaterVersionMetadataContribution =>
  Object.freeze({
    keys: ANALYTICS_METADATA_KEYS,
    namespace: "analytics",
    optionalKeys: ANALYTICS_METADATA_OPTIONAL_KEYS,
    target: "capabilities",
    async resolve(signal) {
      const capability = await resolveAnalyticsCapability(provider, signal);
      if (!capability.analytics) return unavailableMetadata;
      return capability.mode === "bounded"
        ? Object.freeze({
            analytics: true,
            analyticsQueries: capability.analyticsQueries,
            eventIngestion: capability.eventIngestion,
            maxMatchingRows: capability.maxMatchingRows,
            mode: capability.mode,
          })
        : Object.freeze({
            analytics: true,
            analyticsQueries: capability.analyticsQueries,
            eventIngestion: capability.eventIngestion,
            mode: capability.mode,
          });
    },
  } satisfies HotUpdaterVersionMetadataContribution);
