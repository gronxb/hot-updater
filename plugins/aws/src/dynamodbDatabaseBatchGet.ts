import {
  BatchGetCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";

import type { DynamoDBStore } from "./dynamodbDatabaseStore";

const DYNAMODB_BATCH_GET_ATTEMPTS = 5;
const DYNAMODB_BATCH_GET_BASE_DELAY_MS = 25;

export class DynamoDBBatchGetExhaustedError extends Error {
  readonly name = "DynamoDBBatchGetExhaustedError";

  constructor(readonly unprocessedKeyCount: number) {
    super(
      `DynamoDB did not process ${unprocessedKeyCount} batch-get keys after ${DYNAMODB_BATCH_GET_ATTEMPTS} attempts`,
    );
  }
}

const waitBeforeRetry = (attempt: number): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(resolve, DYNAMODB_BATCH_GET_BASE_DELAY_MS * 2 ** attempt),
  );

export const batchGetDynamoDBItems = async (
  store: DynamoDBStore,
  keys: readonly Record<string, NativeAttributeValue>[],
): Promise<Record<string, NativeAttributeValue>[]> => {
  const items: Record<string, NativeAttributeValue>[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    for (
      let attempt = 0;
      attempt < DYNAMODB_BATCH_GET_ATTEMPTS && pending.length > 0;
      attempt++
    ) {
      const { Responses, UnprocessedKeys } = await store.client.send(
        new BatchGetCommand({
          RequestItems: {
            [store.tableName]: { ConsistentRead: true, Keys: pending },
          },
        }),
      );
      items.push(...(Responses?.[store.tableName] ?? []));
      pending = UnprocessedKeys?.[store.tableName]?.Keys ?? [];
      if (pending.length > 0 && attempt + 1 < DYNAMODB_BATCH_GET_ATTEMPTS) {
        await waitBeforeRetry(attempt);
      }
    }
    if (pending.length > 0) {
      throw new DynamoDBBatchGetExhaustedError(pending.length);
    }
  }
  return items;
};
