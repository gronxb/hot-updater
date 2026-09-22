import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { bundleToRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createDynamoDBReads,
  dynamoDB,
  parseDynamoDBItem,
  toDynamoDBBundleItem,
  toDynamoDBPatchItem,
} from "./dynamoDB";

const dynamodb = mockClient(DynamoDBDocumentClient);
const bundleId = "00000000-0000-0000-0000-000000000001";
const baseBundleId = "00000000-0000-0000-0000-000000000002";
const bundleRow = bundleToRow({
  id: bundleId,
  platform: "ios",
  gitCommitHash: null,
  metadata: {},
  manifestStorageUri: "storage://bundle/manifest.json",
  manifestFileHash: "manifest-hash",
  assetBaseStorageUri: "storage://assets",
});
const patchRow = {
  id: `${bundleId}:${baseBundleId}`,
  bundle_id: bundleId,
  base_bundle_id: baseBundleId,
  base_file_hash: "base-hash",
  patch_file_hash: "patch-hash",
  patch_storage_uri: "storage://patch.patch",
  byte_size: 3_000_000_002,
  order_index: 0,
} as const;

const createCrud = () => {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      },
      region: "us-east-1",
    }),
  );
  return createDynamoDBReads(
    { client, tableName: "hot-updater-metadata" },
    "hot-updater-update-index",
  );
};

