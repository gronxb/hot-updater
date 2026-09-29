import {
  createMemoryAdapter,
  type DatabaseAdapter,
  type DatabaseReadCount,
  type PhysicalTable,
} from "@hot-updater/plugin-core/internal";

interface HarnessModule {
  readonly id: string;
  readonly schema: object;
  readonly namespace?: string;
}

interface HarnessEngine {
  database(module: HarnessModule): unknown;
  measureReads<T>(read: () => Promise<T>): Promise<{
    readonly result: T;
    readonly adapter: DatabaseReadCount;
    readonly engine: { readonly calls: number; readonly rows: number };
  }>;
}

/**
 * What the harness takes from `@hot-updater/server/database`; pass that
 * module, which keeps test-utils free of a dependency on the server.
 */
export interface PluginTestEngine {
  resolveSchema(modules: readonly HarnessModule[]): {
    readonly tables: readonly PhysicalTable[];
  };
  createDatabaseEngine(options: {
    readonly adapter: DatabaseAdapter;
    readonly schema: never;
    readonly verify?: boolean;
  }): HarnessEngine;
}

interface HarnessPlugin {
  readonly id: string;
  readonly schema: object;
  init(context: never): { readonly api: unknown };
}

export interface PluginTestHarnessOptions {
  /** `import * as engine from "@hot-updater/server/database"`. */
  readonly engine: PluginTestEngine;
  /** Defaults to a fresh memory adapter. */
  readonly adapter?: DatabaseAdapter;
  /** The plugin's clock; `setNow` changes it later. */
  readonly now?: () => number;
}

const builtInPlugin = Symbol.for("@hot-updater/server/built-in-plugin");

/**
 * Runs one plugin the way `createHotUpdater` does, on a memory adapter in
 * verify mode, so tests can call its API and measure what each call reads.
 */
export const createPluginTestHarness = async <TPlugin extends HarnessPlugin>(
  plugin: TPlugin,
  options: PluginTestHarnessOptions,
) => {
  const adapter = options.adapter ?? createMemoryAdapter();
  const module: HarnessModule = {
    id: plugin.id,
    schema: plugin.schema,
    ...(builtInPlugin in plugin ? {} : { namespace: plugin.id }),
  };
  const schema = options.engine.resolveSchema([module]);
  await adapter.migrations?.apply(schema.tables);
  const engine = options.engine.createDatabaseEngine({
    adapter,
    schema: schema as never,
    verify: true,
  });
  let clock = options.now ?? Date.now;
  const db = engine.database(module);
  const instance = plugin.init({
    db,
    core: {},
    now: () => clock(),
  } as never) as ReturnType<TPlugin["init"]>;
  return {
    api: instance.api as ReturnType<TPlugin["init"]>["api"],
    instance,
    /** The plugin's own database handle; cast it to its `HotUpdaterDatabase` type. */
    db,
    adapter,
    tables: schema.tables,
    /** Reads at both boundaries while `read` runs. */
    measureReads: <T>(read: () => Promise<T>) => engine.measureReads(read),
    setNow: (now: () => number) => {
      clock = now;
    },
  };
};
