import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

import { coreModule, HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import { createEngineMigrator } from "../db/engineMigrator";
import { migrateSchema } from "../db/schemaSettings";
import type { ToolingDatabase, ToolingTarget } from "../db/types";
import { apiKeys, apiKeysSchema } from "../plugins/api-keys";
import { builtInPlugin } from "../plugins/builtIn";
import { insights, insightsSchema } from "../plugins/insights";
import type { ModelShape } from "./definitions";
import {
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  isMissingSchemaError,
  readSettings,
  withSchemaFence,
  type SchemaSettings,
} from "./fence";
import { resolveSchema, type SchemaModule } from "./resolveSchema";

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

/** The tables the cacheable client routes answer from: the update check reads one catalog row. */
const CACHED_ROUTE_TABLES = new Set([
  builtInSchema.models.get("release_catalogs")!.table.name,
]);

export interface EngineDatabaseOptions {
  readonly name: string;
  readonly adapter: DatabaseAdapter;
  /**
   * Called after a committed write that changes what the cacheable client
   * routes answer, so a CDN in front of them can purge its copies. A check
   * only guards a row it read, so it changes nothing.
   */
  readonly onCachedRoutesChange?: () => Promise<void>;
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
    adapter:
      onCachedRoutesChange === undefined
        ? fenced
        : {
            ...fenced,
            async write(ops) {
              const result = await fenced.write(ops);
              if (
                result.ok &&
                ops.some(
                  (op) =>
                    op.type !== "check" &&
                    CACHED_ROUTE_TABLES.has(op.table.name),
                )
              ) {
                await onCachedRoutesChange();
              }
              return result;
            },
          },
    ...(adapter.dispose === undefined
      ? {}
      : { dispose: () => adapter.dispose!() }),
    ...(adapter.migrations === undefined ? {} : { createMigrator }),
  };
};
