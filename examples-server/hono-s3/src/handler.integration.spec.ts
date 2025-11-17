import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Bundle } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import {
  setupBundleMethodsTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import {
  cleanupServer,
  createGetUpdateInfo,
  killPort,
  spawnServerProcess,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe } from "vitest";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const LOCALSTACK_ENDPOINT = "http://localhost:4566";
const REGION = "us-east-1";
const ACCESS_KEY_ID = "test";
const SECRET_ACCESS_KEY = "test";
const METADATA_BUCKET = "hot-updater-metadata";
const BUNDLES_BUCKET = "hot-updater-bundles";

async function ensureBucketExists(bucketName: string) {
  const client = new S3Client({
    region: REGION,
    endpoint: LOCALSTACK_ENDPOINT,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucketName }));
  }
}

describe("Hot Updater Handler Integration Tests (Hono + S3)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let hotUpdater: HotUpdaterAPI;
  const port = 13595;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    baseUrl = `http://localhost:${port}`;

    // Ensure Localstack (S3) is running
    await execa("docker", ["compose", "up", "-d"], {
      cwd: projectRoot,
    });

    // Wait for Localstack to be ready
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Ensure required buckets exist
    await ensureBucketExists(METADATA_BUCKET);
    await ensureBucketExists(BUNDLES_BUCKET);

    process.env.AWS_REGION = REGION;
    process.env.AWS_ACCESS_KEY_ID = ACCESS_KEY_ID;
    process.env.AWS_SECRET_ACCESS_KEY = SECRET_ACCESS_KEY;
    process.env.AWS_S3_ENDPOINT = LOCALSTACK_ENDPOINT;
    process.env.AWS_S3_METADATA_BUCKET = METADATA_BUCKET;
    process.env.AWS_S3_BUNDLES_BUCKET = BUNDLES_BUCKET;

    // Start server
    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath: "",
      projectRoot,
      env: {
        AWS_REGION: REGION,
        AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        AWS_S3_ENDPOINT: LOCALSTACK_ENDPOINT,
        AWS_S3_METADATA_BUCKET: METADATA_BUCKET,
        AWS_S3_BUNDLES_BUCKET: BUNDLES_BUCKET,
      },
    });

    await waitForServer(baseUrl, 60); // 60 attempts * 200ms = 12 seconds

    const db = await import("./db.js");
    hotUpdater = db.hotUpdater;
  }, 120000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, "");

    // Stop and remove Docker containers
    await execa("docker", ["compose", "down", "-v"], {
      cwd: projectRoot,
    });
  }, 60000);

  const getUpdateInfo: ReturnType<typeof createGetUpdateInfo> = (
    bundles,
    options,
  ) => {
    return createGetUpdateInfo({
      baseUrl: `${baseUrl}/hot-updater`,
    })(bundles, options);
  };

  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
  });

  setupBundleMethodsTestSuite({
    getBundleById: (id: string) => hotUpdater.getBundleById(id),
    getChannels: () => hotUpdater.getChannels(),
    insertBundle: (bundle: Bundle) => hotUpdater.insertBundle(bundle),
    getBundles: (options) => hotUpdater.getBundles(options),
    updateBundleById: (bundleId: string, newBundle: Partial<Bundle>) =>
      hotUpdater.updateBundleById(bundleId, newBundle),
    deleteBundleById: (bundleId: string) =>
      hotUpdater.deleteBundleById(bundleId),
  });
});
