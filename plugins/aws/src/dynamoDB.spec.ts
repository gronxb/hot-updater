import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  coreSchema,
  coreSettings,
  createKvAdapter,
  encodeKvKey,
  type PhysicalTable,
  SETTINGS_TABLE,
  type WriteOp,
} from "@hot-updater/server/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type DynamoDBConfig, dynamoDB } from "./dynamoDB";
import { createDynamoDBStore, DYNAMODB_TTL_ATTRIBUTE } from "./dynamoDBStore";

const TABLE_NAME = "hot-updater-metadata";
const DISTRIBUTION_ID = "distribution-id";

const config = {
  cloudfrontDistributionId: DISTRIBUTION_ID,
  region: "us-east-1",
  tableName: TABLE_NAME,
} satisfies DynamoDBConfig;

/** The settings items the schema fence reads before the first write. */
const settingsItems = Object.entries(coreSettings).map(([key, value]) => ({
  pk: SETTINGS_TABLE.name,
  sk: encodeKvKey([key]),
  key,
  value,
  _v: 0,
}));

/** A Release Catalog insert; DynamoDB is mocked, so only its key matters. */
const catalogInsert: WriteOp = {
  type: "insert",
  table: coreSchema.models.get("release_catalogs")!.table,
  row: { scope_key: "v1:app-version:ios:cHJvZHVjdGlvbg", _v: 0 },
};

/** DynamoDB holding the schema settings, where every transaction commits. */
const mockDynamoDB = () =>
  vi
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockImplementation(async (command: unknown) => {
      if (command instanceof BatchGetCommand) {
        return { Responses: { [TABLE_NAME]: settingsItems } } as never;
      }
      if (command instanceof TransactWriteCommand) return {} as never;
      throw new Error("Unexpected command");
    });

const mockCloudFront = () =>
  vi.spyOn(CloudFrontClient.prototype, "send").mockResolvedValue({} as never);

describe("dynamoDB CloudFront invalidation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("gives core a purge that invalidates the update-check routes", async () => {
    const send = mockCloudFront();
    const database = dynamoDB(config);

    await database.onCachedRoutesChange?.();

    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0]!;
    expect(command).toBeInstanceOf(CreateInvalidationCommand);
    expect(command).toMatchObject({
      input: {
        DistributionId: DISTRIBUTION_ID,
        InvalidationBatch: {
          Paths: { Quantity: 1, Items: ["/release-catalogs/*"] },
        },
      },
    });
    await database.dispose?.();
  });

  it("leaves the choice of writes to core: a catalog write through the adapter purges nothing", async () => {
    mockDynamoDB();
    const send = mockCloudFront();
    const database = dynamoDB(config);

    await expect(database.adapter.write([catalogInsert])).resolves.toEqual({
      ok: true,
    });

    expect(send).not.toHaveBeenCalled();
    await database.dispose?.();
  });

  it("has no purge without a distribution", async () => {
    const send = mockCloudFront();
    const database = dynamoDB({ region: "us-east-1", tableName: TABLE_NAME });

    expect(database.onCachedRoutesChange).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    await database.dispose?.();
  });

  it("waits for the invalidation to complete when configured", async () => {
    vi.useFakeTimers();
    const send = mockCloudFront().mockImplementation(
      async (command: unknown) =>
        ({
          Invalidation: {
            Id: "invalidation-id",
            Status:
              command instanceof GetInvalidationCommand
                ? "Completed"
                : "InProgress",
          },
        }) as never,
    );
    const database = dynamoDB({ ...config, shouldWaitForInvalidation: true });

    const purge = database.onCachedRoutesChange?.();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(purge).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetInvalidationCommand);
    await database.dispose?.();
  });

  it("only warns when the invalidation fails", async () => {
    mockCloudFront().mockRejectedValue(new Error("Access denied"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const database = dynamoDB(config);

    await expect(database.onCachedRoutesChange?.()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "[hot-updater/aws] CloudFront invalidation failed; continuing without cache invalidation.",
      { distributionId: DISTRIBUTION_ID, error: "Access denied" },
    );
    await database.dispose?.();
  });

  it("destroys its DynamoDB and CloudFront clients on dispose", async () => {
    const destroyDynamoDB = vi.spyOn(DynamoDBClient.prototype, "destroy");
    const destroyCloudFront = vi.spyOn(CloudFrontClient.prototype, "destroy");

    await dynamoDB(config).dispose?.();

    expect(destroyDynamoDB).toHaveBeenCalledTimes(1);
    expect(destroyCloudFront).toHaveBeenCalledTimes(1);
  });
});

describe("dynamoDB TTL", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A table whose rows expire a day after `at`, with one index copy. */
  const expiring: PhysicalTable = {
    name: "expiring",
    columns: [
      { name: "id", type: "string", nullable: false },
      { name: "grp", type: "string", nullable: false },
      { name: "at", type: "integer", nullable: false },
      { name: "hits", type: "integer", nullable: false },
      { name: "_v", type: "integer", nullable: false },
    ],
    key: ["id"],
    indexes: [{ name: "byGroup", eq: ["grp"], sort: ["at"] }],
    retention: { column: "at", ms: 86_400_000 },
  };

  const createAdapter = () =>
    createKvAdapter({
      store: createDynamoDBStore({
        client: new DynamoDBClient({ region: "us-east-1" }),
        tableName: TABLE_NAME,
      }),
    });

  it("puts the expiry, in epoch seconds, on the row item and its index copy", async () => {
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, "send")
      .mockResolvedValue({} as never);
    const adapter = createAdapter();

    await adapter.write([
      {
        type: "insert",
        table: expiring,
        row: { id: "a", grp: "g", at: 1_500, hits: 0, _v: 0 },
      },
      {
        type: "increment",
        table: { ...expiring, name: "counts", indexes: [] },
        key: ["c"],
        by: { hits: 1 },
        init: { id: "c", grp: "g", at: 2_000, hits: 0, _v: 0 },
      },
    ]);

    const [command] = send.mock.calls[0]!;
    const items = (command as TransactWriteCommand).input.TransactItems!;
    const puts = items.flatMap((item) => (item.Put ? [item.Put.Item!] : []));
    expect(puts).toHaveLength(2);
    // 1,500 ms plus a day, rounded up to a whole second.
    for (const put of puts) {
      expect(put[DYNAMODB_TTL_ATTRIBUTE]).toBe(86_402);
    }
    const update = items.find((item) => item.Update)!.Update!;
    expect(update.UpdateExpression).toContain("if_not_exists");
    expect(Object.values(update.ExpressionAttributeNames!)).toContain(
      DYNAMODB_TTL_ATTRIBUTE,
    );
    expect(Object.values(update.ExpressionAttributeValues!)).toContain(86_402);
  });

  it("reads a row without its TTL attribute", async () => {
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({
      Responses: {
        [TABLE_NAME]: [
          {
            pk: "expiring",
            sk: encodeKvKey(["a"]),
            id: "a",
            grp: "g",
            at: 1_500,
            hits: 0,
            _v: 0,
            [DYNAMODB_TTL_ATTRIBUTE]: 86_402,
          },
        ],
      },
    } as never);

    const [row] = await createAdapter().get(expiring, [["a"]]);

    expect(row).toEqual({ id: "a", grp: "g", at: 1_500, hits: 0, _v: 0 });
  });
});
