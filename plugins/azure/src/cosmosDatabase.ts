import { CosmosClient, type CosmosClientOptions } from "@azure/cosmos";
import type { EngineDatabase, Lazy } from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createKvAdapter,
  migrateCoreSchema,
  type PluginTables,
} from "@hot-updater/plugin-core";

import {
  AZURE_COSMOS_V1_CONTAINER,
  AZURE_COSMOS_V1_DATABASE,
} from "./azureInfrastructureNames";
import { createCosmosStore, currentCosmosEngine } from "./cosmosStore";

/**
 * The client's options: the account's `connectionString`, or its
 * `endpoint` with a `key` or Microsoft Entra `aadCredentials`. Reads must
 * be strongly consistent, so `consistencyLevel` takes only `"Strong"`.
 */
export type CosmosDatabaseConfig = Omit<
  CosmosClientOptions,
  "consistencyLevel" | "connectionString"
> & {
  /**
   * The account's connection string, or a function that returns it, such as
   * `secret("<name>")` in `hot-updater.config.ts`: called on the first
   * request, so a config loads without it. `endpoint` beside a function
   * names the account to `hot-updater doctor`.
   */
  readonly connectionString?: Lazy<string>;
  readonly consistencyLevel?: "Strong";
  /** The database the container lives in. @default "hot-updater" */
  readonly databaseId?: string;
  /** The one container the database keeps its items in. @default "hot_updater_v1" */
  readonly containerId?: string;
  /**
   * Cosmos DB bills each item a write touches, so Insights' aggregates are
   * batched: through log rows a compaction merges (the default). `false` commits
   * them with each event.
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
  // Point reads and the reads a write plans from must see every committed
  // write; a weaker level would let another instance read stale state.
  if (
    connection.consistencyLevel !== undefined &&
    connection.consistencyLevel !== "Strong"
  ) {
    throw new Error(
      `cosmosDatabase reads with strong consistency; consistencyLevel "${String(connection.consistencyLevel)}" is weaker.`,
    );
  }
  // Created on the first request, so a config loads without the connection.
  let client: CosmosClient | undefined;
  const { connectionString } = connection;
  const store = createCosmosStore({
    client: async () =>
      (client ??= new CosmosClient({
        ...connection,
        connectionString:
          typeof connectionString === "function"
            ? await connectionString()
            : connectionString,
      })),
    databaseId,
    containerId,
    // What every migration path checks a reused container against.
    engine: currentCosmosEngine(),
  });
  return {
    dispose: () => client?.dispose(),
    adapter: createKvAdapter({ store }),
  };
};

/**
 * Creates the database and the container when they are missing, refusing a
 * container of another storage layout or another app's items, and writes
 * the schema settings of core and `plugins`, the plugins the server runs,
 * which the database checks before its first read. `hot-updater init` runs
 * it with the managed server's plugins.
 */
export const migrateCosmosDatabase = (
  config: CosmosDatabaseConfig,
  plugins: readonly PluginTables[] = [],
) => {
  const { dispose, adapter } = adapterOf(config);
  return migrateCoreSchema(adapter, "cosmosDatabase", plugins).finally(dispose);
};

/**
 * The resource this database reaches, without credentials, under the key
 * `hot-updater doctor` reads to tell the database `hot-updater init` saved
 * from another (a convention CLAUDE.md documents).
 */
const DATABASE_TARGET = Symbol.for("@hot-updater/database-target");

/** The account host a client reaches: its endpoint, or the connection string's. */
const accountHostOf = ({
  endpoint,
  connectionString,
}: CosmosDatabaseConfig) => {
  const url =
    endpoint ??
    (typeof connectionString === "string"
      ? connectionString.match(/AccountEndpoint=([^;]+)/iu)?.[1]
      : undefined);
  try {
    return url === undefined ? undefined : new URL(url).hostname;
  } catch {
    return undefined;
  }
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
  const { dispose, adapter } = adapterOf(config);
  const host = accountHostOf(config);
  return {
    ...createEngineDatabase({
      name: "cosmosDatabase",
      adapter,
      aggregateBatching: config.aggregateBatching ?? {},
    }),
    ...(host === undefined ? {} : { [DATABASE_TARGET]: `cosmos/${host}` }),
    async dispose() {
      await adapter.dispose?.();
      dispose();
    },
  };
};
