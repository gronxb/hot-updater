import type { ApiKeyModel } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureTable: vi.fn(),
  migrateInsights: vi.fn(),
}));

vi.mock("../src/dynamoDB", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dynamoDB")>()),
  migrateDynamoDBInsights: mocks.migrateInsights,
}));

vi.mock("./dynamodb", () => ({
  DynamoDBManager: vi.fn(function DynamoDBManager() {
    return { ensureTable: mocks.ensureTable };
  }),
}));

import { prepareDynamoDBApiKey, prepareDynamoDBDeployment } from "./index";

const EXISTING_API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const createApiKeyTable = () =>
  ({
    create: vi.fn(async () => "created" as const),
    findByHash: vi.fn(async () => null),
    list: vi.fn(async () => []),
    revoke: vi.fn(async () => null),
  }) satisfies ApiKeyModel;

describe("AWS DynamoDB API key preparation", () => {
  it("registers the existing app key without persisting the raw value", async () => {
    const apiKeys = createApiKeyTable();

    const apiKey = await prepareDynamoDBApiKey({
      apiKeys,
      existingApiKey: EXISTING_API_KEY,
    });

    expect(apiKey).toBe(EXISTING_API_KEY);
    expect(apiKeys.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "AWS init", prefix: "AQEBAQ" }),
    );
    expect(JSON.stringify(vi.mocked(apiKeys.create).mock.calls)).not.toContain(
      EXISTING_API_KEY,
    );
  });

  it("creates a canonical app key when the environment has none", async () => {
    const apiKeys = createApiKeyTable();

    const apiKey = await prepareDynamoDBApiKey({ apiKeys });

    expect(apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(apiKeys.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "AWS init",
        prefix: apiKey.slice(0, 6),
      }),
    );
    expect(JSON.stringify(vi.mocked(apiKeys.create).mock.calls)).not.toContain(
      apiKey,
    );
  });
});

describe("AWS DynamoDB deployment preparation", () => {
  const credentials = {
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureTable.mockResolvedValue(undefined);
    mocks.migrateInsights.mockResolvedValue(undefined);
  });

  it("ensures the official-domain table before deployment", async () => {
    await prepareDynamoDBDeployment({
      credentials,
      region: "ap-northeast-2",
      tableName: "hot-updater-metadata",
    });

    expect(mocks.ensureTable).toHaveBeenCalledWith("hot-updater-metadata");
    expect(mocks.migrateInsights).toHaveBeenCalledWith({
      credentials,
      region: "ap-northeast-2",
      tableName: "hot-updater-metadata",
    });
  });
});
