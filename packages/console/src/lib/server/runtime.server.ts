import {
  type ConfiguredDatabase,
  type InsightsModel,
  isRemoteDatabase,
} from "@hot-updater/plugin-core";
import {
  type ApiKeyManagementAPI,
  createInsightsProvider,
} from "@hot-updater/server";
import { createDatabasePluginApis } from "@hot-updater/server/db";
import {
  createInsightsModel,
  type InsightsApi,
} from "@hot-updater/server/plugins/insights";

import {
  type ConsoleFeature,
  ConsoleFeatureUnavailableError,
  type ConsoleFeatures,
  resolveConsoleFeatures,
} from "../console-features";
import {
  type ConsoleInsightsDeletion,
  type ConsoleInsightsReads,
  createAdminInsightsDeletion,
  createAdminInsightsReads,
  type FetchAdmin,
} from "./adminInsights";

/** What serves each console feature. */
export interface ConsoleFeatureApis {
  readonly insights: ConsoleInsightsReads;
  readonly insightsAnalytics: InsightsModel;
  readonly insightsDeletion: ConsoleInsightsDeletion;
  readonly apiKeys: ApiKeyManagementAPI;
}

export interface ConsoleRuntime {
  /** Whether the console reaches a self-hosted server through its admin API. */
  readonly remote: boolean;
  /** The features on here, resolved once from the plugins the server runs. */
  features(): Promise<ConsoleFeatures>;
  /** What serves the features the console can serve here; {@link requireFeature} hands it out. */
  readonly apis: Partial<ConsoleFeatureApis>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The ids of the plugins a self-hosted server lists on its admin `/version`. */
const readServerPlugins = async (
  fetchAdmin: FetchAdmin,
): Promise<readonly string[]> => {
  const response = await fetchAdmin("/version");
  if (!response.ok) {
    throw new Error(`The server answered /version with ${response.status}.`);
  }
  const body: unknown = await response.json();
  const plugins = isRecord(body) ? body.plugins : undefined;
  // A server from before `/version` listed its plugins reports none, so the
  // console serves none of their features until the server is upgraded.
  return Array.isArray(plugins)
    ? plugins.filter((id): id is string => typeof id === "string")
    : [];
};

/** Runs `load` once and keeps its result; a failure is not kept, so the next call retries. */
const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    }));
};

/** What serves the Insights features, over the `insights()` plugin's API. */
const insightsFeatureApis = (api: InsightsApi) => {
  const model = createInsightsModel(api);
  return {
    insights: {
      ...createInsightsProvider(model),
      getRetention: async () => api.retention,
    },
    insightsAnalytics: model,
    insightsDeletion: api,
  };
};

/**
 * The console's features and what serves them, for a console config:
 * - a self-hosted server (`standaloneRepository`) runs its plugins and lists
 *   them on its admin `/version`; the console reads and deletes its Insights
 *   events and installations through its admin API, and nothing that needs
 *   the database;
 * - otherwise the console assembles `plugins` over the database, as the
 *   server does, and serves the features of the plugins it assembled.
 */
export const createConsoleRuntime = (config: {
  readonly database: ConfiguredDatabase;
  readonly plugins?: readonly unknown[];
}): ConsoleRuntime => {
  const { database } = config;
  if (isRemoteDatabase(database)) {
    const { fetchAdmin } = database;
    return {
      remote: true,
      features: once(async () =>
        resolveConsoleFeatures(await readServerPlugins(fetchAdmin), {
          remote: true,
        }),
      ),
      apis: {
        insights: createAdminInsightsReads(fetchAdmin),
        insightsDeletion: createAdminInsightsDeletion(fetchAdmin),
      },
    };
  }
  const api = createDatabasePluginApis(database, config.plugins ?? []);
  const features = resolveConsoleFeatures(Object.keys(api), { remote: false });
  // Assembly refuses a third-party plugin with a built-in plugin's id, so
  // each id holds that built-in plugin's API.
  const insightsApi = api.insights as InsightsApi | undefined;
  return {
    remote: false,
    features: async () => features,
    apis: {
      ...(insightsApi === undefined ? {} : insightsFeatureApis(insightsApi)),
      ...(api.apiKeys === undefined
        ? {}
        : { apiKeys: api.apiKeys as ApiKeyManagementAPI }),
    },
  };
};

/**
 * What serves `feature`. Every Insights and API key server function asks
 * for it first, so a feature the console does not serve is refused with one
 * error the client recognizes, before anything is read.
 */
export const requireFeature = async <F extends ConsoleFeature>(
  runtime: ConsoleRuntime,
  feature: F,
): Promise<ConsoleFeatureApis[F]> => {
  const api = runtime.apis[feature];
  if (api === undefined || !(await runtime.features())[feature]) {
    throw new ConsoleFeatureUnavailableError(feature, {
      remote: runtime.remote,
    });
  }
  return api as ConsoleFeatureApis[F];
};
