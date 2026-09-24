import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createKvAdapter,
  migrateBuiltInSchema,
} from "@hot-updater/server/database";

import { createUpdateRouteInvalidation } from "./cloudFrontInvalidation";
import { createDynamoDBStore } from "./dynamoDBStore";

export interface DynamoDBConfig extends DynamoDBClientConfig {
  readonly apiBasePath?: string;
  readonly cloudfrontDistributionId?: string;
  readonly shouldWaitForInvalidation?: boolean;
  readonly tableName: string;
}

/** The DynamoDB client ignores the CloudFront settings in its config. */
const adapterOf = ({ tableName, ...clientConfig }: DynamoDBConfig) => {
  const client = new DynamoDBClient(clientConfig);
  return {
    client,
    adapter: createKvAdapter({
      store: createDynamoDBStore({ client, tableName }),
    }),
  };
};

/**
 * Creates the table when it is missing and writes the schema settings the
 * database checks before its first read. `hot-updater init` runs it in AWS.
 */
export const migrateDynamoDB = async (config: DynamoDBConfig) => {
  const { client, adapter } = adapterOf(config);
  try {
    await migrateBuiltInSchema(adapter, "dynamoDB");
  } finally {
    client.destroy();
  }
};

/**
 * Hot Updater's database on one DynamoDB table, through the storage engine.
 * A write that changes what the update-check routes answer invalidates their
 * CloudFront copies.
 */
export const dynamoDB = (config: DynamoDBConfig): EngineDatabase => {
  const { client, adapter } = adapterOf(config);
  const cloudFront = createUpdateRouteInvalidation(config);
  return {
    ...createEngineDatabase({
      name: "dynamoDB",
      adapter,
      onCachedRoutesChange: cloudFront?.invalidate,
    }),
    async dispose() {
      await adapter.dispose?.();
      client.destroy();
      cloudFront?.destroy();
    },
  };
};
