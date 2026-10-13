import { CosmosClient, type CosmosClientOptions } from "@azure/cosmos";
import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createKvAdapter,
  encodeKvKey,
  migrateCoreSchema,
  type PluginTables,
  SETTINGS_TABLE,
  toolingTargetOf,
} from "@hot-updater/plugin-core";

import {
  AZURE_COSMOS_V1_CONTAINER,
  AZURE_COSMOS_V1_DATABASE,
} from "./azureInfrastructureNames";
import {
  COSMOS_PARTITION,
  cosmosItemId,
  createCosmosStore,
} from "./cosmosStore";

/** The settings row that names the storage layout the container holds. */
const ENGINE_KEY = "schema.engine";

/**
 * The client's options: the account's `connectionString`, or its
 * `endpoint` with a `key` or Microsoft Entra `aadCredentials`.
 */
export type CosmosDatabaseConfig = CosmosClientOptions & {
  /** The database the container lives in. @default "hot-updater" */
  readonly databaseId?: string;
  /** The one container the database keeps its items in. @default "hot_updater_v1" */
  readonly containerId?: string;
  /**
   * Cosmos DB bills each item a write touches, so Insights' aggregates are
   * batched: through log rows a compaction merges (the default), or
   * `{ mode: "memory" }` on a long-lived server. `false` commits them with
   * each event.
   */
  readonly aggregateBatching?: EngineDatabase["aggregateBatching"] | false;
};

const adapterOf = (config: CosmosDatabaseConfig) => {
  const {
    databaseId = AZURE_COSMOS_V1_DATABASE,
    containerId = AZURE_COSMOS_V1_CONTAINER,
    aggregateBatching: _,
    ...connection
  } = config;
  const client = new CosmosClient(connection);
  const store = createCosmosStore({ client, databaseId, containerId });
  return {
    client,
    container: client.database(databaseId).container(containerId),
    adapter: createKvAdapter({ store }),
  };
};

/**
 * Refuses a container the migration must not touch: one whose
 * `schema.engine` is another storage layout's, or a populated one without
 * the marker. Writing the settings would make the server read it as this
 * layout.
 */
const assertMigratable = async (
  { container }: ReturnType<typeof adapterOf>,
  expected: string | undefined,
) => {
  // Point reads and a scan: a reused container may index nothing yet, and
  // the migration only fixes its indexing once this check passes.
  const missing = (error: unknown) =>
    (error as { code?: unknown }).code === 404;
  try {
    // No database or container yet: the migration creates them.
    if ((await container.read()).resource === undefined) return;
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  // A missing item reads as no resource.
  const { resource } = await container
    .item(
      cosmosItemId({ pk: SETTINGS_TABLE.name, sk: encodeKvKey([ENGINE_KEY]) }),
      COSMOS_PARTITION,
    )
    .read<{ row?: { value?: unknown } }>()
    .catch((error: unknown) => {
      if (missing(error)) return { resource: undefined };
      throw error;
    });
  const engine = resource?.row?.value;
  if (engine !== undefined) {
    if (engine !== expected) {
      throw new Error(
        `Cosmos DB container ${container.id} holds storage engine "${String(engine)}"; this version writes "${expected}". Use the Hot Updater version that wrote it, or another container.`,
      );
    }
    return;
  }
  // Every partition, and items of any shape: anything but the settings
  // means another app's data.
  const { resources } = await container.items
    .query<string>(
      {
        query:
          "SELECT TOP 1 VALUE c.id FROM c WHERE NOT (c.partition = @partition AND c.pk = @settings)",
        parameters: [
          { name: "@partition", value: COSMOS_PARTITION },
          { name: "@settings", value: SETTINGS_TABLE.name },
        ],
      },
      { enableScanInQuery: true },
    )
    .fetchAll();
  if (resources.length > 0) {
    throw new Error(
      `Cosmos DB container ${container.id} holds items but no ${ENGINE_KEY} setting. Use an empty container.`,
    );
  }
};

/**
 * Creates the database and the container when they are missing, and writes
 * the schema settings of core and `plugins`, the plugins the server runs,
 * which the database checks before its first read. `hot-updater init` runs
 * it with the managed server's plugins.
 */
export const migrateCosmosDatabase = (
  config: CosmosDatabaseConfig,
  plugins: readonly PluginTables[] = [],
) => {
  const target = adapterOf(config);
  return assertMigratable(target, toolingTargetOf(plugins).settings[ENGINE_KEY])
    .then(() => migrateCoreSchema(target.adapter, "cosmosDatabase", plugins))
    .finally(() => target.client.dispose());
};

/**
 * Hot Updater's database in one Azure Cosmos DB for NoSQL container,
 * through the storage engine. Every item shares one logical partition, so a
 * write commits as one transactional batch; that partition holds at most
 * 20 GB.
 */
export const cosmosDatabase = (
  config: CosmosDatabaseConfig,
): EngineDatabase => {
  const { client, adapter } = adapterOf(config);
  return {
    ...createEngineDatabase({
      name: "cosmosDatabase",
      adapter,
      aggregateBatching: config.aggregateBatching ?? {},
    }),
    async dispose() {
      await adapter.dispose?.();
      client.dispose();
    },
  };
};
