import {
  createHotUpdater,
  type RuntimeHotUpdaterAPI,
} from "@hot-updater/server";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { analytics, type AnalyticsFeatureAvailable } from "../analytics";
import { attachAnalyticsProviderCapability } from "../internal/provider-capability";
import type { AnalyticsProvider } from "../provider";
import { createTestProvider } from "../testing/createTestProvider";

export const testEventPayload = Object.freeze({
  appVersion: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprintHash: null,
  fromBundleId: "bundle-0",
  installId: "install-1",
  platform: "ios",
  toBundleId: "bundle-1",
  type: "UPDATE_APPLIED",
  updateStrategy: "appVersion",
} as const);

type WireRuntime<TFeature> = Pick<RuntimeHotUpdaterAPI, "handler"> & {
  readonly features: Readonly<{ readonly analytics: TFeature }>;
};

export const createAnalyticsWireRuntime = (
  provider: AnalyticsProvider = createTestProvider(),
): {
  readonly provider: AnalyticsProvider;
  readonly runtime: WireRuntime<AnalyticsFeatureAvailable>;
} => {
  const manifest = analytics({ queryAccess: "public" });
  const runtime = createHotUpdater({
    basePath: "/hot-updater",
    routes: { bundles: false, updateCheck: false },
    database: attachAnalyticsProviderCapability(
      createInMemoryDatabasePlugin(),
      () => provider,
    ),
    plugins: [manifest],
  });
  return { provider, runtime };
};

export const createUnavailableAnalyticsWireRuntime =
  (): WireRuntime<AnalyticsFeatureAvailable> => {
    const provider: AnalyticsProvider = {
      ...createTestProvider(),
      resolveAvailability: async () => ({
        analytics: false,
        analyticsQueries: false,
        eventIngestion: false,
      }),
    };
    const manifest = analytics({ queryAccess: "public" });
    return createHotUpdater({
      basePath: "/hot-updater",
      routes: { bundles: false, updateCheck: false },
      database: attachAnalyticsProviderCapability(
        createInMemoryDatabasePlugin(),
        () => provider,
      ),
      plugins: [manifest],
    });
  };
