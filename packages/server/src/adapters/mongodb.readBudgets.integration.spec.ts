import path from "node:path";

import { setupReadBudgetTestSuite } from "@hot-updater/test-utils";
import {
  assertDockerComposeAvailable,
  findOpenPort,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll } from "vitest";

import { readBudgetServer } from "../readBudgets.testFixtures";
import { createMongoAdapter } from "./mongodbAdapter";

assertDockerComposeAvailable(
  "MongoDB read-budget tests need Docker Compose and a running Docker daemon.",
);

const composeFile = path.resolve(
  import.meta.dirname,
  "../../../../examples-server/hono-mongodb/docker-compose.yml",
);
let environment: Record<string, string> | undefined;
const compose = (args: readonly string[]) =>
  execa("docker", ["compose", "-f", composeFile, ...args], {
    env: environment,
  });

let client: MongoClient;

beforeAll(async () => {
  const port = await findOpenPort();
  environment = {
    COMPOSE_PROJECT_NAME: `hot-updater-mongo-budgets-${process.pid}`,
    HOT_UPDATER_E2E_MONGODB_PORT: String(port),
  };
  await compose(["up", "-d", "--wait"]);
  client = new MongoClient(
    `mongodb://127.0.0.1:${port}/budgets?replicaSet=rs0&directConnection=true`,
  );
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.close();
  if (environment) await compose(["down", "-v", "--remove-orphans"]);
}, 60_000);

/**
 * `mongoAdapter`'s composition without its schema fence: the MongoDB adapter
 * on the replica set, reading in batches as small as the suite's pages.
 */
setupReadBudgetTestSuite({
  name: "mongodb (replica set)",
  server: readBudgetServer,
  createAdapter: async ({ tables, nativePageSize }) => {
    const adapter = createMongoAdapter({ client, batchSize: nativePageSize });
    await adapter.migrations!.apply(tables);
    return { adapter };
  },
});
