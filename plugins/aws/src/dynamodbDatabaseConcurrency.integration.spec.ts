import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  bundleToRow,
  createDatabaseClient,
  type Bundle,
} from "@hot-updater/plugin-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DynamoDBIntegrationFixture } from "./dynamodbDatabase.integration-fixture";
import { createDynamoDBAggregateMutations } from "./dynamodbDatabaseAggregate";
import { DYNAMODB_MAX_BUNDLES } from "./dynamodbDatabaseBounds";
import { createDynamoDBCrud } from "./dynamodbDatabaseCrud";
import { DYNAMODB_MAX_RELATIONSHIPS_PER_BUNDLE } from "./dynamodbDatabaseTransactions";

const fixture = new DynamoDBIntegrationFixture();

const bundle = (sequence: number): Bundle => ({
  id: `00000000-0000-0000-0000-${sequence.toString().padStart(12, "0")}`,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${sequence}`,
  gitCommitHash: null,
  message: null,
  channel: "production",
  storageUri: `storage://bundle-${sequence}.zip`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  metadata: {},
});

const patchRow = (owner: Bundle, base: Bundle) => ({
  id: `${owner.id}:${base.id}`,
  bundle_id: owner.id,
  base_bundle_id: base.id,
  base_file_hash: base.fileHash,
  patch_file_hash: `patch-${base.id}`,
  patch_storage_uri: `storage://patch-${base.id}`,
  order_index: 0,
});

beforeAll(() => fixture.start(), 120_000);
afterAll(() => fixture.stop());

