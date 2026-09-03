import {
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DatabasePlugin } from "@hot-updater/plugin-core";

import {
  assertDockerDaemonAvailable,
  findOpenPort,
  formatRuntimeLogs,
  spawnRuntime,
  stopRuntime,
  type RuntimeChild,
  type RuntimeLogs,
} from "../../../packages/test-utils/src/runtimeProcess";
import { DYNAMODB_UPDATE_INDEX_NAME, dynamoDB } from "./dynamoDB";

const REGION = "us-east-1";
const LOCALSTACK_IMAGE = "localstack/localstack:3";
const credentials = {
  accessKeyId: "test",
  secretAccessKey: "test",
} as const;

const parseKey = (item: Record<string, unknown>) => {
  const pk = item.pk;
  const sk = item.sk;
  if (typeof pk !== "string" || typeof sk !== "string") {
    throw new Error("DynamoDB test row is missing its primary key");
  }
  return { pk, sk };
};

export class DynamoDBIntegrationFixture {
  readonly tableName = `hot-updater-${process.pid}-${Date.now()}`;
  client!: DynamoDBDocumentClient;
  endpoint = "";
  private runtime:
    | { readonly child: RuntimeChild; readonly logs: RuntimeLogs }
    | undefined;

  constructor() {
    assertDockerDaemonAvailable(
      "DynamoDB database integration tests require a running Docker daemon.",
    );
  }

  createPlugin(): DatabasePlugin {
    return dynamoDB({
      credentials,
      endpoint: this.endpoint,
      region: REGION,
      tableName: this.tableName,
    });
  }

  pauseNextQuery() {
    const name = `pause-query-${crypto.randomUUID()}`;
    let observed!: () => void;
    let resume!: () => void;
    const observedPromise = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const resumePromise = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let paused = false;
    this.client.middlewareStack.add(
      (next, context) => async (args) => {
        const result = await next(args);
        if (context.commandName === "QueryCommand" && !paused) {
          paused = true;
          observed();
          await resumePromise;
        }
        return result;
      },
      { name, step: "deserialize" },
    );
    return {
      observed: observedPromise,
      release: resume,
      remove: () => this.client.middlewareStack.remove(name),
    };
  }

  trackCommands(commandName: string) {
    const name = `track-command-${crypto.randomUUID()}`;
    let count = 0;
    this.client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === commandName) count += 1;
        return next(args);
      },
      { name, step: "initialize" },
    );
    return {
      count: () => count,
      reset: () => {
        count = 0;
      },
      remove: () => this.client.middlewareStack.remove(name),
    };
  }

  async start(): Promise<void> {
    const port = await findOpenPort();
    this.endpoint = `http://127.0.0.1:${port}`;
    this.runtime = spawnRuntime({
      command: "docker",
      args: [
        "run",
        "--rm",
        "-p",
        `127.0.0.1:${port}:4566`,
        "-e",
        "SERVICES=dynamodb",
        "-e",
        `DEFAULT_REGION=${REGION}`,
        LOCALSTACK_IMAGE,
      ],
      cwd: process.cwd(),
    });
    const rawClient = new DynamoDBClient({
      credentials,
      endpoint: this.endpoint,
      maxAttempts: 50,
      region: REGION,
    });
    this.client = DynamoDBDocumentClient.from(rawClient);
    try {
      await this.client.send(new ListTablesCommand({ Limit: 1 }));
      await rawClient.send(
        new CreateTableCommand({
          TableName: this.tableName,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
            { AttributeName: "gsi1pk", AttributeType: "S" },
            { AttributeName: "gsi1sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: DYNAMODB_UPDATE_INDEX_NAME,
              KeySchema: [
                { AttributeName: "gsi1pk", KeyType: "HASH" },
                { AttributeName: "gsi1sk", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            },
          ],
        }),
      );
      await waitUntilTableExists(
        { client: rawClient, maxWaitTime: 30 },
        { TableName: this.tableName },
      );
    } catch (error) {
      throw new Error(
        `DynamoDB test runtime failed: ${formatRuntimeLogs(this.runtime.logs)}`,
        { cause: error },
      );
    }
  }

  async reset(): Promise<void> {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          ExclusiveStartKey: exclusiveStartKey,
          ProjectionExpression: "#pk, #sk",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        }),
      );
      const keys = (page.Items ?? []).map(parseKey);
      for (let offset = 0; offset < keys.length; offset += 25) {
        await this.client.send(
          new BatchWriteCommand({
            RequestItems: {
              [this.tableName]: keys.slice(offset, offset + 25).map((key) => ({
                DeleteRequest: { Key: key },
              })),
            },
          }),
        );
      }
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
  }

  async stop(): Promise<void> {
    this.client.destroy();
    if (this.runtime) await stopRuntime(this.runtime.child);
  }
}
