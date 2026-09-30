import type { AggregateBatching } from "@hot-updater/plugin-core";
import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

import { coreModule, HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import type { ModelShape } from "../database/definitions";
import {
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  isMissingSchemaError,
  readSettings,
  withSchemaFence,
  type SchemaSettings,
} from "../database/fence";
import { resolveSchema, type SchemaModule } from "../database/resolveSchema";
import { apiKeys, apiKeysSchema } from "../plugins/api-keys";
import { builtInPlugin } from "../plugins/builtIn";
import { insights, insightsSchema } from "../plugins/insights";
import { createEngineMigrator } from "./engineMigrator";
import { migrateSchema } from "./schemaSettings";
import type { ToolingDatabase, ToolingTarget } from "./types";

/** Core and the built-in plugins: their tables keep their names. */
export const builtInModules: readonly SchemaModule[] = [
  coreModule,
  { id: "insights", schema: insightsSchema },
  { id: "apiKeys", schema: apiKeysSchema },
];

/**
 * Core's tables and the built-in plugins' (Insights and API keys): the tables
 * every provider's tooling creates, whichever plugins a server runs.
 */
export const builtInSchema = resolveSchema(builtInModules);

/** The settings rows a provider's database is fenced by. */
export const builtInSettings: SchemaSettings = {
  [ENGINE_SCHEMA_KEY]: ENGINE_SCHEMA_VERSION,
  "schema.core": HOT_UPDATER_SCHEMA_VERSION,
  "schema.insights": insights().schemaVersion,
  "schema.apiKeys": apiKeys().schemaVersion,
};

/** Creates the built-in tables, then writes their settings rows. */
export const migrateBuiltInSchema = (adapter: DatabaseAdapter, name: string) =>
  migrateSchema(adapter, name, builtInSchema.tables, builtInSettings);

/** What `hot-updater db` creates for a server without third-party plugins. */
export const builtInTarget: ToolingTarget = {
  schema: builtInSchema,
  settings: builtInSettings,
};

/** A plugin as the tooling reads it: its id, its tables, and their version. */
export interface PluginTables {
  readonly id: string;
  readonly schemaVersion: string;
  readonly schema: Readonly<Record<string, ModelShape>>;
}

const addedPlugins = (plugins: readonly PluginTables[]) =>
  plugins.filter((plugin) => !(builtInPlugin in plugin));

/** Each third-party plugin's `schema.<id>` settings row. */
export const addedSettings = (
  plugins: readonly PluginTables[],
): SchemaSettings =>
  Object.fromEntries(
    addedPlugins(plugins).map(({ id, schemaVersion }) => [
      `schema.${id}`,
      schemaVersion,
    ]),
  );

/**
 * What `hot-updater db` creates for a server's plugins: the built-in tables,
 * then each third-party plugin's tables with its `schema.<id>` settings row.
 */
export const toolingTargetOf = (
  plugins: readonly PluginTables[],
): ToolingTarget => {
  const settings = addedSettings(plugins);
  if (Object.keys(settings).length === 0) return builtInTarget;
  return {
    schema: resolveSchema([
      ...builtInModules,
      ...addedPlugins(plugins).map(({ id, schema }) => ({
        id,
        schema,
        namespace: id,
      })),
    ]),
    settings: { ...builtInSettings, ...settings },
  };
};

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
}

/**
 * A provider's database on the storage engine: its adapter behind the schema
 * fence, which checks the built-in settings rows before the first read or
 * write and names `hot-updater db migrate` when they are missing or stale.
 * When the adapter creates its own tables, `hot-updater db migrate` creates
 * the built-in tables and the server's plugin tables, then writes their
 * settings rows.
 */
export const createEngineDatabase = ({
  name,
  adapter,
  onCachedRoutesChange,
  aggregateBatching,
}: EngineDatabaseOptions): ToolingDatabase => {
  const fenced = withSchemaFence(adapter, name, builtInSettings);
  const createMigrator = ({ schema, settings } = builtInTarget) =>
    createEngineMigrator({
      adapterName: name,
      adapter,
      schema,
      settings,
      readSettings: async () => {
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
      },
    });
  return {
    name,
    adapter: fenced,
    ...(onCachedRoutesChange === undefined ? {} : { onCachedRoutesChange }),
    ...(aggregateBatching ? { aggregateBatching } : {}),
    ...(adapter.dispose === undefined
      ? {}
      : { dispose: () => adapter.dispose!() }),
    ...(adapter.migrations === undefined ? {} : { createMigrator }),
  };
};
