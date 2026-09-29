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
  builtInSchema,
  builtInSettings,
  encodeKvKey,
  SETTINGS_TABLE,
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

/** A Release Catalog insert; DynamoDB is mocked, so only its key matters. */
const catalogInsert: WriteOp = {
  type: "insert",
  table: builtInSchema.models.get("release_catalogs")!.table,
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
