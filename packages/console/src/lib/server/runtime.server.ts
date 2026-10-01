import {
  type ConfiguredDatabase,
  isRemoteDatabase,
} from "@hot-updater/plugin-core";

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
} from "./console-feature-apis";

export type { ConsoleFeatureApis } from "./console-feature-apis";

export interface ConsoleRuntime {
  /** Whether the console reaches a self-hosted server through its admin API. */
  readonly remote: boolean;
  /** The features on here, from the plugins the console's config lists. */
  features(): Promise<ConsoleFeatures>;
  /** What serves the features the console can serve here; {@link requireFeature} hands it out. */
  readonly apis: Partial<ConsoleFeatureApis>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Whether one of Hot Updater's own factories made `plugin`: the brand they
 * set under a registered symbol, read here with a copy of the key so the
 * console imports no package's internals. Assembly refuses any other plugin
 * that takes one of their ids, so features key on it.
 */
const isOfficialPlugin = (plugin: unknown): boolean =>
  isRecord(plugin) &&
  Reflect.get(plugin, Symbol.for("@hot-updater/server/official-plugin")) ===
    true;

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
 * The console's features and what serves them, for the plugins its config
 * lists, the plugins the server runs:
 * - a self-hosted server (`standaloneRepository`) runs them itself; the
 *   console serves what that server's admin API serves of their features,
 *   and nothing that needs the database;
 * - otherwise the console runs them over the database, as the server does,
 *   and serves their features through `api`, their APIs.
 */
export const createConsoleRuntime = (config: {
  readonly database: ConfiguredDatabase;
  readonly plugins: readonly unknown[];
  readonly api?: Readonly<Record<string, unknown>>;
}): ConsoleRuntime => {
  const { database } = config;
  // A feature's plugin is Hot Updater's own, which alone may take its id:
  // the server's assembly refuses any other, and features key on the
  // factory's mark, so another plugin under that id turns on nothing.
  const official = new Set(
    config.plugins
      .filter(isOfficialPlugin)
      .map((plugin) => (plugin as { id: string }).id),
  );
  if (isRemoteDatabase(database)) {
    const { fetchAdmin } = database;
    const features = resolveConsoleFeatures([...official], { remote: true });
    return {
      remote: true,
      features: async () => features,
      apis: featureApis((feature) =>
        consoleFeatureApis[feature].remote?.(fetchAdmin),
      ),
    };
  }
  const api = config.api ?? {};
  const features = resolveConsoleFeatures([...official], { remote: false });
  return {
    remote: false,
    features: async () => features,
    apis: featureApis((feature) => {
      const { plugin } = consoleFeatures[feature];
      const pluginApi = official.has(plugin) ? api[plugin] : undefined;
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
