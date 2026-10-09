import type { RemoteDatabase } from "@hot-updater/plugin-core";
import type { ApiKeyManagementAPI } from "@hot-updater/server/plugins/api-keys";
import {
  createInsightsModel,
  createInsightsProvider,
  type InsightsApi,
  type InsightsModel,
} from "@hot-updater/server/plugins/insights";
import type { RemoteConfigApi } from "@hot-updater/server/plugins/remote-config";

import type { ConsoleFeature } from "../console-features";
import {
  type ConsoleInsightsReads,
  createAdminInsightsReads,
} from "./adminInsights";
import {
  type ConsoleRemoteConfig,
  createAdminRemoteConfig,
  createLocalRemoteConfig,
} from "./remoteConfig";

/** A GET on a self-hosted server's admin handler. */
export type FetchAdmin = RemoteDatabase["fetchAdmin"];

/**
 * What serves one console feature: `local` builds it from the API of the
 * feature's plugin, which the console assembles over the database as the
 * server does; `remote` builds it over a self-hosted server's admin API, for
 * a feature that API serves.
 */
export interface ConsoleFeatureApi<TPluginApi, TApi> {
  readonly local: (pluginApi: TPluginApi) => TApi;
  readonly remote?: (fetchAdmin: FetchAdmin) => TApi;
}

const featureApi = <TPluginApi, TApi>(
  api: ConsoleFeatureApi<TPluginApi, TApi>,
): ConsoleFeatureApi<TPluginApi, TApi> => api;

/** What serves each console feature, keyed like `consoleFeatures`. */
export const consoleFeatureApis = {
  insights: featureApi({
    local: (api: InsightsApi): ConsoleInsightsReads => ({
      ...createInsightsProvider(createInsightsModel(api)),
      getRetention: async () => api.retention,
      getUpdateFailures: api.getUpdateFailures,
    }),
    remote: createAdminInsightsReads,
  }),
  insightsAnalytics: featureApi({
    local: (api: InsightsApi): InsightsModel => createInsightsModel(api),
  }),
  remoteConfig: featureApi({
    local: (api: RemoteConfigApi): ConsoleRemoteConfig =>
      createLocalRemoteConfig(api),
    remote: createAdminRemoteConfig,
  }),
  apiKeys: featureApi({
    local: (api: ApiKeyManagementAPI) => api,
  }),
} satisfies {
  readonly [F in ConsoleFeature]: ConsoleFeatureApi<never, unknown>;
};

/** What serves each console feature, as its server functions use it. */
export type ConsoleFeatureApis = {
  readonly [F in ConsoleFeature]: ReturnType<
    (typeof consoleFeatureApis)[F]["local"]
  >;
};
