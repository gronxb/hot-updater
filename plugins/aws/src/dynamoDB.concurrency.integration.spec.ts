import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  bundleToRow,
  createDatabaseClient,
  type Bundle,
} from "@hot-updater/plugin-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createReleaseRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { DynamoDBIntegrationFixture } from "./dynamoDB.integration-fixture";

const fixture = new DynamoDBIntegrationFixture();
const productionChannelId = "00000000-0000-0000-0000-000000000100";

const bundle = (sequence: number): Bundle => ({
  id: `00000000-0000-0000-0000-${sequence.toString().padStart(12, "0")}`,
  platform: "ios",
  gitCommitHash: null,
  metadata: {},
  manifestStorageUri: `storage://bundle-${sequence}/manifest.json`,
  manifestFileHash: `manifest-hash-${sequence}`,
  assetBaseStorageUri: "storage://assets",
});

const patchRow = (owner: Bundle, base: Bundle) => ({
  id: `${owner.id}:${base.id}`,
  bundle_id: owner.id,
  base_bundle_id: base.id,
  base_file_hash: `asset-hash-${base.id}`,
  patch_file_hash: `patch-${base.id}`,
  patch_storage_uri: `storage://patch-${base.id}`,
  byte_size: 3_000_000_002,
  order_index: 0,
});

beforeAll(() => fixture.start(), 120_000);
afterAll(() => fixture.stop());

