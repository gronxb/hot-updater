import {
  attachCapabilityContribution,
  type CapabilityToken,
} from "@hot-updater/plugin-core";
import { defineSharedCapability } from "@hot-updater/plugin-core/internal/capabilities";

import { parseAnalyticsProvider } from "../provider/token";
import type { AnalyticsProvider } from "../provider/types";

export * from "../provider";

type AnalyticsProviderCarrier<TCarrier extends object> = TCarrier extends (
  ...args: never[]
) => unknown
  ? never
  : TCarrier;

export const analyticsProviderCapability: CapabilityToken<AnalyticsProvider> =
  defineSharedCapability({
    id: "hot-updater.analytics.provider@1",
    parse: parseAnalyticsProvider,
  });

export function attachAnalyticsProviderCapability<TCarrier extends object>(
  carrier: AnalyticsProviderCarrier<TCarrier>,
  createProvider: () => AnalyticsProvider,
): TCarrier {
  return attachCapabilityContribution(carrier, {
    create: createProvider,
    token: analyticsProviderCapability,
  });
}
