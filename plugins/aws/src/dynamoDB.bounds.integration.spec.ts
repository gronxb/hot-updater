import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  bundleToRow,
  createDatabaseClient,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  boundedDynamoDBMetadataItem,
  DYNAMODB_MAX_METADATA_ITEM_BYTES,
} from "./dynamoDB";
import { createDynamoDBCrud, queryCompleteOwnersPatches } from "./dynamoDB";
import { toDynamoDBBundleItem, toDynamoDBPatchItem } from "./dynamoDB";
import { DynamoDBIntegrationFixture } from "./dynamoDB.integration-fixture";

const fixture = new DynamoDBIntegrationFixture();
const bundleCount = 1_001;
const patchCount = 1_001;
const patchesPerOwner = 25;

beforeAll(() => fixture.start(), 120_000);
afterAll(() => fixture.stop());

describe("DynamoDB reads beyond the former metadata ceiling", () => {
  beforeEach(() => fixture.reset());

  it("keeps cursor pages constant and owner hydration targeted", async () => {
    const bundleRows = Array.from({ length: bundleCount }, (_, index) =>
      bundleToRow({
        id: `10000000-0000-0000-0000-${index.toString().padStart(12, "0")}`,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: `hash-${index}`,
        gitCommitHash: null,
        message: null,
        channel: "production",
        storageUri: `storage://bundle-${index}.zip`,
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {},
      }),
    );
    const relationCounts = new Map<string, number>();
    const ownedPatchCounts = new Map<string, number>();
    const patchRows = Array.from({ length: patchCount }, (_, index) => {
      const owner = bundleRows[Math.floor(index / patchesPerOwner)];
      const base = bundleRows[500 + Math.floor(index / patchesPerOwner)];
      if (!owner || !base) throw new Error("Missing read fixture row");
      relationCounts.set(owner.id, (relationCounts.get(owner.id) ?? 0) + 1);
      relationCounts.set(base.id, (relationCounts.get(base.id) ?? 0) + 1);
      ownedPatchCounts.set(owner.id, (ownedPatchCounts.get(owner.id) ?? 0) + 1);
      return {
        id: `patch-${index.toString().padStart(4, "0")}`,
        bundle_id: owner.id,
        base_bundle_id: base.id,
        base_file_hash: base.file_hash,
        patch_file_hash: `patch-hash-${index}`,
        patch_storage_uri: "",
        order_index: index % patchesPerOwner,
      };
    });
    const bundleItems = bundleRows.map((row) => {
      const empty = toDynamoDBBundleItem(
        { ...row, metadata: { padding: "" } },
        1,
        relationCounts.get(row.id) ?? 0,
        ownedPatchCounts.get(row.id) ?? 0,
      );
      const bytes = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
      return boundedDynamoDBMetadataItem(
        toDynamoDBBundleItem(
          {
            ...row,
            metadata: {
              padding: "x".repeat(DYNAMODB_MAX_METADATA_ITEM_BYTES - bytes),
            },
          },
          1,
          relationCounts.get(row.id) ?? 0,
          ownedPatchCounts.get(row.id) ?? 0,
        ),
      );
    });
    const patchItems = patchRows.map((row) => {
      const empty = toDynamoDBPatchItem(row);
      const bytes = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
      return boundedDynamoDBMetadataItem(
        toDynamoDBPatchItem({
          ...row,
          patch_storage_uri: "x".repeat(
            DYNAMODB_MAX_METADATA_ITEM_BYTES - bytes,
          ),
        }),
      );
    });
    const items = [
      ...bundleItems,
      ...patchItems,
      {
        pk: "_hot-updater",
        sk: "limits.metadata",
        bundles: bundleCount,
        patches: patchCount,
      },
    ];
    for (let offset = 0; offset < items.length; offset += 25) {
      await fixture.client.send(
        new BatchWriteCommand({
          RequestItems: {
            [fixture.tableName]: items
              .slice(offset, offset + 25)
              .map((Item) => ({ PutRequest: { Item } })),
          },
        }),
      );
    }
    const crud = createDynamoDBCrud(
      { client: fixture.client, tableName: fixture.tableName },
      "hot-updater-update-index",
    );
    const queries = fixture.trackCommands("QueryCommand");
    const batchGets = fixture.trackCommands("BatchGetItemCommand");
    const gets = fixture.trackCommands("GetItemCommand");

    await expect(
      crud.findMany({
        model: "bundles",
        limit: 100,
        offset: 0,
        orderBy: [{ field: "id", direction: "asc" }],
      }),
    ).resolves.toHaveLength(100);
    expect(queries.count()).toBe(1);
    queries.reset();
    await expect(
      crud.findMany({
        model: "bundles",
        where: [{ field: "id", operator: "gt", value: bundleRows[899]?.id }],
        limit: 100,
        offset: 0,
        orderBy: [{ field: "id", direction: "asc" }],
      }),
    ).resolves.toHaveLength(100);
    expect(queries.count()).toBe(1);
    queries.reset();
    await expect(
      crud.findMany({
        model: "bundle_patches",
        where: [
          { field: "bundle_id", operator: "in", value: [bundleRows[0]?.id] },
        ],
        limit: 100,
        offset: 0,
        orderBy: [{ field: "id", direction: "asc" }],
      }),
    ).resolves.toHaveLength(patchesPerOwner);
    expect(queries.count()).toBe(1);
    await expect(
      queryCompleteOwnersPatches(
        { client: fixture.client, tableName: fixture.tableName },
        "hot-updater-update-index",
        bundleRows.slice(0, 50).map(({ id }) => id),
      ),
    ).resolves.toHaveLength(patchCount);
    queries.reset();
    batchGets.reset();
    gets.reset();

    const trackedPlugin = createDatabasePlugin({
      name: "tracked-dynamodb",
      plugin: () => crud,
      bundlePatches: {
        findByBundleIds: (bundleIds) =>
          queryCompleteOwnersPatches(
            { client: fixture.client, tableName: fixture.tableName },
            "hot-updater-update-index",
            bundleIds,
          ),
      },
    });
    const page = await createDatabaseClient(trackedPlugin).getBundles({
      limit: 50,
      orderBy: { field: "id", direction: "asc" },
    });

    expect(page.data).toHaveLength(50);
    expect(page.pagination.total).toBe(bundleCount);
    expect(queries.count()).toBe(42);
    expect(batchGets.count()).toBe(13);
    expect(gets.count()).toBe(1);
    queries.remove();
    batchGets.remove();
    gets.remove();
  });
});
