import type { EngineDatabase } from "@hot-updater/plugin-core";
import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

import { coreModule, HOT_UPDATER_SCHEMA_VERSION } from "../core/schema";
import { migrateSchema } from "../db/schemaSettings";
import { apiKeys, apiKeysSchema } from "../plugins/api-keys";
import { insights, insightsSchema } from "../plugins/insights";
import {
  ENGINE_SCHEMA_KEY,
  ENGINE_SCHEMA_VERSION,
  withSchemaFence,
  type SchemaSettings,
} from "./fence";
import { resolveSchema } from "./resolveSchema";

/**
 * Core's tables and the built-in plugins' (Insights and API keys): the tables
 * every provider's tooling creates, whichever plugins a server runs.
 */
export const builtInSchema = resolveSchema([
  coreModule,
  { id: "insights", schema: insightsSchema },
  { id: "apiKeys", schema: apiKeysSchema },
]);

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
 */
export const createEngineDatabase = ({
  name,
  adapter,
  onCachedRoutesChange,
}: EngineDatabaseOptions): EngineDatabase => {
  const fenced = withSchemaFence(adapter, name, builtInSettings);
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
  };
};
