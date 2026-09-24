import {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  DynamoDBClient,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  builtInSchema,
  builtInSettings,
  encodeKvKey,
  SETTINGS_TABLE,
  type StoredRow,
  type WriteOp,
} from "@hot-updater/server/database";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type DynamoDBConfig, dynamoDB } from "./dynamoDB";

const TABLE_NAME = "hot-updater-metadata";
const DISTRIBUTION_ID = "distribution-id";

const config = {
  cloudfrontDistributionId: DISTRIBUTION_ID,
  region: "us-east-1",
  tableName: TABLE_NAME,
} satisfies DynamoDBConfig;

/** The settings items the schema fence reads before the first write. */
const settingsItems = Object.entries(builtInSettings).map(([key, value]) => ({
  pk: SETTINGS_TABLE.name,
  sk: encodeKvKey([key]),
  key,
  value,
  _v: 0,
}));

/** An insert into a built-in table; DynamoDB is mocked, so only its key matters. */
const insert = (table: string, row: StoredRow): WriteOp => ({
  type: "insert",
  table: builtInSchema.models.get(table)!.table,
  row: { ...row, _v: 0 },
});

const catalogInsert = insert("release_catalogs", {
  scope_key: "v1:app-version:ios:cHJvZHVjdGlvbg",
});
const channelInsert = insert("channels", {
  id: "channel:cHJvZHVjdGlvbg",
  name: "production",
});

/** DynamoDB holding the schema settings; each transaction commits, or is canceled on a failed condition. */
const mockDynamoDB = ({ commits = true } = {}) =>
  vi
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockImplementation(async (command: unknown) => {
      if (command instanceof BatchGetCommand) {
        return { Responses: { [TABLE_NAME]: settingsItems } } as never;
      }
      if (!(command instanceof TransactWriteCommand)) {
        throw new Error("Unexpected command");
      }
      if (!commits) {
        throw new TransactionCanceledException({
          $metadata: {},
          message: "Transaction cancelled",
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
        });
      }
      return {} as never;
    });

const mockCloudFront = () =>
  vi.spyOn(CloudFrontClient.prototype, "send").mockResolvedValue({} as never);

describe("dynamoDB CloudFront invalidation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invalidates the update-check routes once after a write that changes a Release Catalog", async () => {
    mockDynamoDB();
    const send = mockCloudFront();
    const database = dynamoDB(config);

    await expect(
      database.adapter.write([channelInsert, catalogInsert]),
    ).resolves.toEqual({ ok: true });

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

  it("does not invalidate after a write to other tables", async () => {
    mockDynamoDB();
    const send = mockCloudFront();
    const database = dynamoDB(config);

    await expect(database.adapter.write([channelInsert])).resolves.toEqual({
      ok: true,
    });

    expect(send).not.toHaveBeenCalled();
    await database.dispose?.();
  });

  it("does not invalidate for a check that only guards a catalog it read", async () => {
    mockDynamoDB();
    const send = mockCloudFront();
    const database = dynamoDB(config);
    const catalogCheck: WriteOp = {
      type: "check",
      table: builtInSchema.models.get("release_catalogs")!.table,
      key: ["v1:app-version:ios:cHJvZHVjdGlvbg"],
      guard: { v: 0 },
    };

    await expect(
      database.adapter.write([channelInsert, catalogCheck]),
    ).resolves.toEqual({ ok: true });

    expect(send).not.toHaveBeenCalled();
    await database.dispose?.();
  });

  it("does not invalidate after a failed write", async () => {
    mockDynamoDB({ commits: false });
    const send = mockCloudFront();
    const database = dynamoDB(config);

    await expect(database.adapter.write([catalogInsert])).resolves.toEqual({
      ok: false,
      failedOp: 0,
    });

    expect(send).not.toHaveBeenCalled();
    await database.dispose?.();
  });

  it("does not reach CloudFront without a distribution", async () => {
    mockDynamoDB();
    const send = mockCloudFront();
    const database = dynamoDB({ region: "us-east-1", tableName: TABLE_NAME });

    await expect(database.adapter.write([catalogInsert])).resolves.toEqual({
      ok: true,
    });

    expect(send).not.toHaveBeenCalled();
    await database.dispose?.();
  });

  it("waits for the invalidation to complete when configured", async () => {
    vi.useFakeTimers();
    mockDynamoDB();
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

    const write = database.adapter.write([catalogInsert]);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(write).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetInvalidationCommand);
    await database.dispose?.();
  });

  it("only warns when the invalidation fails", async () => {
    mockDynamoDB();
    mockCloudFront().mockRejectedValue(new Error("Access denied"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const database = dynamoDB(config);

    await expect(database.adapter.write([catalogInsert])).resolves.toEqual({
      ok: true,
    });

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
