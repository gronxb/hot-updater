import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import {
  setupDatabaseAdapterTestSuite,
  setupDatabaseClientTestSuite,
} from "@hot-updater/test-utils";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { s3Database } from "./s3Database";

const bucketName = "database-bucket";
const objects = new Map<string, string>();
const s3Mock = mockClient(S3Client);
const cloudFrontMock = mockClient(CloudFrontClient);
const invalidation = (id: string, status: string) => ({
  Id: id,
  Status: status,
  CreateTime: new Date(0),
  InvalidationBatch: {
    CallerReference: "fixture",
    Paths: { Quantity: 0, Items: [] },
  },
});

s3Mock.on(ListObjectsV2Command).callsFake(async (input) => ({
  Contents: [...objects.keys()]
    .filter((key) => key.startsWith(input.Prefix ?? ""))
    .map((Key) => ({ Key })),
}));
s3Mock.on(GetObjectCommand).callsFake(async (input) => {
  const value = input.Key ? objects.get(input.Key) : undefined;
  if (value === undefined) {
    const error = new Error("NoSuchKey");
    error.name = "NoSuchKey";
    throw error;
  }
  return { Body: Readable.from([Buffer.from(value)]) };
});
s3Mock.on(PutObjectCommand).callsFake(async (input) => {
  if (input.Key) objects.set(input.Key, String(input.Body ?? ""));
  return {};
});
cloudFrontMock.on(CreateInvalidationCommand).resolves({
  Invalidation: invalidation("invalidation-1", "Completed"),
});

beforeEach(() => {
  objects.clear();
});

setupDatabaseAdapterTestSuite({
  name: "AWS S3 database adapter v2",
  createAdapter: () => s3Database({ bucketName }),
  migrate: () => undefined,
  reset: () => {
    objects.clear();
  },
  dispose: () => undefined,
  capabilities: { transaction: true },
});

setupDatabaseClientTestSuite({
  name: "AWS S3 database aggregate client",
  createAdapter: () => s3Database({ bucketName }),
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: () => {
    objects.clear();
  },
  dispose: () => undefined,
});

describe("s3Database storage behavior", () => {
  it("writes the v2 snapshot below the configured base path", async () => {
    const adapter = s3Database({ bucketName, basePath: "/metadata/" });

    await adapter.create({
      model: "channels",
      data: { id: "production", name: "production" },
    });

    expect(
      JSON.parse(
        objects.get(`metadata/${BLOB_DATABASE_SNAPSHOT_KEY}`) ?? "null",
      ),
    ).toEqual({
      version: 2,
      bundles: [],
      bundle_patches: [],
      channels: [{ id: "production", name: "production" }],
    });
    const call = s3Mock.commandCalls(PutObjectCommand).at(-1);
    expect(call?.args[0].input).toMatchObject({
      Bucket: bucketName,
      Key: `metadata/${BLOB_DATABASE_SNAPSHOT_KEY}`,
      ContentType: "application/json",
    });
  });

  it("invalidates the existing CloudFront update route after a bundle write", async () => {
    const adapter = s3Database({
      bucketName,
      cloudfrontDistributionId: "distribution-1",
    });
    await adapter.create({
      model: "channels",
      data: { id: "production", name: "production" },
    });

    await adapter.create({ model: "bundles", data: bundleRow("1") });

    expect(
      cloudFrontMock.commandCalls(CreateInvalidationCommand).at(-1)?.args[0]
        .input,
    ).toMatchObject({
      DistributionId: "distribution-1",
      InvalidationBatch: {
        Paths: {
          Items: [
            "/api/check-update/app-version/ios/1.0.0/production/*",
            "/api/check-update/app-version/ios/1.0/production/*",
            "/api/check-update/app-version/ios/1/production/*",
          ],
          Quantity: 3,
        },
      },
    });
  });

  it("does not create invalidations without a distribution", async () => {
    const previousInvalidationCount = cloudFrontMock.commandCalls(
      CreateInvalidationCommand,
    ).length;
    const adapter = s3Database({
      bucketName,
    });
    await adapter.create({
      model: "channels",
      data: { id: "production", name: "production" },
    });

    await adapter.create({ model: "bundles", data: bundleRow("1") });

    expect(cloudFrontMock.commandCalls(CreateInvalidationCommand)).toHaveLength(
      previousInvalidationCount,
    );
  });
});

const fixtureId = (suffix: string): string =>
  `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`;

const bundleRow = (suffix: string) => ({
  id: fixtureId(suffix),
  platform: "ios" as const,
  should_force_update: false,
  enabled: true,
  file_hash: `hash-${suffix}`,
  git_commit_hash: null,
  message: `bundle-${suffix}`,
  channel_id: "production",
  storage_uri: `s3://${bucketName}/bundles/${suffix}.zip`,
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});
