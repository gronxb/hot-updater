import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BundleEventRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import {
  appendDynamoDBInsightsV2,
  assertDynamoDBInsightsTransactionBudget,
  DYNAMODB_INSIGHTS_ITEM_MAX_BYTES,
  DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES,
  DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION,
  DYNAMODB_INSIGHTS_V2_PREFIX,
  DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
  DynamoDBInsightsV2BudgetError,
  DynamoDBInsightsV2StorageCorruptionError,
  dynamoDBInsightsMarshalledItemBytes,
  dynamoDBInsightsTransactionRequestBytes,
  dynamoDBInsightsV2Namespace,
  isRetryableDynamoDBInsightsError,
  initializeDynamoDBInsightsV2,
} from "./dynamoDBInsightsV2";

const documentClient = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "us-east-1" }),
);
const store = {
  client,
  tableName: "hot-updater-metadata",
  insightsDatabaseNamespace: "00000000-0000-4000-8000-000000000001",
};

const initializedItem = (
  key: Record<string, unknown>,
  sequence = 0,
  readiness: "ready" | "preparing" = "preparing",
): Record<string, unknown> | undefined => {
  if (
    key.sk === "source" ||
    key.sk === "projection#events" ||
    key.sk === "projection#installations"
  ) {
    return {
      ...key,
      item_type: "insights-readiness",
      job_id:
        key.sk === "source"
          ? "dynamodb-insights-v2-migration"
          : "dynamodb-insights-v2-projection",
      state: readiness,
      storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
    };
  }
  if (key.sk === "!clock") {
    return { ...key, item_type: "source-clock", sequence };
  }
  if (String(key.sk).startsWith("projection#source#")) {
    return {
      ...key,
      item_type: "insights-projection-checkpoint",
      job_id: "dynamodb-insights-v2-projection",
      sequence,
    };
  }
  return undefined;
};

const event = (
  index = 1,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: `018f0000-0000-7000-8000-${index.toString().padStart(12, "0")}`,
    type: "UPDATE_APPLIED",
    install_id: `installation-${index}`,
    user_id: `user-${index}`,
    username: `legacy-${index}`,
    from_release_id: null,
    from_bundle_id: "00000000-0000-0000-0000-000000000001",
    to_release_id: null,
    to_bundle_id: "00000000-0000-0000-0000-000000000002",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "0",
    update_strategy: "appVersion",
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: index,
    ...overrides,
  }) as BundleEventRow;

const transactionCancelled = () => {
  const error = new Error("clock changed");
  error.name = "TransactionCanceledException";
  Object.assign(error, {
    CancellationReasons: [
      { Code: "None" },
      { Code: "None" },
      { Code: "ConditionalCheckFailed" },
    ],
  });
  return error;
};

