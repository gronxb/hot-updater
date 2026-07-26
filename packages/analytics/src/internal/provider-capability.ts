import {
  attachCapabilityContribution,
  type CapabilityToken,
} from "@hot-updater/plugin-core";
import { defineSharedCapability } from "@hot-updater/plugin-core/internal/capabilities";

import { parseAnalyticsProvider } from "../provider/token";
import type { AnalyticsProvider } from "../provider/types";

export * from "../provider";

export const analyticsProviderCapability: CapabilityToken<AnalyticsProvider> =
  defineSharedCapability({
    id: "hot-updater.analytics.provider@1",
    parse: parseAnalyticsProvider,
  });

export const attachAnalyticsProviderCapability = <TCarrier extends object>(
  carrier: TCarrier,
  createProvider: () => AnalyticsProvider,
): TCarrier =>
  attachCapabilityContribution(carrier, {
    create: createProvider,
    token: analyticsProviderCapability,
  });
