import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { dynamoDB } from "./dynamoDB";

const client = mockClient(DynamoDBDocumentClient);
const plugin = () => dynamoDB({ region: "us-east-1", tableName: "metadata" });

describe("DynamoDB bounded reads", () => {
  beforeEach(() => {
    client.reset();
    client
      .on(GetCommand)
      .callsFake((input) =>
        input.Key.sk === "metadata-indexes" ? { Item: { version: 1 } } : {},
      );
    client.on(BatchGetCommand).resolves({ Responses: { metadata: [] } });
    client.on(QueryCommand).resolves({ Items: [], Count: 0 });
    client.on(ScanCommand).rejects(new Error("table scan is forbidden"));
  });

  it("pushes both ends of an id window into the partition key query", async () => {
    await plugin().models.bundles.findMany({
      where: { id: { gt: "a", lt: "z" } },
      limit: 2,
      offset: 0,
      orderBy: { field: "id", direction: "asc" },
    });
    expect(
      client.commandCalls(QueryCommand)[0]?.args[0].input
        .KeyConditionExpression,
    ).toContain("BETWEEN");
  });

  it("updates a missing bundle using keys without reading metadata partitions", async () => {
    client
      .on(QueryCommand)
      .rejects(new Error("commit loaded a metadata partition"));
    client.on(TransactWriteCommand).resolves({});
    await expect(
      plugin().commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id: "missing" },
            update: { file_hash: "updated" },
          },
        ],
      }),
    ).resolves.toMatchObject({
      committed: false,
      conflict: { reason: "not_found" },
    });
    expect(client.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("does not scan metadata when the count projection is missing", async () => {
    client.on(QueryCommand).resolves({ Count: 1 });
    await expect(plugin().models.bundles.count()).rejects.toThrow(/count/i);
    expect(client.commandCalls(QueryCommand)).toHaveLength(1);
    expect(client.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      Limit: 1,
      Select: "COUNT",
    });
  });

  it("lists a release page without scanning the shared table", async () => {
    await expect(
      plugin().models.releases.findMany({ limit: 2 }),
    ).resolves.toEqual([]);
    expect(client.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it("uses a native count without hydrating matching bundles", async () => {
    client.on(QueryCommand).callsFake((input) => {
      if (input.Select !== "COUNT")
        throw new Error("count hydrated the bundle partition");
      return { Count: 3 };
    });
    await expect(
      plugin().models.bundles.count({ platform: "ios" }),
    ).resolves.toBe(3);
  });
});
