import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
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

import { invalidateCloudFront } from "./cloudFrontInvalidation";
import { createDynamoDBStore } from "./dynamoDBStore";

export interface DynamoDBConfig extends DynamoDBClientConfig {
  readonly apiBasePath?: string;
  readonly cloudfrontDistributionId?: string;
  readonly shouldWaitForInvalidation?: boolean;
  readonly tableName: string;
}

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
  const {
    apiBasePath = "/release-catalogs",
    cloudfrontDistributionId,
    shouldWaitForInvalidation = false,
    ...rest
  } = config;
  const { client, adapter } = adapterOf(rest);
  const cloudFront = cloudfrontDistributionId
    ? new CloudFrontClient({
        credentials: rest.credentials,
        region: rest.region,
      })
    : null;
  const invalidateUpdateRoutes = async () => {
    if (!cloudFront || !cloudfrontDistributionId) return;
    try {
      await invalidateCloudFront(
        cloudFront,
        cloudfrontDistributionId,
        [`${apiBasePath.replace(/\/+$/, "")}/*`],
        { shouldWait: shouldWaitForInvalidation },
      );
    } catch (error) {
      console.warn(
        "[hot-updater/aws] CloudFront invalidation failed; continuing without cache invalidation.",
        {
          distributionId: cloudfrontDistributionId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  };
  return {
    ...createEngineDatabase({
      name: "dynamoDB",
      adapter,
      onCachedRoutesChange: invalidateUpdateRoutes,
    }),
    async dispose() {
      await adapter.dispose?.();
      client.destroy();
      cloudFront?.destroy();
    },
  };
};
