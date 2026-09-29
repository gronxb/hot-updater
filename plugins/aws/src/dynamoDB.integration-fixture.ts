import {
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";

import {
  assertDockerDaemonAvailable,
  findOpenPort,
  formatRuntimeLogs,
  spawnRuntime,
  stopRuntime,
} from "../../../packages/test-utils/src/runtimeProcess";

const REGION = "us-east-1";
const IMAGE = "amazon/dynamodb-local:latest";

/** DynamoDB Local in Docker, for integration specs: one runtime, a table per case. */
export const startDynamoDBLocal = async () => {
  assertDockerDaemonAvailable(
    "DynamoDB integration specs need a running Docker daemon.",
  );
  const port = await findOpenPort();
  const runtime = spawnRuntime({
    command: "docker",
    args: [
      "run",
      "--rm",
      "-p",
      `127.0.0.1:${port}:8000`,
      IMAGE,
      "-jar",
      "DynamoDBLocal.jar",
      "-inMemory",
      "-sharedDb",
    ],
    cwd: process.cwd(),
  });
  const config = {
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    endpoint: `http://127.0.0.1:${port}`,
    maxAttempts: 10,
    region: REGION,
  };
  const client = new DynamoDBClient(config);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.send(new ListTablesCommand({ Limit: 1 }));
      break;
    } catch (error) {
      if (attempt > 120) {
        throw new Error(
          `DynamoDB Local did not start: ${formatRuntimeLogs(runtime.logs)}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  let tables = 0;
  return {
    client,
    config,
    /** A fresh table name; the store's migration creates it. */
    tableName: () => `hot-updater-${process.pid}-${(tables += 1)}`,
    dropTable: (tableName: string) =>
      client.send(new DeleteTableCommand({ TableName: tableName })),
    stop: async () => {
      client.destroy();
      await stopRuntime(runtime.child);
    },
  };
};

export type DynamoDBLocal = Awaited<ReturnType<typeof startDynamoDBLocal>>;
