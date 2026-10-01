import { HotUpdaterConfigError } from "../serverPlugin/configError";
import type { HotUpdaterDatabase } from "../serverPlugin/databaseHandle";
import type { ModuleSchema } from "../serverPlugin/schema";
import type { EngineDatabase } from "../types/databaseConfig";
import { coreModule, type CoreSchema } from "./core/schema";
import { aggregateBatchingModule } from "./database/aggregateBatching";
import { createDatabaseEngine } from "./database/database";
import { fencedName, SETTINGS_TABLE, withSchemaFence } from "./database/fence";
import { readMeterOf } from "./database/readMeter";
import {
  resolveSchema,
  type SchemaModule,
  validateSchema,
} from "./database/resolveSchema";
import { pruneDuringWrites } from "./database/retention";
import {
  type PluginTables,
  pluginModule,
  pluginSettings,
} from "./db/coreDatabase";
import type { DatabaseTooling } from "./db/types";

export interface EngineOptions {
  /**
   * The plugins whose tables the engine serves beside core's. On a database
   * from `createEngineDatabase`, each one's `schema.<id>` settings row is
   * checked before the first read or write, as core's are.
   */
  readonly plugins?: readonly PluginTables[];
  /** The clock retention passes and aggregate batching run on; `Date.now` by default. */
  readonly now?: () => number;
}

/** Core's tables and the plugins' on one storage engine. */
export interface Engine {
  /** Core's tables: bundles, Releases, Release Catalogs, and channels. */
  readonly core: HotUpdaterDatabase<CoreSchema>;
  /** A plugin's tables, by the plugin `createEngine` was given. */
  database<TSchema extends ModuleSchema>(plugin: {
    readonly id: string;
    readonly schema: TSchema;
  }): HotUpdaterDatabase<TSchema>;
  /**
   * Applies aggregate changes the database batches that are still pending:
   * this process's buffer, and the log rows no compaction has merged yet.
   */
  flush(): Promise<void>;
  /** Stops batching's timer after a last flush. */
  dispose(): Promise<void>;
}

/**
 * How to create plugins' tables on a database, by the tooling it offers:
 * what the plugins' schema fence names when their settings rows are missing.
 */
const pluginTablesFix = (database: EngineDatabase) => {
  const { createMigrator, generateSchema } = database as EngineDatabase &
    DatabaseTooling;
  const managed =
    "A managed server runs only its provider's plugins, and rerunning `hot-updater init --provider <provider>` applies the provider's migrations.";
  return createMigrator !== undefined
    ? `Run \`hot-updater db migrate\`. ${managed}`
    : generateSchema !== undefined
      ? `Run \`hot-updater db generate\` and apply the file it writes. ${managed}`
      : managed;
};

/**
 * The storage engine over a database, as a server runs it: core's tables
 * and the plugins', with the plugins' settings rows fenced on a fenced
 * database, expired rows pruned during writes, aggregates batched when the
 * database batches them, and reads metered when it came from `meterReads`.
 * `createHotUpdater` runs core and its plugins on one; tests and tools run
 * a plugin on one without a server. Wrap the adapter with `verifyAdapter`
 * to check every call against the adapter contract.
 */
export const createEngine = (
  database: EngineDatabase,
  { plugins = [], now = Date.now }: EngineOptions = {},
): Engine => {
  const modules = new Map<string, SchemaModule>();
  for (const plugin of plugins) {
    if (plugin.id === coreModule.id) {
      throw new HotUpdaterConfigError(
        `Plugin id "${plugin.id}" is core's own.`,
      );
    }
    if (modules.has(plugin.id)) {
      throw new HotUpdaterConfigError(
        `Plugin "${plugin.id}" is registered twice.`,
      );
    }
    modules.set(plugin.id, pluginModule(plugin) as SchemaModule);
  }
  // Tooling creates the tables of the plugins a server runs, so their names
  // need to be free of core's and of each other's, not of anyone else's.
  if (modules.size > 0) validateSchema([coreModule, ...modules.values()]);
  // A fenced database also waits for each plugin's settings row.
  const name = fencedName(database.adapter);
  const fenced =
    name === undefined || plugins.length === 0
      ? database.adapter
      : withSchemaFence(
          database.adapter,
          name,
          pluginSettings(plugins),
          pluginTablesFix(database),
        );
  const batching = database.aggregateBatching;
  const schema = resolveSchema([
    coreModule,
    ...modules.values(),
    ...(batching === undefined ? [] : [aggregateBatchingModule]),
  ]);
  const meter = readMeterOf(database);
  const engine = createDatabaseEngine({
    adapter: pruneDuringWrites(fenced, schema.tables, {
      leaseTable: SETTINGS_TABLE,
      now,
    }),
    schema,
    ...(database.retry === undefined ? {} : { retry: database.retry }),
    ...(batching === undefined ? {} : { batching, now }),
    ...(meter === undefined ? {} : { meter }),
  });
  return {
    core: engine.database(coreModule),
    database: (plugin) => {
      const module = modules.get(plugin.id);
      if (module === undefined) {
        throw new HotUpdaterConfigError(
          `Plugin "${plugin.id}" is not one of this engine's plugins.`,
        );
      }
      return engine.database(
        module as SchemaModule & { readonly schema: ModuleSchema },
      ) as never;
    },
    flush: () => engine.flush(),
    dispose: () => engine.dispose(),
  };
};