describe("DynamoDB bounded metadata and delete serialization", () => {
  beforeEach(() => fixture.reset());

  it("accepts the bundle ceiling and rejects ceiling plus one", async () => {
    await fixture.client.send(
      new PutCommand({
        TableName: fixture.tableName,
        Item: {
          pk: "_hot-updater",
          sk: "limits.metadata",
          bundles: DYNAMODB_MAX_BUNDLES - 1,
          patches: 0,
        },
      }),
    );
    const database = createDatabaseClient(fixture.createPlugin());

    await database.insertBundle(bundle(1));
    await expect(database.insertBundle(bundle(2))).rejects.toBeDefined();

    await expect(database.getBundleById(bundle(1).id)).resolves.not.toBeNull();
    await expect(database.getBundleById(bundle(2).id)).resolves.toBeNull();
  });

  it("accepts 24 relationships and rejects 25 and 101", async () => {
    const database = createDatabaseClient(fixture.createPlugin());
    const bases = Array.from(
      { length: DYNAMODB_MAX_RELATIONSHIPS_PER_BUNDLE + 1 },
      (_, index) => bundle(index + 1),
    );
    for (const base of bases) await database.insertBundle(base);
    const owner = {
      ...bundle(100),
      patches: bases.slice(0, 24).map((base) => ({
        baseBundleId: base.id,
        baseFileHash: base.fileHash,
        patchFileHash: `patch-${base.id}`,
        patchStorageUri: `storage://patch-${base.id}`,
      })),
    };

    await database.insertBundle(owner);
    await expect(
      database.updateBundleById(owner.id, {
        patches: bases.map((base) => ({
          baseBundleId: base.id,
          baseFileHash: base.fileHash,
          patchFileHash: `patch-${base.id}`,
          patchStorageUri: `storage://patch-${base.id}`,
        })),
      }),
    ).rejects.toMatchObject({ name: "DynamoDBRelationshipLimitError" });
    await expect(
      createDynamoDBAggregateMutations({
        client: fixture.client,
        tableName: fixture.tableName,
      }).insertBundleWithPatches({
        bundle: bundleToRow(bundle(200)),
        patches: Array.from({ length: 101 }, (_, index) =>
          patchRow(bundle(200), bundle(index + 300)),
        ),
      }),
    ).rejects.toMatchObject({ name: "DynamoDBRelationshipLimitError" });
    await expect(database.getBundleById(owner.id)).resolves.toMatchObject({
      patches: { length: 24 },
    });
  });

  it("rolls back a new owner when its base reaches 24 relationships", async () => {
    const database = createDatabaseClient(fixture.createPlugin());
    const base = bundle(1);
    await database.insertBundle(base);
    for (let sequence = 2; sequence <= 25; sequence++) {
      const owner = bundle(sequence);
      await database.insertBundle({
        ...owner,
        patches: [
          {
            baseBundleId: base.id,
            baseFileHash: base.fileHash,
            patchFileHash: `patch-${sequence}`,
            patchStorageUri: `storage://patch-${sequence}`,
          },
        ],
      });
    }

    await expect(
      database.insertBundle({
        ...bundle(26),
        patches: [
          {
            baseBundleId: base.id,
            baseFileHash: base.fileHash,
            patchFileHash: "patch-26",
            patchStorageUri: "storage://patch-26",
          },
        ],
      }),
    ).rejects.toBeDefined();
    await expect(database.getBundleById(bundle(26).id)).resolves.toBeNull();
  });

  it.each(["owner", "base"] as const)(
    "serializes patch creation against %s deletion",
    async (deletedSide) => {
      const database = createDatabaseClient(fixture.createPlugin());
      const owner = bundle(1);
      const base = bundle(2);
      await database.insertBundle(owner);
      await database.insertBundle(base);
      const crud = createDynamoDBCrud(
        {
          client: fixture.client,
          tableName: fixture.tableName,
        },
        "hot-updater-update-index",
      );
      const paused = fixture.pauseNextQuery();
      const deleted = deletedSide === "owner" ? owner : base;

      const deletion = crud.delete({
        model: "bundles",
        where: [{ field: "id", operator: "eq", value: deleted.id }],
      });
      await paused.observed;
      await crud.create({
        model: "bundle_patches",
        data: patchRow(owner, base),
      });
      paused.release();
      await expect(deletion).rejects.toBeDefined();
      paused.remove();

      await expect(database.getBundleById(deleted.id)).resolves.not.toBeNull();
      await expect(database.getBundleById(owner.id)).resolves.toMatchObject({
        patches: { length: 1 },
      });
    },
  );

  it("serializes bundle updates against deletion", async () => {
    const database = createDatabaseClient(fixture.createPlugin());
    const target = bundle(1);
    await database.insertBundle(target);
    const crud = createDynamoDBCrud(
      {
        client: fixture.client,
        tableName: fixture.tableName,
      },
      "hot-updater-update-index",
    );
    const paused = fixture.pauseNextQuery();

    const deletion = crud.delete({
      model: "bundles",
      where: [{ field: "id", operator: "eq", value: target.id }],
    });
    await paused.observed;
    await crud.update({
      model: "bundles",
      where: [{ field: "id", operator: "eq", value: target.id }],
      update: { message: "updated during delete" },
    });
    paused.release();
    await expect(deletion).rejects.toBeDefined();
    paused.remove();

    await expect(database.getBundleById(target.id)).resolves.toMatchObject({
      message: "updated during delete",
    });
    const stored = await fixture.client.send(
      new GetCommand({
        TableName: fixture.tableName,
        Key: { pk: "bundles", sk: target.id },
        ConsistentRead: true,
      }),
    );
    expect(stored.Item?.version).toBe(2);
  });

  it("deletes multiple related bundles in resumable atomic groups", async () => {
    const plugin = fixture.createPlugin();
    const database = createDatabaseClient(plugin);
    const owner = bundle(1);
    const base = bundle(2);
    await database.insertBundle(owner);
    await database.insertBundle(base);
    await plugin.create({
      model: "bundle_patches",
      data: patchRow(owner, base),
    });
    await plugin.create({
      model: "bundle_patches",
      data: { ...patchRow(owner, base), id: `${owner.id}:${base.id}:second` },
    });

    await plugin.delete({
      model: "bundles",
      where: [{ field: "platform", operator: "eq", value: "ios" }],
    });

    await expect(plugin.count({ model: "bundles" })).resolves.toBe(0);
    await expect(plugin.count({ model: "bundle_patches" })).resolves.toBe(0);
  });
});
