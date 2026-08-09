import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  attachDatabasePluginAggregateMutations,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";

import { createDynamoDBAggregateMutations } from "./dynamodbDatabaseAggregate";
import { createDynamoDBCrud } from "./dynamodbDatabaseCrud";
import { createDynamoDBGetUpdateInfo } from "./dynamodbDatabaseUpdateInfo";

export const DYNAMODB_UPDATE_INDEX_NAME = "hot-updater-update-index";

export interface DynamoDBDatabaseConfig extends DynamoDBClientConfig {
  readonly tableName: string;
}

export const dynamodbDatabase = (config: DynamoDBDatabaseConfig) => {
  const { tableName, ...clientConfig } = config;
  const client = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const store = { client, tableName };
  const plugin = createDatabasePlugin({
    name: "dynamodbDatabase",
    plugin: () => ({
      ...createDynamoDBCrud(store),
      getUpdateInfo: createDynamoDBGetUpdateInfo(
        store,
        DYNAMODB_UPDATE_INDEX_NAME,
      ),
      onUnmount: async () => client.destroy(),
    }),
  });
  return attachDatabasePluginAggregateMutations(
    plugin,
    createDynamoDBAggregateMutations(store),
  );
};
