import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { attachAnalyticsProviderCapability } from "@hot-updater/analytics/internal/provider-capability";
import { createBoundedAnalyticsProvider } from "@hot-updater/analytics/provider";
import {
  attachDatabasePluginAggregateMutations,
  attachDatabasePluginPatchHydration,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";

import { invalidateCloudFront } from "./cloudFrontInvalidation";
import { createDynamoDBAnalyticsPersistence } from "./dynamodbAnalyticsPersistence";
import { createDynamoDBAggregateMutations } from "./dynamodbDatabaseAggregate";
import { createDynamoDBCrud } from "./dynamodbDatabaseCrud";
import {
  queryCompleteOwnerPatches,
  queryCompleteOwnersPatches,
} from "./dynamodbDatabaseOwnerReads";
import { createDynamoDBGetUpdateInfo } from "./dynamodbDatabaseUpdateInfo";

export const DYNAMODB_UPDATE_INDEX_NAME = "hot-updater-update-index";

export interface DynamoDBDatabaseConfig extends DynamoDBClientConfig {
  readonly apiBasePath?: string;
  readonly cloudfrontDistributionId?: string;
  readonly shouldWaitForInvalidation?: boolean;
  readonly tableName: string;
}

export const dynamodbDatabase = (config: DynamoDBDatabaseConfig) => {
  const {
    apiBasePath = "/api/check-update",
    cloudfrontDistributionId,
    shouldWaitForInvalidation = false,
    tableName,
    ...clientConfig
  } = config;
  const client = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const cloudFront = cloudfrontDistributionId
    ? new CloudFrontClient({
        credentials: clientConfig.credentials,
        region: clientConfig.region,
      })
    : null;
  const store = { client, tableName };
  const plugin = createDatabasePlugin({
    name: "dynamodbDatabase",
    plugin: () => ({
      ...createDynamoDBCrud(store, DYNAMODB_UPDATE_INDEX_NAME),
      getUpdateInfo: createDynamoDBGetUpdateInfo(
        store,
        DYNAMODB_UPDATE_INDEX_NAME,
      ),
      onUnmount: async () => {
        client.destroy();
        cloudFront?.destroy();
      },
    }),
  });
  const pluginWithInvalidation =
    cloudFront && cloudfrontDistributionId
      ? {
          ...plugin,
          onDatabaseUpdated: async () => {
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
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                },
              );
            }
          },
        }
      : plugin;
  const pluginWithPatchHydration = attachDatabasePluginPatchHydration(
    pluginWithInvalidation,
    {
      loadPatches: (ownerIds) => {
        const ownerId = ownerIds.length === 1 ? ownerIds[0] : undefined;
        return ownerId !== undefined
          ? queryCompleteOwnerPatches(
              store,
              DYNAMODB_UPDATE_INDEX_NAME,
              ownerId,
            )
          : queryCompleteOwnersPatches(
              store,
              DYNAMODB_UPDATE_INDEX_NAME,
              ownerIds,
            );
      },
    },
  );
  const pluginWithAggregateMutations = attachDatabasePluginAggregateMutations(
    pluginWithPatchHydration,
    createDynamoDBAggregateMutations(store),
  );
  return attachAnalyticsProviderCapability(pluginWithAggregateMutations, () =>
    createBoundedAnalyticsProvider(createDynamoDBAnalyticsPersistence(store)),
  );
};
