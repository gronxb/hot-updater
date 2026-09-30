import type { EngineDatabase } from "@hot-updater/plugin-core";
import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { toolingTargetOf } from "@hot-updater/server/database";
import { provisionClientCredential } from "@hot-updater/server/db";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  ensureTable: vi.fn(),
  migrateDynamoDB: vi.fn(),
}));

vi.mock("./dynamodb", () => ({
  DynamoDBManager: vi.fn(function DynamoDBManager() {
    return { ensureTable: mocks.ensureTable };
  }),
}));

vi.mock("../src/dynamoDB", () => ({
  dynamoDB: vi.fn(),
}));

vi.mock("../src/dynamoDBMigration", () => ({
  migrateDynamoDB: mocks.migrateDynamoDB,
}));

import { plugins } from "../src/plugins";
import { prepareDynamoDBDeployment } from "./index";

const EXISTING_API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

/** A database on the storage engine, where the apiKeys() plugin keeps its table. */
const createDatabase = (): EngineDatabase => ({
  name: "memory",
  adapter: createMemoryAdapter(),
});

/** The rows the apiKeys() plugin stored, digests included. */
const storedApiKeys = (database: EngineDatabase) =>
  database.adapter.query(
    toolingTargetOf([apiKeys()]).schema.models.get("api_keys")!.table,
    {
      index: "byCreated",
      eq: [],
      order: "asc",
      limit: 10,
    },
  );

/** What init provisions: the app's credential, through the managed server's plugins. */
const provision = (database: EngineDatabase, existing?: string) =>
  provisionClientCredential(database, plugins, {
    env: existing === undefined ? {} : { HOT_UPDATER_API_KEY: existing },
    name: "AWS init",
  });

describe("AWS client credential provisioning", () => {
  it("registers the existing app key without persisting the raw value", async () => {
    const database = createDatabase();

    const credential = await provision(database, EXISTING_API_KEY);

    expect(credential).toMatchObject({
      label: "API key",
      header: "x-api-key",
      env: "HOT_UPDATER_API_KEY",
      value: EXISTING_API_KEY,
    });
    const stored = await storedApiKeys(database);
    expect(stored).toEqual([
      expect.objectContaining({ name: "AWS init", prefix: "AQEBAQ" }),
    ]);
    expect(JSON.stringify(stored)).not.toContain(EXISTING_API_KEY);
  });

  it("creates a canonical app key when the environment has none", async () => {
    const database = createDatabase();

    const apiKey = (await provision(database))!.value;

    expect(apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const stored = await storedApiKeys(database);
    expect(stored).toEqual([
      expect.objectContaining({
        name: "AWS init",
        prefix: apiKey.slice(0, 6),
      }),
    ]);
    expect(JSON.stringify(stored)).not.toContain(apiKey);
  });
});

describe("AWS DynamoDB deployment preparation", () => {
  const credentials = {
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.ensureTable.mockImplementation(async () => {
      mocks.calls.push("ensureTable");
    });
    mocks.migrateDynamoDB.mockImplementation(async () => {
      mocks.calls.push("migrateDynamoDB");
    });
  });

  it("ensures the table, then writes the schema settings the plugin checks", async () => {
    const input = {
      credentials,
      region: "ap-northeast-2",
      tableName: "hot-updater-metadata",
    };
    await prepareDynamoDBDeployment(input);

    expect(mocks.ensureTable).toHaveBeenCalledWith("hot-updater-metadata");
    expect(mocks.migrateDynamoDB).toHaveBeenCalledWith(input, plugins);
    expect(mocks.calls).toEqual(["ensureTable", "migrateDynamoDB"]);
  });
});
