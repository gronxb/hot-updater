import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBucket: vi.fn(),
  createOrSelectRole: vi.fn(),
  createOrUpdateDistribution: vi.fn(),
  deploy: vi.fn(),
  edgeDeploymentOf: vi.fn(),
  ensureTable: vi.fn(),
  getOrCreateKeyGroup: vi.fn(),
  getOrCreateKeyPair: vi.fn(),
  listBuckets: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  migrateDynamoDB: vi.fn(),
  printAppSetup: vi.fn(),
  provisionClientCredential: vi.fn(),
  recordDeployedVersion: vi.fn(),
  selectDistribution: vi.fn(),
  updateBucketPolicy: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ stdout: "aws-cli/2.0.0" })),
}));

vi.mock("./awsAuth", () => ({
  resolveAwsAuth: vi.fn(async () => ({
    awsProfile: null,
    configAuthMode: { mode: "account" },
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
    mode: "account",
  })),
}));

vi.mock("./s3", () => ({
  S3Manager: vi.fn(function S3Manager() {
    return {
      createBucket: mocks.createBucket,
      listBuckets: mocks.listBuckets,
      updateBucketPolicy: mocks.updateBucketPolicy,
    };
  }),
}));

vi.mock("./dynamodb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dynamodb")>()),
  DynamoDBManager: vi.fn(function DynamoDBManager() {
    return { ensureTable: mocks.ensureTable };
  }),
}));

vi.mock("../src/dynamoDB", () => ({
  dynamoDB: vi.fn(() => ({ name: "dynamoDB", dispose: vi.fn() })),
  migrateDynamoDB: mocks.migrateDynamoDB,
}));

vi.mock("./iam", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./iam")>()),
  IAMManager: vi.fn(function IAMManager() {
    return {
      createOrSelectRole: mocks.createOrSelectRole,
      recordDeployedVersion: mocks.recordDeployedVersion,
    };
  }),
}));

vi.mock("./ssm", () => ({
  SSMKeyPairManager: vi.fn(function SSMKeyPairManager() {
    return { getOrCreateKeyPair: mocks.getOrCreateKeyPair };
  }),
}));

vi.mock("./cloudfront", () => ({
  CloudFrontManager: vi.fn(function CloudFrontManager() {
    return {
      createOrUpdateDistribution: mocks.createOrUpdateDistribution,
      edgeDeploymentOf: mocks.edgeDeploymentOf,
      getOrCreateKeyGroup: mocks.getOrCreateKeyGroup,
      selectDistribution: mocks.selectDistribution,
    };
  }),
}));

vi.mock("./awsInfrastructureState", () => ({
  assertAwsInfrastructureGeneration: vi.fn(),
  assertAwsLambdaCanInitialize: vi.fn(),
}));

vi.mock("./lambdaEdge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lambdaEdge")>()),
  LambdaEdgeDeployer: vi.fn(function LambdaEdgeDeployer() {
    return { deploy: mocks.deploy };
  }),
}));

vi.mock("@hot-updater/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/server/db")>()),
  provisionClientCredential: mocks.provisionClientCredential,
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    confirmInitInputPersistence: vi.fn(async () => false),
    ensureInstallPackages: vi.fn(),
    makeEnv: vi.fn(),
    printAppSetup: mocks.printAppSetup,
    p: { ...actual.p, log: mocks.log },
    readHotUpdaterInitEnv: vi.fn(async () => ({
      env: SAVED_ENV,
      managedEnv: {},
    })),
    writeHotUpdaterFiles: vi.fn(),
  };
});

import { InitError } from "@hot-updater/cli-tools";

import { runInit } from "./index";
import { getConfigScaffold } from "./templates";

/** What a previous init saved, which a replay reads. */
const SAVED_ENV = {
  HOT_UPDATER_AWS_AUTH_MODE: "account",
  HOT_UPDATER_AWS_LAMBDA_NAME: "hot-updater-edge",
  HOT_UPDATER_DYNAMODB_TABLE_NAME: "hot-updater-metadata",
  HOT_UPDATER_S3_ACCESS_KEY_ID: "AKIATEST",
  HOT_UPDATER_S3_BUCKET_NAME: "bundles",
  HOT_UPDATER_S3_REGION: "ap-northeast-2",
  HOT_UPDATER_S3_SECRET_ACCESS_KEY: "secret",
};

const packageRoot = path.resolve(import.meta.dirname, "..");

/**
 * A project whose hotUpdater.ts is the one init writes with `edit` applied
 * (or none), where the definition's packages resolve, as init's working
 * directory. Its .env.hotupdater holds what init writes.
 */
const project = async (edit?: (text: string) => string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-aws-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "app" }),
  );
  await fs.writeFile(
    path.join(root, ".env.hotupdater"),
    Object.entries(SAVED_ENV)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
  await fs.mkdir(path.join(root, "node_modules", "@hot-updater"), {
    recursive: true,
  });
  await fs.symlink(
    packageRoot,
    path.join(root, "node_modules", "@hot-updater", "aws"),
  );
  await fs.symlink(
    path.join(packageRoot, "node_modules", "@hot-updater", "server"),
    path.join(root, "node_modules", "@hot-updater", "server"),
  );
  if (edit !== undefined) {
    await fs.writeFile(
      path.join(root, "hotUpdater.ts"),
      edit(getConfigScaffold("bare", { mode: "account" }).definition.text),
    );
  }
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return root;
};

