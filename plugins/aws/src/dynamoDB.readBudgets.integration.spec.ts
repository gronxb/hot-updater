import { builtInSchema, createKvAdapter } from "@hot-updater/server/database";
import {
  createMeasuredDatabase,
  targetBaseCandidateKey,
} from "@hot-updater/server/db";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { setupReadBudgetTestSuite } from "@hot-updater/test-utils";
import { afterAll, beforeAll } from "vitest";

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

/**
 * `dynamoDB()`'s storage without its schema fence or CloudFront: the
 * key-value helper over the DynamoDB store, its pages as small as the suite's.
 */
setupReadBudgetTestSuite({
  name: "key-value (DynamoDB Local)",
  server: {
    createMeasuredDatabase,
    builtInSchema,
    plugins: [insights(), apiKeys()],
    targetBaseCandidateKey,
  },
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
      indexCopies: true,
      cleanup: async () => {
        await local.dropTable(tableName);
      },
    };
  },
});
