import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DYNAMODB_INSIGHTS_ITEM_MAX_BYTES,
  DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES,
  DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION,
  DYNAMODB_INSIGHTS_V2_PREFIX,
  DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
  dynamoDBInsightsMarshalledItemBytes,
  dynamoDBInsightsTransactionRequestBytes,
  dynamoDBInsightsV2Namespace,
} from "./dynamoDBInsightsV2";
import { createDynamoDBInsightsModel } from "./dynamoDBInsightsV2Jobs";

const documentClient = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "us-east-1" }),
);
const tableName = "hot-updater-metadata";
const insightsDatabaseNamespace = "00000000-0000-4000-8000-000000000001";
const store = { client, tableName, insightsDatabaseNamespace };
const key = (value: Record<string, unknown>): string =>
  `${String(value.pk)}\n${String(value.sk)}`;
let items: Map<string, Record<string, unknown>>;

describe("DynamoDB Insights v2 durable jobs", () => {
  beforeEach(() => {
    documentClient.reset();
    items = new Map<string, Record<string, unknown>>();
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
      return { Item: items.get(key(input.Key!)) };
    });
    documentClient.on(BatchGetCommand).callsFake((input) => {
      const keys = input.RequestItems?.[tableName]?.Keys ?? [];
      const responses = keys.flatMap((item: Record<string, unknown>) => {
        if (
          item.pk === `${DYNAMODB_INSIGHTS_V2_PREFIX}#state` &&
          (item.sk === "source" ||
            item.sk === "projection#events" ||
            item.sk === "projection#installations")
        ) {
          return [
            {
              ...item,
              item_type: "insights-readiness",
              job_id:
                item.sk === "source"
                  ? "dynamodb-insights-v2-migration"
                  : "dynamodb-insights-v2-projection",
              storage_revision: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
              state: item.sk === "source" ? "ready" : "preparing",
            },
          ];
        }
        if (item.sk === "!clock") {
          return [
            {
              ...item,
              item_type: "source-clock",
              sequence:
                item.pk === `${DYNAMODB_INSIGHTS_V2_PREFIX}#source#00`
                  ? 50_001
                  : 0,
            },
          ];
        }
        if (String(item.sk).startsWith("projection#source#")) {
          return [
            {
              ...item,
              item_type: "insights-projection-checkpoint",
              job_id: "dynamodb-insights-v2-projection",
              sequence: 0,
            },
          ];
        }
        const stored = items.get(key(item));
        return stored === undefined ? [] : [stored];
      });
      return { Responses: { [tableName]: responses } };
    });
    documentClient.on(TransactWriteCommand).callsFake((input) => {
      for (const action of input.TransactItems ?? []) {
        if (action.Put?.Item !== undefined) {
          items.set(key(action.Put.Item), action.Put.Item);
        }
      }
      return {};
    });
  });

  it("freezes all 32 source clocks in the short reservation transaction", async () => {
    const model = createDynamoDBInsightsModel(store);
    const first = await model.getReport({
      query: { kind: "installationOverview" },
    });
    expect(first).toMatchObject({
      state: "preparing",
      versions: {
        sourceGeneration: expect.stringMatching(
          /^dynamodb-i2-v1:source:[0-9a-f]{64}$/,
        ),
      },
      job: { id: expect.any(String) },
    });
    if (first.state !== "preparing") throw new Error("expected reservation");

    const transaction =
      documentClient.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    expect(transaction.TransactItems).toHaveLength(34);
    expect(
      transaction.TransactItems?.filter(
        (action) => action.ConditionCheck !== undefined,
      ),
    ).toHaveLength(32);
    expect(transaction.TransactItems?.filter((action) => action.Put)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              item_type: "insights-job",
              source_vector: [50_001, ...Array.from({ length: 31 }, () => 0)],
              source_generation: first.versions.sourceGeneration,
            }),
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              item_type: "insights-job-head",
              active_job_id: first.job.id,
            }),
          }),
        }),
      ]),
    );
    expect(transaction.ClientRequestToken).toMatch(/^[0-9a-f]{36}$/);
    expect(transaction.ReturnConsumedCapacity).toBe("TOTAL");
    expect(
      dynamoDBInsightsTransactionRequestBytes(transaction.TransactItems!),
    ).toBeLessThan(DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES);
    for (const action of transaction.TransactItems!) {
      if (action.Put?.Item !== undefined) {
        expect(
          dynamoDBInsightsMarshalledItemBytes(action.Put.Item),
        ).toBeLessThan(DYNAMODB_INSIGHTS_ITEM_MAX_BYTES);
      }
    }
    expect(
      transaction.TransactItems?.find((action) =>
        action.ConditionCheck?.Key?.pk?.endsWith("#source#00"),
      )?.ConditionCheck,
    ).toMatchObject({
      ConditionExpression: "#type = :type AND #sequence = :sequence",
      ExpressionAttributeValues: {
        ":type": "source-clock",
        ":sequence": 50_001,
      },
    });

    const polled = await model.getReport({
      query: { kind: "installationOverview" },
      minAsOfMs: Date.now() + 60_000,
    });
    expect(polled).toMatchObject({
      state: "preparing",
      job: { id: first.job.id },
      versions: { sourceGeneration: first.versions.sourceGeneration },
    });
    expect(documentClient.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("keeps a 100-ID summary reservation below item and request limits", async () => {
    const model = createDynamoDBInsightsModel(store);
    const bundleIds = Array.from(
      { length: 100 },
      (_, index) => `${index.toString().padStart(3, "0")}-${"x".repeat(180)}`,
    );
    await expect(
      model.getReport({
        query: { kind: "bundleSummaries", bundleIds, window: "30d" },
      }),
    ).resolves.toMatchObject({ state: "preparing" });
    const transaction =
      documentClient.commandCalls(TransactWriteCommand)[0]!.args[0].input;
    const job = transaction.TransactItems?.find(
      (action) => action.Put?.Item?.item_type === "insights-job",
    )?.Put?.Item;
    expect(job).toBeDefined();
    expect(dynamoDBInsightsMarshalledItemBytes(job!)).toBeLessThan(
      DYNAMODB_INSIGHTS_ITEM_MAX_BYTES,
    );
    expect(
      dynamoDBInsightsTransactionRequestBytes(transaction.TransactItems!),
    ).toBeLessThan(DYNAMODB_INSIGHTS_TRANSACTION_MAX_BYTES);
  });

  it("rejects an exhausted durable head revision before another write", async () => {
    const model = createDynamoDBInsightsModel(store);
    await model.getReport({
      query: { kind: "installationOverview" },
    });
    const head = [...items.values()].find(
      (item) => item.item_type === "insights-job-head",
    )!;
    items.set(key(head), {
      ...head,
      revision: Number.MAX_SAFE_INTEGER,
      active_job_id: null,
      publication_id: null,
    });
    const writesBefore =
      documentClient.commandCalls(TransactWriteCommand).length;

    await expect(
      model.getReport({ query: { kind: "installationOverview" } }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    expect(documentClient.commandCalls(TransactWriteCommand)).toHaveLength(
      writesBefore,
    );
  });
});