describe("DynamoDB metadata concurrency and delete serialization", () => {
  beforeEach(() => fixture.reset());

  it("retries concurrent idempotent channel inserts without dropping either bundle", async () => {
    const plugin = fixture.createPlugin();
    const channel = { id: productionChannelId, name: "production" } as const;
    const rows = [bundleToRow(bundle(901)), bundleToRow(bundle(902))];

    await expect(
      Promise.all(
        rows.map((row) =>
          plugin.commit({
            changes: [
              {
                model: "channels",
                operation: "insert",
                row: channel,
                onConflict: "ignore",
              },
              { model: "bundles", operation: "insert", row },
            ],
          }),
        ),
      ),
    ).resolves.toEqual([{ committed: true }, { committed: true }]);
    await expect(plugin.models.channels.list({})).resolves.toEqual({
      channels: [channel],
    });
    await expect(plugin.models.bundles.findById(rows[0]!.id)).resolves.toEqual(
      rows[0],
    );
    await expect(plugin.models.bundles.findById(rows[1]!.id)).resolves.toEqual(
      rows[1],
    );
  });

  it("allows concurrent inserts beyond the former bundle ceiling", async () => {
    await fixture.client.send(
      new PutCommand({
        TableName: fixture.tableName,
        Item: {
          pk: "_hot-updater",
          sk: "limits.metadata",
          bundles: 999,
          patches: 0,
        },
      }),
    );
    const database = createDatabaseClient(fixture.createPlugin());

    await Promise.all([
      database.insertBundle(bundle(1)),
      database.insertBundle(bundle(2)),
    ]);

    await expect(database.getBundleById(bundle(1).id)).resolves.not.toBeNull();
    await expect(database.getBundleById(bundle(2).id)).resolves.not.toBeNull();
    await expect(
      fixture.client.send(
        new GetCommand({
          TableName: fixture.tableName,
          Key: { pk: "_hot-updater", sk: "limits.metadata" },
          ConsistentRead: true,
        }),
      ),
    ).resolves.toMatchObject({ Item: { bundles: 1_001 } });
  });

  it("allows more than 24 relationships per bundle", async () => {
    const database = createDatabaseClient(fixture.createPlugin());
    const bases = Array.from({ length: 25 }, (_, index) => bundle(index + 1));
    for (const base of bases) await database.insertBundle(base);
    const owner = {
      ...bundle(100),
      patches: bases.map((base) => ({
        baseBundleId: base.id,
        baseFileHash: `asset-hash-${base.id}`,
        patchFileHash: `patch-${base.id}`,
        patchStorageUri: `storage://patch-${base.id}`,
        byteSize: 3_000_000_002,
      })),
    };

    await database.insertBundle(owner);
    await database.updateBundleById(owner.id, {
      patches: bases.map((base) => ({
        baseBundleId: base.id,
        baseFileHash: `asset-hash-${base.id}`,
        patchFileHash: `updated-patch-${base.id}`,
        patchStorageUri: `storage://updated-patch-${base.id}`,
        byteSize: 3_000_000_003,
      })),
    });
    await expect(database.getBundleById(owner.id)).resolves.toMatchObject({
      patches: { length: 25 },
    });
  });

  it("reports DynamoDB's physical transaction action limit", async () => {
    const plugin = fixture.createPlugin();
    const owner = bundle(200);
    const bases = Array.from({ length: 101 }, (_, index) =>
      bundle(index + 300),
    );
    for (const base of bases)
      await plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundleToRow(base) },
        ],
      });
    await expect(
      plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundleToRow(owner) },
          ...bases.map((base) => ({
            model: "bundlePatches" as const,
            operation: "insert" as const,
            row: patchRow(owner, base),
          })),
        ],
      }),
    ).rejects.toMatchObject({ name: "DynamoDBTransactionLimitError" });
    await expect(plugin.models.bundles.findById(owner.id)).resolves.toBeNull();
  });

  it("allows a base bundle to be referenced by more than 24 patches", async () => {
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
            baseFileHash: `asset-hash-${base.id}`,
            patchFileHash: `patch-${sequence}`,
            patchStorageUri: `storage://patch-${sequence}`,
            byteSize: 3_000_000_002 + sequence,
          },
        ],
      });
    }

    await database.insertBundle({
      ...bundle(26),
      patches: [
        {
          baseBundleId: base.id,
          baseFileHash: `asset-hash-${base.id}`,
          patchFileHash: "patch-26",
          patchStorageUri: "storage://patch-26",
          byteSize: 3_000_000_028,
        },
      ],
    });
    await expect(database.getBundleById(bundle(26).id)).resolves.not.toBeNull();
    const storedBase = await fixture.client.send(
      new GetCommand({
        TableName: fixture.tableName,
        Key: { pk: "bundles", sk: base.id },
        ConsistentRead: true,
      }),
    );
    expect(storedBase.Item?.relation_count).toBe(25);
  });

  it.each(["owner", "base"] as const)(
    "serializes patch creation against %s deletion",
    async (deletedSide) => {
      const database = createDatabaseClient(fixture.createPlugin());
      const owner = bundle(1);
      const base = bundle(2);
      await database.insertBundle(owner);
      await database.insertBundle(base);
      const plugin = fixture.createTrackedPlugin();
      const paused = fixture.pauseNextQuery();
      const deleted = deletedSide === "owner" ? owner : base;

      const deletion = plugin.commit({
        changes: [
          { model: "bundles", operation: "delete", where: { id: deleted.id } },
        ],
      });
      await paused.observed;
      await plugin.commit({
        changes: [
          {
            model: "bundlePatches",
            operation: "insert",
            row: patchRow(owner, base),
          },
        ],
      });
      paused.release();
      await expect(deletion).resolves.toEqual({ committed: true });
      paused.remove();
      await expect(database.getBundleById(deleted.id)).resolves.toBeNull();
      await expect(
        plugin.models.bundlePatches.findByBundleIds([owner.id]),
      ).resolves.toEqual([]);
    },
  );

  it.each(["bundles", "channels"] as const)(
    "retains a %s parent when a release is inserted after its reference query",
    async (model) => {
      const plugin = fixture.createTrackedPlugin();
      const target = bundleToRow(bundle(1));
      const channel = { id: productionChannelId, name: "production" };
      await plugin.commit({
        changes: [
          { model: "bundles", operation: "insert", row: target },
          {
            model: "channels",
            operation: "insert",
            row: channel,
            onConflict: "ignore",
          },
        ],
      });
      const release = createReleaseRowFixture("901", target, channel);
      const paused = fixture.pauseNextQuery("#releases#");
      const deletion = plugin.commit({
        changes: [
          {
            model,
            operation: "delete",
            where: { id: model === "bundles" ? target.id : channel.id },
          },
        ],
      });
      try {
        await paused.observed;
        await expect(
          plugin.commit({
            changes: [{ model: "releases", operation: "insert", row: release }],
          }),
        ).resolves.toEqual({ committed: true });
      } finally {
        paused.release();
        paused.remove();
      }
      await expect(deletion).resolves.toEqual({
        committed: false,
        conflict: { changeIndex: 0, reason: "referenced" },
      });
      await expect(plugin.models.bundles.findById(target.id)).resolves.toEqual(
        target,
      );
      await expect(plugin.models.channels.list({})).resolves.toEqual({
        channels: [channel],
      });
      await expect(
        plugin.models.releases.findById(release.id),
      ).resolves.toEqual(release);
    },
  );

  it("serializes bundle updates against deletion", async () => {
    const database = createDatabaseClient(fixture.createPlugin());
    const target = bundle(1);
    await database.insertBundle(target);
    const plugin = fixture.createTrackedPlugin();
    const paused = fixture.pauseNextQuery();

    const deletion = plugin.commit({
      changes: [
        { model: "bundles", operation: "delete", where: { id: target.id } },
      ],
    });
    await paused.observed;
    await plugin.commit({
      changes: [
        {
          model: "bundles",
          operation: "update",
          where: { id: target.id },
          update: { metadata: { app_version: "updated-during-delete" } },
        },
      ],
    });
    paused.release();
    await expect(deletion).resolves.toEqual({ committed: true });
    paused.remove();
    await expect(database.getBundleById(target.id)).resolves.toBeNull();
  });

  it("atomically deletes multiple related bundles and shared patches", async () => {
    const database = createDatabaseClient(fixture.createPlugin());
    const plugin = fixture.createTrackedPlugin();
    const owner = bundle(1);
    const base = bundle(2);
    await database.insertBundle(owner);
    await database.insertBundle(base);
    await plugin.commit({
      changes: [
        {
          model: "bundlePatches",
          operation: "insert",
          row: patchRow(owner, base),
        },
      ],
    });
    await plugin.commit({
      changes: [
        {
          model: "bundlePatches",
          operation: "insert",
          row: {
            ...patchRow(owner, base),
            id: `${owner.id}:${base.id}:second`,
          },
        },
      ],
    });

    await plugin.commit({
      changes: [owner, base].map(({ id }) => ({
        model: "bundles" as const,
        operation: "delete" as const,
        where: { id },
      })),
    });

    await expect(plugin.models.bundles.count()).resolves.toBe(0);
    await expect(
      plugin.models.bundlePatches.findByBundleIds([owner.id, base.id]),
    ).resolves.toEqual([]);
  });
});
