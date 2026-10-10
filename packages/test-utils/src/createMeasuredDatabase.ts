import {
  type AnyHotUpdaterPlugin,
  type ClientAuth,
  type DatabaseAdapter,
  type HotUpdaterCoreApi,
  meterReads,
  type PluginApis,
  type ReadMeasurement,
  type StorageAdapter,
  verifyAdapter,
} from "@hot-updater/plugin-core";

/** How core reads bundle manifests and resolves the file URLs of `storage://` URIs. */
export interface MeasuredDatabaseStorage {
  readonly readStorageText?: (storageUri: string) => Promise<string | null>;
  readonly resolveFileUrl: (storageUri: string) => Promise<string>;
}

export interface MeasuredDatabaseOptions {
  /**
   * The plugins' clock, which they read through `ctx.now`. Core's
   * timestamps and the retention passes run on `Date.now`.
   */
  readonly now?: () => number;
  /**
   * The storage of `storage://` URIs, for reads that resolve them, such as
   * artifact resolution; without it those reads fail.
   */
  readonly storage?: MeasuredDatabaseStorage;
}

/** Core and the plugins' APIs on `createHotUpdater`, with the database's read meter. */
export interface MeasuredDatabase<TApi = Readonly<Record<string, unknown>>> {
  readonly core: HotUpdaterCoreApi;
  readonly api: TApi;
  /** The client-route policy, when a plugin provides one. */
  readonly clientAuth?: ClientAuth;
  /** Runs `read` and reports what it read at the adapter and at the engine. */
  measureReads<T>(read: () => Promise<T>): Promise<ReadMeasurement<T>>;
}

const storageOf = (storage: MeasuredDatabaseStorage): StorageAdapter => ({
  name: "measuredStorage",
  protocol: "storage",
  get: async ({ storageUri }) => {
    const text = (await storage.readStorageText?.(storageUri)) ?? null;
    return { response: text === null ? null : new Response(text) };
  },
  getDownloadUrl: async ({ storageUri }) => ({
    url: await storage.resolveFileUrl(storageUri),
  }),
});

/**
 * Core and the plugins over `adapter` as `createHotUpdater` runs them: what
 * read-budget suites measure. The database is `meterReads` over
 * `verifyAdapter(adapter)`, so every adapter call is checked against the
 * contract and `measureReads` reports each call's reads; the adapter runs
 * as given, without the schema fence. It loads `@hot-updater/server`, an
 * optional peer, when called.
 */
export const createMeasuredDatabase = async <
  const TPlugins extends readonly AnyHotUpdaterPlugin[],
>(
  adapter: DatabaseAdapter,
  plugins: TPlugins,
  options: MeasuredDatabaseOptions = {},
): Promise<MeasuredDatabase<PluginApis<TPlugins>>> => {
  const { createHotUpdater } = await import("@hot-updater/server");
  let clientAuth: ClientAuth | undefined;
  // Each plugin as given, its brand included, with init seeing the clock and
  // handing back its clientAuth, which the server keeps to itself.
  const observed = plugins.map((plugin) =>
    Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(plugin),
        init: {
          configurable: true,
          enumerable: true,
          writable: true,
          value: (context: { readonly now: () => number }) => {
            const instance = plugin.init(
              (options.now === undefined
                ? context
                : { ...context, now: options.now }) as never,
            );
            if (instance.clientAuth !== undefined) {
              clientAuth = instance.clientAuth;
            }
            return instance;
          },
        },
      },
    ),
  );
  const database = meterReads({
    name: "measured",
    adapter: verifyAdapter(adapter),
  });
  const hotUpdater = createHotUpdater({
    database,
    storage:
      options.storage === undefined
        ? // Owns no URI, so reads that resolve one fail.
          { name: "measuredStorage", protocol: "none" }
        : storageOf(options.storage),
    plugins: observed,
    ...(plugins.some((plugin) => plugin.provides?.clientAuth === true)
      ? {}
      : { clientAccess: "public" }),
  } as never);
  return {
    core: hotUpdater.core,
    api: hotUpdater.api as PluginApis<TPlugins>,
    ...(clientAuth === undefined ? {} : { clientAuth }),
    measureReads: database.measureReads,
  };
};