/** The definition init writes, with a plugin of the project's own. */
const withNotes = (text: string) =>
  text
    .replace(
      'import { createHotUpdater } from "@hot-updater/server";',
      `import { createHotUpdater } from "@hot-updater/server";
import { definePlugin, defineTable } from "@hot-updater/server/plugins";

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string" }, text: { type: "string" } },
      { key: ["id"] },
    ),
  },
  init: () => ({
    api: {},
    endpoints: [
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async () => Response.json({ from: "the project's plugin" }),
      },
    ],
  }),
});`,
    )
    .replace("  plugins,\n", "  plugins: [...plugins, notes],\n");

let root: string | undefined;
let deployed: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  deployed = undefined;
  mocks.listBuckets.mockResolvedValue([
    { name: "bundles", region: "ap-northeast-2" },
  ]);
  mocks.selectDistribution.mockResolvedValue({
    DomainName: "d111111abcdef8.cloudfront.net",
    Id: "dist-id",
  });
  mocks.edgeDeploymentOf.mockResolvedValue({
    deployed: true,
    versions: ["2"],
  });
  mocks.createOrSelectRole.mockResolvedValue(
    "arn:aws:iam::123456789012:role/hot-updater-edge",
  );
  mocks.getOrCreateKeyPair.mockResolvedValue({ publicKey: "public-key" });
  mocks.getOrCreateKeyGroup.mockResolvedValue({
    keyGroupId: "key-group-id",
    publicKeyId: "public-key-id",
  });
  mocks.deploy.mockImplementation(
    async (_role, lambdaName, _config, staged) => {
      deployed = await fs.readFile(path.join(staged.dir, "index.cjs"), "utf-8");
      await staged.remove();
      return {
        functionArn: `arn:aws:lambda:us-east-1:123456789012:function:${lambdaName}:3`,
        lambdaName,
      };
    },
  );
  mocks.createOrUpdateDistribution.mockResolvedValue({
    distributionDomain: "d111111abcdef8.cloudfront.net",
    distributionId: "dist-id",
  });
  mocks.provisionClientCredential.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root !== undefined) {
    await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("AWS init with the project's server definition", () => {
  it("routes the prebuilt server's plugin endpoints, such as Insights' /events", async () => {
    root = await project();

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(deployed).toContain("HotUpdater.DYNAMODB_TABLE_NAME");
    expect(mocks.createOrUpdateDistribution).toHaveBeenCalledWith(
      expect.objectContaining({
        clientHeaders: ["x-api-key"],
        pluginPaths: ["/events"],
      }),
    );
  });

  it("refuses a definition on another table before it creates anything", async () => {
    root = await project((text) =>
      withNotes(text).replace(
        "tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE_NAME!",
        'tableName: "other-table"',
      ),
    );

    const initialization = runInit({
      build: "bare",
      envFile: ".env.hotupdater",
    });

    await expect(initialization).rejects.toBeInstanceOf(InitError);
    await expect(initialization).rejects.toThrow(
      "hotUpdater.ts: The managed AWS server runs on tableName hot-updater-metadata, which its setup made, but the server definition's dynamoDB has tableName other-table",
    );
    expect(mocks.createBucket).not.toHaveBeenCalled();
    expect(mocks.ensureTable).not.toHaveBeenCalled();
    expect(mocks.createOrSelectRole).not.toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it("refuses a plugin endpoint where CloudFront serves bundles, before it creates anything", async () => {
    root = await project((text) =>
      withNotes(text).replace('path: "/notes/:id"', 'path: "/bundles/:id"'),
    );

    const initialization = runInit({
      build: "bare",
      envFile: ".env.hotupdater",
    });

    await expect(initialization).rejects.toThrow(
      'hotUpdater.ts: Plugin "notes" serves /bundles/:id, but the managed AWS server\'s CloudFront distribution serves bundles from S3 there.',
    );
    expect(mocks.ensureTable).not.toHaveBeenCalled();
  });

  it("deploys the bundled definition and gives its plugins their tables, the role's access, the credential, and CloudFront routes", async () => {
    root = await project(withNotes);

    await runInit({ build: "bare", envFile: ".env.hotupdater" });

    expect(deployed).toContain("the project's plugin");
    const [, migrated] = mocks.migrateDynamoDB.mock.calls[0]!;
    expect((migrated as { id: string }[]).map(({ id }) => id)).toEqual([
      "insights",
      "apiKeys",
      "notes",
    ]);
    expect(mocks.provisionClientCredential).toHaveBeenCalledWith(
      expect.anything(),
      migrated,
      expect.anything(),
    );
    // The role keeps the access of the version the distribution runs, and
    // records the one it deployed once the distribution runs it.
    expect(mocks.edgeDeploymentOf).toHaveBeenCalledWith(
      "dist-id",
      "hot-updater-edge",
    );
    expect(mocks.createOrSelectRole).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: migrated,
        edge: { deployed: true, versions: ["2"] },
      }),
    );
    expect(mocks.recordDeployedVersion).toHaveBeenCalledWith({
      dynamodbTableName: "hot-updater-metadata",
      functionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:hot-updater-edge:3",
      lambdaName: "hot-updater-edge",
      plugins: migrated,
    });
    expect(
      mocks.recordDeployedVersion.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      mocks.createOrUpdateDistribution.mock.invocationCallOrder[0]!,
    );
    expect(mocks.createOrUpdateDistribution).toHaveBeenCalledWith(
      expect.objectContaining({
        clientHeaders: ["x-api-key"],
        pluginPaths: ["/events", "/notes/*"],
      }),
    );
    expect(mocks.printAppSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://d111111abcdef8.cloudfront.net",
        clientPlugins: [
          expect.objectContaining({
            module: "@hot-updater/react-native/plugins/insights",
          }),
        ],
      }),
    );
  });
});
