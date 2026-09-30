import * as engine from "@hot-updater/server/database";
import { setupAggregateBatchingTestSuite } from "@hot-updater/test-utils";
import { afterAll, beforeAll } from "vitest";

import {
  type DynamoDBLocal,
  startDynamoDBLocal,
} from "./dynamoDB.integration-fixture";
import { DYNAMODB_LIMITS, createDynamoDBStore } from "./dynamoDBStore";

let local: DynamoDBLocal;
beforeAll(async () => {
  local = await startDynamoDBLocal();
}, 180_000);
afterAll(async () => {
  await local?.stop();
});

/** `dynamoDB()`'s batching on DynamoDB Local, a table per case. */
setupAggregateBatchingTestSuite({
  name: "key-value (DynamoDB Local)",
  engine,
  createAdapter: async () => {
    const tableName = local.tableName();
    const store = createDynamoDBStore({ client: local.client, tableName });
    await store.migrations!.apply();
    return {
      adapter: engine.createKvAdapter({ store }),
      cleanup: async () => {
        await local.dropTable(tableName);
      },
    };
  },
  // One more half a transaction's 100 items: the compaction splits it.
  oversizedRows: DYNAMODB_LIMITS.items + 50,
});
