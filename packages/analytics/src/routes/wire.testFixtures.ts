import {
  attachCapabilityContribution,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import {
  createHotUpdater,
  type RuntimeHotUpdaterAPI,
} from "@hot-updater/server";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import {
  analytics,
  type AnalyticsFeature,
  type AnalyticsFeatureAvailable,
} from "../analytics";
import { analyticsProviderToken, type AnalyticsProvider } from "../provider";
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

const withTestProvider = (
  database: DatabasePlugin,
  provider: AnalyticsProvider,
): DatabasePlugin =>
  attachCapabilityContribution(database, {
    token: analyticsProviderToken,
    create: () => provider,
  });

type WireRuntime<TFeature> = Pick<RuntimeHotUpdaterAPI, "handler"> & {
  readonly features: Readonly<{ readonly analytics: TFeature }>;
};

export const createAnalyticsWireRuntime = (
  provider: AnalyticsProvider = createTestProvider(),
): {
  readonly provider: AnalyticsProvider;
  readonly runtime: WireRuntime<AnalyticsFeatureAvailable>;
} => {
  const manifest = analytics({
    missingCapability: "error",
    queryAccess: "public",
  });
  const runtime = createHotUpdater({
    basePath: "/hot-updater",
    coreRoutes: { bundles: false, updateCheck: false },
    database: withTestProvider(createInMemoryDatabasePlugin(), provider),
    plugins: [manifest],
  });
  return { provider, runtime };
};

export const createUnavailableAnalyticsWireRuntime =
  (): WireRuntime<AnalyticsFeature> => {
    const manifest = analytics({
      missingCapability: "warn",
      queryAccess: "public",
    });
    return createHotUpdater({
      basePath: "/hot-updater",
      coreRoutes: { bundles: false, updateCheck: false },
      database: createInMemoryDatabasePlugin(),
      plugins: [manifest],
    });
  };
