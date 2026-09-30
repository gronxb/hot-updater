import {
  type ConfiguredDatabase,
  isRemoteDatabase,
} from "@hot-updater/plugin-core";
import { createDatabasePluginApis } from "@hot-updater/server/db";

import {
  type ConsoleFeature,
  ConsoleFeatureUnavailableError,
  type ConsoleFeatures,
  consoleFeatures,
  resolveConsoleFeatures,
} from "../console-features";
import {
  type ConsoleFeatureApis,
  consoleFeatureApis,
  type FetchAdmin,
} from "./console-feature-apis";

export type { ConsoleFeatureApis } from "./console-feature-apis";

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

const featureIds = Object.keys(consoleFeatureApis) as ConsoleFeature[];

/**
 * What serves each feature, built by its factory: over the plugins' APIs the
 * console assembled, or over a self-hosted server's admin API. A feature
 * without its plugin, or without a factory for the admin API, has none.
 */
const featureApis = (
  build: (feature: ConsoleFeature) => unknown,
): Partial<ConsoleFeatureApis> =>
  Object.fromEntries(
    featureIds.flatMap((feature) => {
      const api = build(feature);
      return api === undefined ? [] : [[feature, api]];
    }),
  );

/**
 * The console's features and what serves them, for a console config:
 * - a self-hosted server (`standaloneRepository`) runs its plugins and lists
 *   them on its admin `/version`; the console serves what that server's admin
 *   API serves, and nothing that needs the database;
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
      apis: featureApis((feature) =>
        consoleFeatureApis[feature].remote?.(fetchAdmin),
      ),
    };
  }
  const api = createDatabasePluginApis(database, config.plugins ?? []);
  const features = resolveConsoleFeatures(Object.keys(api), { remote: false });
  return {
    remote: false,
    features: async () => features,
    // A feature reads the plugin with its plugin's id, taken to be Hot
    // Updater's own, as a self-hosted server's /version list is.
    apis: featureApis((feature) => {
      const pluginApi = api[consoleFeatures[feature].plugin];
      return pluginApi === undefined
        ? undefined
        : consoleFeatureApis[feature].local(pluginApi as never);
    }),
  };
};

/**
 * What serves `feature`. Every feature's server function asks for it first,
 * so a feature the console does not serve is refused with one error the
 * client recognizes, before anything is read.
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
