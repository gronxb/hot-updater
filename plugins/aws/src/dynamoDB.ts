import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createKvAdapter,
  migrateCoreSchema,
  type PluginTables,
} from "@hot-updater/plugin-core";
import { withAdapterResource } from "@hot-updater/plugin-core/internal";

import { createUpdateRouteInvalidation } from "./cloudFrontInvalidation";
import { createDynamoDBStore } from "./dynamoDBStore";

export interface DynamoDBConfig extends DynamoDBClientConfig {
  readonly apiBasePath?: string;
  readonly cloudfrontDistributionId?: string;
  readonly shouldWaitForInvalidation?: boolean;
  readonly tableName: string;
  /**
   * DynamoDB bills each item a write touches, so Insights' aggregates are
   * batched: through log rows a compaction merges (the default), or
   * `{ mode: "memory" }` on a long-lived server. `false` commits them with
   * each event.
   */
  readonly aggregateBatching?: EngineDatabase["aggregateBatching"] | false;
}

/** The DynamoDB client ignores the CloudFront and batching settings. */
const adapterOf = ({ tableName, ...clientConfig }: DynamoDBConfig) => {
  const client = new DynamoDBClient(clientConfig);
  const store = createDynamoDBStore({ client, tableName });
  return { client, adapter: createKvAdapter({ store }) };
};

/**
 * Creates the table when it is missing and writes the schema settings of
 * core and `plugins`, the plugins the server runs, which the database checks
 * before its first read. `hot-updater init` runs it in AWS with the managed
 * server's plugins.
 */
export const migrateDynamoDB = (
  config: DynamoDBConfig,
  plugins: readonly PluginTables[] = [],
) => {
  const { client, adapter } = adapterOf(config);
  return migrateCoreSchema(adapter, "dynamoDB", plugins).finally(() =>
    client.destroy(),
  );
};

/**
 * Hot Updater's database on one DynamoDB table, through the storage engine.
 * With a distribution, it gives core the CloudFront invalidation core runs
 * after a write that changes what the update-check routes answer.
 */
export const dynamoDB = (config: DynamoDBConfig): EngineDatabase => {
  const { client, adapter } = adapterOf(config);
  const cloudFront = createUpdateRouteInvalidation(config);
  const database: EngineDatabase = {
    ...createEngineDatabase({
      name: "dynamoDB",
      adapter,
      onCachedRoutesChange: cloudFront?.invalidate,
      aggregateBatching: config.aggregateBatching ?? {},
    }),
    async dispose() {
      await adapter.dispose?.();
      client.destroy();
      cloudFront?.destroy();
    },
  };
  return withAdapterResource(database, {
    region: typeof config.region === "string" ? config.region : undefined,
    tableName: config.tableName,
  });
};