describe("DynamoDB Insights v2 contract", () => {
  beforeEach(() => {
    documentClient.reset();
    documentClient.on(BatchGetCommand).callsFake((input) => {
      const keys = input.RequestItems?.[store.tableName]?.Keys ?? [];
      return {
        Responses: {
          [store.tableName]: keys.flatMap((key: Record<string, unknown>) => {
            const item = initializedItem(key);
            return item === undefined ? [] : [item];
          }),
        },
      };
    });
    documentClient.on(PutCommand).resolves({});
    documentClient.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "layout") {
        return {
          Item: {
            pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#state`,
            sk: "layout",
            item_type: "insights-layout",
            layout_version: DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION,
            storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
            database_namespace: dynamoDBInsightsV2Namespace(store),
            source_shards: 32,
            global_shards: 16,
            installation_shards: 8,
            bundle_shards: 16,
            latest_shards: 16,
          },
        };
      }
      return { Item: initializedItem(input.Key!) };
    });
  });

  it("atomically appends source and caught-up live projections", async () => {
    documentClient.on(TransactWriteCommand).resolves({});

    await appendDynamoDBInsightsV2(store, event());

    const transaction =
      documentClient.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(transaction?.TransactItems).toHaveLength(13);
    expect(transaction?.ClientRequestToken).toMatch(/^[0-9a-f]{36}$/);
    expect(transaction?.ReturnConsumedCapacity).toBe("TOTAL");
    const items = transaction?.TransactItems?.map(
      (action) => action.Put?.Item ?? action.Update?.Key,
    );
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item_type: "event-id-guard" }),
        expect.objectContaining({ item_type: "source-event" }),
        expect.objectContaining({ item_type: "event-directory" }),
        expect.objectContaining({ item_type: "event-pointer" }),
        expect.objectContaining({ item_type: "installation-candidate" }),
        expect.objectContaining({
          item_type: "installation-current-candidate",
        }),
      ]),
    );
    expect(transaction?.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            ExpressionAttributeValues: expect.objectContaining({
              ":type": "installation-identity",
            }),
          }),
        }),
      ]),
    );
    const source = items?.find((item) => item?.item_type === "source-event");
    expect(source?.pk).toMatch(
      /^_hot-updater#insights-v2#source#(?:0[0-9]|[12][0-9]|3[01])$/,
    );
    expect(
      dynamoDBInsightsTransactionRequestBytes(transaction!.TransactItems!),
    ).toBeLessThan(DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES);
    for (const action of transaction!.TransactItems!) {
      if (action.Put?.Item !== undefined) {
        expect(
          dynamoDBInsightsMarshalledItemBytes(action.Put.Item),
        ).toBeLessThan(DYNAMODB_INSIGHTS_ITEM_MAX_BYTES);
      }
    }
  });

  it("atomically initializes all clocks and rejects a deleted nonzero clock", async () => {
    documentClient.reset();
    const items = new Map<string, Record<string, unknown>>();
    const key = (value: Record<string, unknown>) =>
      `${String(value.pk)}\n${String(value.sk)}`;
    documentClient.on(GetCommand).callsFake((input) => ({
      Item: items.get(key(input.Key!)),
    }));
    documentClient.on(BatchGetCommand).callsFake((input) => ({
      Responses: {
        [store.tableName]: (
          input.RequestItems?.[store.tableName]?.Keys ?? []
        ).flatMap((value: Record<string, unknown>) => {
          const item = items.get(key(value));
          return item === undefined ? [] : [item];
        }),
      },
    }));
    documentClient.on(TransactWriteCommand).callsFake((input) => {
      for (const action of input.TransactItems ?? []) {
        if (action.Put?.Item !== undefined) {
          items.set(key(action.Put.Item), action.Put.Item);
        }
      }
      return {};
    });

    await initializeDynamoDBInsightsV2(store);
    const initialization =
      documentClient.commandCalls(TransactWriteCommand)[0]!.args[0].input
        .TransactItems!;
    expect(initialization).toHaveLength(68);
    expect(
      initialization.filter(
        (action) => action.Put?.Item?.item_type === "source-clock",
      ),
    ).toHaveLength(32);
    expect(
      initialization.filter(
        (action) =>
          action.Put?.Item?.item_type === "insights-projection-checkpoint",
      ),
    ).toHaveLength(32);

    const clockKey = `${DYNAMODB_INSIGHTS_V2_PREFIX}#source#00\n!clock`;
    items.set(clockKey, { ...items.get(clockKey)!, sequence: 7 });
    items.delete(clockKey);
    await expect(initializeDynamoDBInsightsV2(store)).rejects.toBeInstanceOf(
      DynamoDBInsightsV2StorageCorruptionError,
    );
  });

  it("types a partial pre-layout initialization collision as corruption", async () => {
    documentClient.on(GetCommand).resolves({});
    documentClient.on(TransactWriteCommand).rejects(transactionCancelled());

    await expect(initializeDynamoDBInsightsV2(store)).rejects.toBeInstanceOf(
      DynamoDBInsightsV2StorageCorruptionError,
    );
  });

  it("rejects a layout bound to another database namespace", async () => {
    documentClient.on(GetCommand).callsFake((input) => ({
      Item:
        input.Key?.sk === "layout"
          ? {
              ...input.Key,
              item_type: "insights-layout",
              layout_version: DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION,
              storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
              database_namespace: "00000000-0000-4000-8000-000000000002",
              source_shards: 32,
              global_shards: 16,
              installation_shards: 8,
              bundle_shards: 16,
              latest_shards: 16,
            }
          : undefined,
    }));

    await expect(initializeDynamoDBInsightsV2(store)).rejects.toBeInstanceOf(
      DynamoDBInsightsV2StorageCorruptionError,
    );
    expect(documentClient.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it("rejects safe-integer source clock exhaustion before writing", async () => {
    documentClient.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "layout") {
        return {
          Item: {
            pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#state`,
            sk: "layout",
            item_type: "insights-layout",
            layout_version: DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION,
            storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
            database_namespace: dynamoDBInsightsV2Namespace(store),
            source_shards: 32,
            global_shards: 16,
            installation_shards: 8,
            bundle_shards: 16,
            latest_shards: 16,
          },
        };
      }
      const item = initializedItem(input.Key!);
      return {
        Item:
          input.Key?.sk === "!clock"
            ? { ...item, sequence: Number.MAX_SAFE_INTEGER }
            : item,
      };
    });

    await expect(appendDynamoDBInsightsV2(store, event())).rejects.toThrow(
      "sequence is exhausted",
    );
    expect(documentClient.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each(["wrong", "duplicate"] as const)(
    "rejects a %s persisted clock set",
    async (mode) => {
      documentClient.on(BatchGetCommand).callsFake((input) => {
        const keys = input.RequestItems?.[store.tableName]?.Keys ?? [];
        const items = keys.flatMap((value: Record<string, unknown>) => {
          const item = initializedItem(value);
          if (item === undefined) return [];
          if (
            value.pk === `${DYNAMODB_INSIGHTS_V2_PREFIX}#source#00` &&
            value.sk === "!clock"
          ) {
            return mode === "duplicate"
              ? [item, { ...item }]
              : [{ ...item, item_type: "source-event" }];
          }
          return [item];
        });
        return { Responses: { [store.tableName]: items } };
      });

      await expect(initializeDynamoDBInsightsV2(store)).rejects.toBeInstanceOf(
        DynamoDBInsightsV2StorageCorruptionError,
      );
    },
  );

  it("retries a transaction conflict with the same deterministic request token", async () => {
    const conflict = new Error("transaction conflict");
    conflict.name = "TransactionConflictException";
    documentClient.on(TransactWriteCommand).rejectsOnce(conflict).resolves({});

    await appendDynamoDBInsightsV2(store, event());

    const transactions = documentClient.commandCalls(TransactWriteCommand);
    expect(transactions).toHaveLength(2);
    expect(transactions[0]?.args[0].input.ClientRequestToken).toBe(
      transactions[1]?.args[0].input.ClientRequestToken,
    );
  });

  it("fails readiness when a derived directory collides during a clock race", async () => {
    let clockAdvanced = false;
    documentClient.on(GetCommand).callsFake((input) => {
      if (input.Key?.sk === "layout") {
        return {
          Item: {
            pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#state`,
            sk: "layout",
            item_type: "insights-layout",
            layout_version: DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION,
            storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
            database_namespace: dynamoDBInsightsV2Namespace(store),
            source_shards: 32,
            global_shards: 16,
            installation_shards: 8,
            bundle_shards: 16,
            latest_shards: 16,
          },
        };
      }
      const item = initializedItem(input.Key!);
      if (clockAdvanced && String(input.Key?.pk).includes("#dir#")) {
        return {
          Item: {
            ...input.Key,
            item_type: "event-directory",
            record_digest: "corrupt",
          },
        };
      }
      return {
        Item:
          input.Key?.sk === "!clock" && clockAdvanced
            ? { ...item, sequence: 1 }
            : item,
      };
    });
    documentClient.on(TransactWriteCommand).callsFake(() => {
      if (!clockAdvanced) {
        clockAdvanced = true;
        const error = new Error("directory changed");
        error.name = "TransactionCanceledException";
        Object.assign(error, {
          CancellationReasons: [
            { Code: "None" },
            { Code: "None" },
            { Code: "ConditionalCheckFailed" },
            { Code: "ConditionalCheckFailed" },
          ],
        });
        throw error;
      }
      return {};
    });

    await expect(
      appendDynamoDBInsightsV2(store, event()),
    ).rejects.toBeInstanceOf(DynamoDBInsightsV2StorageCorruptionError);

    const transactions = documentClient.commandCalls(TransactWriteCommand);
    expect(transactions).toHaveLength(2);
    expect(
      transactions[1]?.args[0].input.TransactItems?.map(
        (action) => action.Put?.Item?.sk,
      ),
    ).toEqual(["projection#events", "projection#installations"]);
  });

  it("classifies only conflicts and capacity failures as retryable", () => {
    expect(isRetryableDynamoDBInsightsError(transactionCancelled())).toBe(
      false,
    );
    expect(
      isRetryableDynamoDBInsightsError({
        name: "ProvisionedThroughputExceededException",
      }),
    ).toBe(true);
    expect(
      isRetryableDynamoDBInsightsError({
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ValidationError" }],
      }),
    ).toBe(false);
    expect(
      isRetryableDynamoDBInsightsError({ name: "ValidationException" }),
    ).toBe(false);
  });

  it("enforces the 100-action and strict-under-4-MiB request budgets", () => {
    expect(() =>
      assertDynamoDBInsightsTransactionBudget(
        Array.from({ length: 101 }, (_, index) => ({
          Put: {
            TableName: "table",
            Item: { pk: `pk-${index}`, sk: "sk" },
          },
        })),
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "DynamoDBInsightsV2BudgetError",
        kind: "actions",
        actual: 101,
      }),
    );

    expect(() =>
      assertDynamoDBInsightsTransactionBudget([
        {
          Put: {
            TableName: "table",
            Item: {
              pk: "pk",
              sk: "sk",
              padding: "x".repeat(DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES),
            },
          },
        },
      ]),
    ).toThrow(DynamoDBInsightsV2BudgetError);
  });
});
