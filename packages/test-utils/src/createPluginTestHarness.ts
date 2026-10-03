import {
  coreSchema,
  createEngine,
  createMemoryAdapter,
  type DatabaseAdapter,
  type HotUpdaterDatabase,
  meterReads,
  type ModuleSchema,
  toolingTargetOf,
  verifyAdapter,
} from "@hot-updater/plugin-core";

interface HarnessPlugin {
  readonly id: string;
  readonly schemaVersion: string;
  readonly schema: ModuleSchema;
  /** `false` keeps the declared table names, as `createHotUpdater` does. */
  readonly namespace?: false;
  init(context: never): { readonly api: unknown };
}

export interface PluginTestHarnessOptions {
  /** Defaults to a fresh memory adapter. */
  readonly adapter?: DatabaseAdapter;
  /** The plugin's clock; `setNow` changes it later. */
  readonly now?: () => number;
}

/**
 * Runs one plugin on `createEngine`, the storage engine `createHotUpdater`
 * runs its plugins on, so tests can call its API and measure what each call
 * reads. Every adapter call is checked against the adapter contract
 * (`verifyAdapter`), and `ctx.core` is empty: core's reads need a server.
 * The engine gets the adapter without `prune`, as a store that expires rows
 * itself would give it, so no retention pass adds to what a call reads and
 * writes; rows stay past their retention.
 */
export const createPluginTestHarness = async <TPlugin extends HarnessPlugin>(
  plugin: TPlugin,
  options: PluginTestHarnessOptions = {},
) => {
  const adapter = options.adapter ?? createMemoryAdapter();
  const core = new Set(coreSchema.tables.map(({ name }) => name));
  const tables = toolingTargetOf([plugin]).schema.tables.filter(
    ({ name }) => !core.has(name),
  );
  await adapter.migrations?.apply(tables);
  let clock = options.now ?? Date.now;
  const now = () => clock();
  const database = meterReads({
    name: "plugin test harness",
    adapter: verifyAdapter(
      Object.assign(Object.create(adapter) as DatabaseAdapter, {
        prune: undefined,
      }),
    ),
  });
  const db = createEngine(database, { plugins: [plugin], now }).database(
    plugin,
  ) as HotUpdaterDatabase<TPlugin["schema"]>;
  const instance = plugin.init({ db, core: {}, now } as never) as ReturnType<
    TPlugin["init"]
  >;
  return {
    api: instance.api as ReturnType<TPlugin["init"]>["api"],
    instance,
    /** The plugin's own database handle. */
    db,
    adapter,
    /** The plugin's physical tables. */
    tables,
    /** Reads at the adapter and at the engine while `read` runs. */
    measureReads: database.measureReads,
    setNow: (next: () => number) => {
      clock = next;
    },
  };
};