const createPlugin = () =>
  dynamoDB({
    tableName: "hot-updater-metadata",
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

describe("DynamoDB native access patterns", () => {
  beforeEach(() => {
    dynamodb.reset();
    dynamodb
      .on(GetCommand)
      .callsFake((input) =>
        input.Key.sk === "metadata-indexes" ? { Item: { version: 1 } } : {},
      );
  });

  it("rejects invalid manifest rows and patch byte sizes", () => {
    expect(() =>
      parseDynamoDBItem(
        toDynamoDBBundleItem({ ...bundleRow, manifest_file_hash: "" }),
      ),
    ).not.toThrow();
    const invalid = toDynamoDBBundleItem(structuredClone(bundleRow));
    Reflect.deleteProperty(invalid.row, "manifest_file_hash");
    expect(() => parseDynamoDBItem(invalid)).toThrow(
      "DynamoDB contains an invalid Hot Updater row",
    );
    expect(() =>
      parseDynamoDBItem(toDynamoDBPatchItem({ ...patchRow, byte_size: -1 })),
    ).toThrow("DynamoDB contains an invalid Hot Updater row");
  });

  it("ignores obsolete secondary-index fields on stored bundles", () => {
    const currentItem = toDynamoDBBundleItem(bundleRow);
    expect(currentItem).not.toHaveProperty("gsi1pk");
    expect(currentItem).not.toHaveProperty("gsi1sk");
    const legacyItem = structuredClone({
      ...currentItem,
      gsi1pk: "bundle#ios",
      gsi1sk: bundleRow.id,
    });
    expect(parseDynamoDBItem(legacyItem)).toMatchObject({ row: bundleRow });
  });

  it("uses a strongly consistent key read for an exact bundle id", async () => {
    // Given
    dynamodb.on(GetCommand).resolves({ Item: toDynamoDBBundleItem(bundleRow) });
    const crud = createCrud();

    // When
    const result = await crud.findOne({
      model: "bundles",
      where: [{ field: "id", operator: "eq", value: bundleId }],
    });

    // Then
    expect(result).toEqual(bundleRow);
    expect(dynamodb.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      ConsistentRead: true,
      Key: { pk: "bundles", sk: bundleId },
    });
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("rejects case-insensitive key lookup instead of scanning metadata", async () => {
    await expect(
      createCrud().findOne({
        model: "bundles",
        where: [
          {
            field: "id",
            mode: "insensitive",
            operator: "eq",
            value: "bundle-id",
          },
        ],
      }),
    ).rejects.toThrow("unsupported");
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("returns no rows and performs no read when the limit is zero", async () => {
    const result = await createCrud().findMany({
      model: "bundles",
      limit: 0,
      offset: 0,
      orderBy: [{ field: "id", direction: "asc" }],
    });

    expect(result).toEqual([]);
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("batch-gets a finite bundle id set with additional cursor filters", async () => {
    dynamodb.on(BatchGetCommand).resolves({
      Responses: {
        "hot-updater-metadata": [toDynamoDBBundleItem(bundleRow)],
      },
    });

    const result = await createCrud().findMany({
      model: "bundles",
      where: [
        { field: "id", operator: "in", value: [bundleId, baseBundleId] },
        { field: "id", operator: "lte", value: bundleId },
      ],
      limit: 100,
      offset: 0,
      orderBy: [{ field: "id", direction: "asc" }],
    });

    expect(result).toEqual([bundleRow]);
    expect(dynamodb.commandCalls(BatchGetCommand)).toHaveLength(1);
    expect(
      dynamodb.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[
        "hot-updater-metadata"
      ]?.Keys,
    ).toEqual([{ pk: "bundles", sk: bundleId }]);
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it.each(["asc", "desc"] as const)(
    "hydrates only the finite-id cursor page in %s order",
    async (direction) => {
      const rows = Array.from({ length: 1_001 }, (_, index) => ({
        ...bundleRow,
        id: `bundle-${index.toString().padStart(4, "0")}`,
      }));
      dynamodb.on(BatchGetCommand).callsFake((input) => ({
        Responses: {
          "hot-updater-metadata": rows
            .filter((row) =>
              input.RequestItems["hot-updater-metadata"].Keys.some(
                (key: { sk: string }) => key.sk === row.id,
              ),
            )
            .reverse()
            .map((row) => toDynamoDBBundleItem(row)),
        },
      }));
      const result = await createCrud().findMany({
        model: "bundles",
        where: [
          {
            field: "id",
            operator: "in",
            value: [...rows.map(({ id }) => id), rows[501].id],
          },
          { field: "id", operator: "gt", value: rows[500].id },
          { field: "id", operator: "lt", value: rows[510].id },
        ],
        limit: 3,
        offset: 0,
        orderBy: [{ field: "id", direction }],
      });
      const expected =
        direction === "asc"
          ? rows.slice(501, 504)
          : rows.slice(507, 510).reverse();
      expect(result).toEqual(expected);
      expect(dynamodb.commandCalls(BatchGetCommand)).toHaveLength(1);
      expect(
        dynamodb.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[
          "hot-updater-metadata"
        ]?.Keys,
      ).toEqual(expected.map(({ id }) => ({ pk: "bundles", sk: id })));
      expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
    },
  );

  it("refills a finite-id page across absent and filtered rows before applying the offset", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      ...bundleRow,
      id: `bundle-${index}`,
      platform: index === 0 ? ("android" as const) : ("ios" as const),
    }));
    dynamodb.on(BatchGetCommand).callsFake((input) => ({
      Responses: {
        "hot-updater-metadata": rows
          .filter(
            (row, index) =>
              index !== 1 &&
              input.RequestItems["hot-updater-metadata"].Keys.some(
                (key: { sk: string }) => key.sk === row.id,
              ),
          )
          .reverse()
          .map((row) => toDynamoDBBundleItem(row)),
      },
    }));
    const result = await createCrud().findMany({
      model: "bundles",
      where: [
        { field: "id", operator: "in", value: rows.map(({ id }) => id) },
        { field: "platform", value: "ios" },
      ],
      limit: 2,
      offset: 1,
      orderBy: [{ field: "id", direction: "asc" }],
    });
    expect(result).toEqual(rows.slice(3, 5));
    expect(
      dynamodb
        .commandCalls(BatchGetCommand)
        .flatMap(
          ({ args }) =>
            args[0].input.RequestItems!["hot-updater-metadata"]!.Keys!,
        ),
    ).toEqual(rows.slice(0, 5).map(({ id }) => ({ pk: "bundles", sk: id })));
  });

  it("rejects an unindexed OR query instead of paging through all metadata", async () => {
    await expect(
      createCrud().findMany({
        model: "bundles",
        where: [
          { field: "id", operator: "gt", value: "bundle-z" },
          { connector: "OR", field: "platform", value: "ios" },
        ],
        limit: 100,
        offset: 0,
        orderBy: [{ field: "id", direction: "asc" }],
      }),
    ).rejects.toThrow("unsupported");
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("preserves all five public release equalities and the cursor in the native query", async () => {
    const queryBundleId = "00000000-0000-7000-8000-000000000001";
    const queryChannelId = "00000000-0000-7000-8000-000000000002";
    dynamodb.on(QueryCommand).resolves({ Items: [] });
    await dynamoDB({
      tableName: "hot-updater-metadata",
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    }).models.releases.findMany({
      bundleId: queryBundleId,
      channelId: queryChannelId,
      enabled: false,
      platform: "ios",
      targetAppVersion: "1.0.0",
      beforeReleaseId: queryChannelId,
      limit: 2,
    });
    const queries = dynamodb.commandCalls(QueryCommand);
    expect(queries).toHaveLength(1);
    const query = queries[0]?.args[0].input;
    expect(query).toMatchObject({
      ConsistentRead: true,
      Limit: 2,
      ScanIndexForward: false,
      KeyConditionExpression: "#pk = :pk AND #sk < :upper",
      ExpressionAttributeValues: {
        ":pk": `_hot-updater#index#releases#bundle_id#${JSON.stringify(queryBundleId)}`,
      },
    });
    for (const [field, value] of Object.entries({
      id: queryChannelId,
      bundle_id: queryBundleId,
      channel_id: queryChannelId,
      enabled: false,
      platform: "ios",
      target_app_version: "1.0.0",
    })) {
      const alias = Object.entries(query!.ExpressionAttributeNames!).find(
        ([name, actual]) => name.startsWith("#f") && actual === field,
      )?.[0];
      expect(alias, `native filter must retain ${field}`).toBeDefined();
      const valueAlias = `:v${alias!.slice(2)}`;
      expect(query!.ExpressionAttributeValues![valueAlias]).toBe(value);
      expect(query!.FilterExpression).toContain(
        `${alias} ${field === "id" ? "<" : "="} ${valueAlias}`,
      );
    }
  });

  it.each(["OR", "insensitive"] as const)(
    "rejects an indexed release predicate using %s instead of dropping it",
    async (unsupported) => {
      await expect(
        createCrud().findMany({
          model: "releases",
          where: [
            { field: "platform", value: "ios" },
            {
              field: "channel_id",
              value: "production-id",
              ...(unsupported === "OR"
                ? { connector: "OR" as const }
                : { mode: "insensitive" as const }),
            },
          ],
          limit: 2,
          offset: 0,
          orderBy: [{ field: "id", direction: "desc" }],
        }),
      ).rejects.toThrow("unsupported");
      expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
      expect(dynamodb.commandCalls(BatchGetCommand)).toHaveLength(0);
    },
  );

  it("increments the metadata counter without imposing a ceiling", async () => {
    // Given
    dynamodb.on(TransactWriteCommand).resolves({});

    // When
    dynamodb
      .on(BatchGetCommand)
      .resolves({ Responses: { "hot-updater-metadata": [] } });
    await createPlugin().commit({
      changes: [{ model: "bundles", operation: "insert", row: bundleRow }],
    });

    // Then
    expect(
      dynamodb
        .commandCalls(TransactWriteCommand)[0]
        ?.args[0].input.TransactItems?.find(
          (item) => item.Update?.Key?.sk === "limits.metadata",
        )?.Update,
    ).toMatchObject({
      Key: { pk: "_hot-updater", sk: "limits.metadata" },
      UpdateExpression: "ADD #bundles :bundleDelta",
    });
    expect(
      dynamodb
        .commandCalls(TransactWriteCommand)[0]
        ?.args[0].input.TransactItems?.find(
          (item) => item.Update?.Key?.sk === "limits.metadata",
        )?.Update,
    ).not.toHaveProperty("ConditionExpression");
  });

  it("locks both referenced bundles when creating a patch", async () => {
    // Given
    dynamodb.on(TransactWriteCommand).resolves({});

    // When
    dynamodb.on(BatchGetCommand).resolves({
      Responses: {
        "hot-updater-metadata": [
          toDynamoDBBundleItem(bundleRow),
          toDynamoDBBundleItem({ ...bundleRow, id: baseBundleId }),
        ],
      },
    });
    await createPlugin().commit({
      changes: [{ model: "bundlePatches", operation: "insert", row: patchRow }],
    });

    // Then
    const transaction =
      dynamodb.commandCalls(TransactWriteCommand)[0]?.args[0].input
        .TransactItems;
    expect(transaction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            Key: { pk: "bundles", sk: bundleId },
          }),
        }),
        expect.objectContaining({
          Update: expect.objectContaining({
            Key: { pk: "bundles", sk: baseBundleId },
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({ Item: toDynamoDBPatchItem(patchRow) }),
        }),
      ]),
    );
  });

  it("conditions deletes on every observed item version", async () => {
    // Given
    dynamodb
      .on(GetCommand, { Key: { pk: "bundle_patches", sk: patchRow.id } })
      .resolves({ Item: toDynamoDBPatchItem(patchRow, 7) });
    dynamodb.on(TransactWriteCommand).resolves({});

    dynamodb
      .on(GetCommand, { Key: { pk: "bundles", sk: bundleId } })
      .resolves({ Item: toDynamoDBBundleItem(bundleRow, 1, 1, 1) });
    // When
    dynamodb
      .on(QueryCommand)
      .resolves({ Items: [toDynamoDBPatchItem(patchRow, 7)] });
    const items = [
      toDynamoDBPatchItem(patchRow, 7),
      toDynamoDBBundleItem(bundleRow, 1, 1, 1),
      toDynamoDBBundleItem({ ...bundleRow, id: baseBundleId }, 1, 1, 0),
    ];
    dynamodb.on(BatchGetCommand).callsFake((input) => ({
      Responses: {
        "hot-updater-metadata": items.filter((item) =>
          input.RequestItems["hot-updater-metadata"].Keys.some(
            (key: { pk: string; sk: string }) =>
              key.pk === item.pk && key.sk === item.sk,
          ),
        ),
      },
    }));
    await createPlugin().commit({
      changes: [
        { model: "bundlePatches", operation: "delete", where: { bundleId } },
      ],
    });

    // Then
    const deletion = dynamodb
      .commandCalls(TransactWriteCommand)[0]
      ?.args[0].input.TransactItems?.find((item) => item.Delete)?.Delete;
    expect(deletion).toMatchObject({
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeValues: { ":currentVersion": 7 },
    });
  });
});
