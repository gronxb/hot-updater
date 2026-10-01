import type { DatabaseAdapter, PhysicalTable } from "../../database/adapter";
import type { AggregateBatching } from "../../types/databaseConfig";
import { coreModule, HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import { aggregateBatchingModule } from "../database/aggregateBatching";
import type { ModelShape } from "../database/definitions";
import type { RetryOptions } from "../database/engineTransaction";
import {
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  isMissingSchemaError,
  readSettings,
  withSchemaFence,
  type SchemaSettings,
} from "../database/fence";
import { resolveSchema } from "../database/resolveSchema";
import { createEngineMigrator } from "./engineMigrator";
import { migrateSchema } from "./schemaSettings";
import type { ToolingDatabase, ToolingTarget } from "./types";

/** Core's tables: the tables every provider's tooling creates. */
export const coreSchema = resolveSchema([coreModule]);

/** The settings rows a provider's database is fenced by. */
export const coreSettings: SchemaSettings = {
  [ENGINE_SCHEMA_KEY]: ENGINE_SCHEMA_VERSION,
  "schema.core": HOT_UPDATER_SCHEMA_VERSION,
};

/** What `hot-updater db` creates for a server without plugins. */
export const coreTarget: ToolingTarget = {
  schema: coreSchema,
  settings: coreSettings,
};

/**
 * The log and lease tables a database with `aggregateBatching` writes
 * beside core's and the plugins', which a provider's access policy names,
 * such as the managed AWS server's IAM role.
 */
export const aggregateBatchingTables: readonly PhysicalTable[] = resolveSchema([
  aggregateBatchingModule,
]).tables;

/** A plugin as the tooling reads it: its id, its tables, and their version. */
export interface PluginTables {
  readonly id: string;
  readonly schemaVersion: string;
  readonly schema: Readonly<Record<string, ModelShape>>;
  /** `false` keeps the declared table names instead of prefixing them with the id. */
  readonly namespace?: false;
}

/** Each plugin's `schema.<id>` settings row. */
export const pluginSettings = (
  plugins: readonly PluginTables[],
): SchemaSettings =>
  Object.fromEntries(
    plugins.map(({ id, schemaVersion }) => [`schema.${id}`, schemaVersion]),
  );

/** A plugin's schema as the engine resolves it: prefixed by its id unless it keeps its names. */
export const pluginModule = <TSchema>({
  id,
  schema,
  namespace,
}: {
  readonly id: string;
  readonly schema: TSchema;
  readonly namespace?: false;
}) => ({
  id,
  schema,
  ...(namespace === false ? {} : { namespace: id }),
});

/**
 * What `hot-updater db` creates for a server's plugins: core's tables, then
 * each plugin's tables with its `schema.<id>` settings row.
 */
export const toolingTargetOf = (
  plugins: readonly PluginTables[],
): ToolingTarget =>
  plugins.length === 0
    ? coreTarget
    : {
        schema: resolveSchema([coreModule, ...plugins.map(pluginModule)]),
        settings: { ...coreSettings, ...pluginSettings(plugins) },
      };

/**
 * Creates core's tables and those of `plugins`, then writes their settings
 * rows: what a provider's setup runs for the plugins its server runs.
 */
export const migrateCoreSchema = (
  adapter: DatabaseAdapter,
  name: string,
  plugins: readonly PluginTables[] = [],
) => {
  const { schema, settings } = toolingTargetOf(plugins);
  return migrateSchema(adapter, name, schema.tables, settings);
};

/** `createEngineDatabase`'s options. */
export interface EngineDatabaseOptions {
  readonly name: string;
  readonly adapter: DatabaseAdapter;
  /**
   * Purges a CDN's copies of the cacheable client routes. Core calls it after
   * a committed write that changes what those routes answer, since only core
   * knows which of its tables they read.
   */
  readonly onCachedRoutesChange?: () => Promise<void>;
  /**
   * Batches aggregates declared `batched`, for stores that bill each write;
   * `false` or absent commits them with each transaction.
   */
  readonly aggregateBatching?: AggregateBatching | false;
  /**
   * How a transaction that conflicts with another write runs again: more
   * attempts for a store many writers contend on, and `onRetry` to observe
   * each rerun. 8 attempts by default.
   */
  readonly retry?: RetryOptions;
  /**
   * How `hot-updater db migrate` reads the stored settings rows, by key; by
   * default through the adapter. An adapter whose earlier versions stored
   * them elsewhere reads them itself, so the migrator refuses a database
   * from before the storage engine.
   */
  readonly readSettings?: () => Promise<ReadonlyMap<string, unknown>>;
}

/**
 * A provider's database on the storage engine: its adapter behind the schema
 * fence, which checks core's settings rows before the first read or write
 * and names `hot-updater db migrate` when they are missing or stale. When the
 * adapter creates its own tables, `hot-updater db migrate` creates core's
 * tables and the server's plugin tables, then writes their settings rows.
 */
export const createEngineDatabase = ({
  name,
  adapter,
  onCachedRoutesChange,
  aggregateBatching,
  retry,
  readSettings: readStored,
}: EngineDatabaseOptions): ToolingDatabase => {
  const fenced = withSchemaFence(adapter, name, coreSettings);
  const createMigrator = ({ schema, settings } = coreTarget) =>
    createEngineMigrator({
      adapterName: name,
      adapter,
      schema,
      settings,
      readSettings:
        readStored ??
        (async () => {
          const rows = await readSettings(adapter, Object.keys(settings)).catch(
            (error: unknown) => {
              if (isMissingSchemaError(error)) return [];
              throw error;
            },
          );
          return new Map(
            rows.flatMap((row) =>
              row === null ? [] : [[String(row.key), row.value]],
            ),
          );
        }),
    });
  return {
    name,
    adapter: fenced,
    ...(onCachedRoutesChange === undefined ? {} : { onCachedRoutesChange }),
    ...(aggregateBatching ? { aggregateBatching } : {}),
    ...(retry === undefined ? {} : { retry }),
    ...(adapter.dispose === undefined
      ? {}
      : { dispose: () => adapter.dispose!() }),
    ...(adapter.migrations === undefined ? {} : { createMigrator }),
  };
};
