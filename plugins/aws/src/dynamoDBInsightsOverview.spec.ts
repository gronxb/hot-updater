import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { getDynamoDBAppUsage } from "./dynamoDBInsightsOverview";

const dynamodb = mockClient(DynamoDBDocumentClient);

describe("DynamoDB Insights overview reads", () => {
  beforeEach(() => dynamodb.reset());

  it("bounds usage and latest-distribution reads by the requested window", async () => {
    dynamodb.on(QueryCommand).resolves({ Items: [] });
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
        region: "us-east-1",
      }),
    );

    await getDynamoDBAppUsage(
      { client, tableName: "hot-updater-metadata" },
      {
        channel: "production",
        platform: "all",
        timeRange: { start: 3_600_000, end: 7_200_000 },
        intervalMs: 3_600_000,
      },
    );

    const inputs = dynamodb
      .commandCalls(QueryCommand)
      .map(({ args }) => args[0].input);
    expect(inputs).toHaveLength(2);
    expect(inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :start AND :end",
          ExpressionAttributeValues: expect.objectContaining({
            ":start": "hour#0000000003600000",
            ":end": "hour#0000000007199999~",
          }),
        }),
        expect.objectContaining({
          KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :start AND :end",
          ExpressionAttributeValues: expect.objectContaining({
            ":start": "latest#0000000003600000",
            ":end": "latest#0000000007199999~",
          }),
        }),
      ]),
    );
  });
});
