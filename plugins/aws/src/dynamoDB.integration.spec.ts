import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHotUpdater } from "@hot-updater/server";
import { createKvAdapter, SETTINGS_TABLE } from "@hot-updater/server/database";
import {
  createDatabaseCoreApi,
  createDatabasePluginApis,
  HotUpdaterSchemaMigrationRequiredError,
} from "@hot-updater/server/db";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";
import {
  setupDatabaseAdapterConformanceSuite,
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dynamoDB, migrateDynamoDB } from "./dynamoDB";
import {
  type DynamoDBLocal,
  startDynamoDBLocal,
} from "./dynamoDB.integration-fixture";
import { createDynamoDBStore } from "./dynamoDBStore";

let local: DynamoDBLocal;
beforeAll(async () => {
  local = await startDynamoDBLocal();
}, 180_000);
afterAll(async () => {
  await local?.stop();
});

setupDatabaseAdapterConformanceSuite({
  name: "key-value (DynamoDB Local)",
  // 34 conformance inserts are 102 items, over DynamoDB's 100 per transaction.
  maxOps: 33,
  writers: 16,
  createAdapter: async ({ nativePageSize }) => {
    const tableName = local.tableName();
    const store = createDynamoDBStore({
      client: local.client,
      tableName,
      nativePageSize,
    });
    await store.migrations!.apply();
    return {
      adapter: createKvAdapter({ store }),
      cleanup: async () => {
        await local.dropTable(tableName);
      },
    };
  },
});

describe("dynamoDB", () => {
  const tableName = `hot-updater-plugin-${process.pid}`;
  const config = () => ({ ...local.config, tableName });

  /** Deletes every item but the schema settings, which the database checks first. */
  const clear = async () => {
    const documents = DynamoDBDocumentClient.from(local.client);
    for (let start: Record<string, unknown> | undefined; ; ) {
      const page = await documents.send(
        new ScanCommand({
          TableName: tableName,
          ProjectionExpression: "pk, sk",
          ExclusiveStartKey: start,
        }),
      );
      const keys = (page.Items ?? []).filter(
        ({ pk }) => pk !== SETTINGS_TABLE.name,
      );
      for (let at = 0; at < keys.length; at += 25) {
        await documents.send(
          new BatchWriteCommand({
            RequestItems: {
              [tableName]: keys
                .slice(at, at + 25)
                .map(({ pk, sk }) => ({ DeleteRequest: { Key: { pk, sk } } })),
            },
          }),
        );
      }
      start = page.LastEvaluatedKey;
      if (start === undefined) return;
    }
  };

  it("serves only after the migration writes the schema settings", async () => {
    const fenced = { ...local.config, tableName: local.tableName() };
    const database = dynamoDB(fenced);
    const core = createDatabaseCoreApi(database);
    // No table yet: the fence reads DynamoDB's missing table as a missing schema.
    await expect(core.listChannels()).rejects.toBeInstanceOf(
      HotUpdaterSchemaMigrationRequiredError,
    );
    await migrateDynamoDB(fenced);
    await migrateDynamoDB(fenced);
    await expect(core.listChannels()).resolves.toEqual([]);
    await database.dispose?.();
  });

  setupDatabaseTestSuite({
    name: "dynamoDB (DynamoDB Local)",
    createHttpClient: (options) =>
      startHttpTestServer(
        createHotUpdater({
          ...options,
          plugins: [insights()],
          clientAccess: "public",
        }).handlers,
      ),
    createInsightsModel: (database) =>
      createInsightsModel(
        createDatabasePluginApis(database, [insights()]).insights,
      ),
    createDatabase: () => dynamoDB(config()),
    migrate: async () => {
      await migrateDynamoDB(config());
    },
    reset: clear,
    dispose: async (database) => {
      await database.dispose?.();
    },
  });
});
