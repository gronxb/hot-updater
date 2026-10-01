import {
  type ConfiguredDatabase,
  isRemoteServer,
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
 * - otherwise the server definition runs `plugins` over its database, and
 *   the console serves their features through `api`, the definition's.
 */
export const createConsoleRuntime = (config: {
  readonly database: ConfiguredDatabase;
  readonly plugins?: readonly unknown[];
  readonly api?: Readonly<Record<string, unknown>>;
}): ConsoleRuntime => {
  const { database } = config;
  if (isRemoteServer(database)) {
    const { fetchAdmin } = database;
    // The server's assembly refuses a plugin that takes a reserved id
    // without the mark, so its /version ids name Hot Updater's own plugins.
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
  const plugins = config.plugins ?? [];
  const api = config.api ?? {};
  // A feature's plugin is Hot Updater's own, which alone may take its id:
  // assembly refuses any other, and features key on the factory's mark.
  const official = new Set(
    plugins
      .filter(isOfficialPlugin)
      .map((plugin) => (plugin as { id: string }).id),
  );
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
