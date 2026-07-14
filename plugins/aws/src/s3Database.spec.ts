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
const archivedKeys = new Set<string>();
let replacementBeforeConditionalPut:
  | { readonly key: string; readonly value: string }
  | undefined;
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
const objectEtag = (value: string): string =>
  `"${Buffer.from(value).toString("base64")}"`;
const readActiveRevision = (pointerKey: string): string => {
  const value: unknown = JSON.parse(objects.get(pointerKey) ?? "null");
  if (
    typeof value !== "object" ||
    value === null ||
    !("active_revision" in value) ||
    typeof value.active_revision !== "string"
  ) {
    throw new Error("Active blob database revision was not written.");
  }
  return value.active_revision;
};

s3Mock.on(ListObjectsV2Command).callsFake(async (input) => ({
  Contents: [...objects.keys()]
    .filter((key) => key.startsWith(input.Prefix ?? ""))
    .map((Key) => ({ Key })),
}));
s3Mock.on(GetObjectCommand).callsFake(async (input) => {
  if (input.Key && archivedKeys.has(input.Key)) {
    const error = new Error("InvalidObjectState");
    error.name = "InvalidObjectState";
    Reflect.set(error, "StorageClass", "GLACIER");
    throw error;
  }
  const value = input.Key ? objects.get(input.Key) : undefined;
  if (value === undefined) {
    const error = new Error("NoSuchKey");
    error.name = "NoSuchKey";
    throw error;
  }
  return {
    Body: Readable.from([Buffer.from(value)]),
    ETag: objectEtag(value),
  };
});
s3Mock.on(PutObjectCommand).callsFake(async (input) => {
  if (!input.Key) return {};
  const replacement = replacementBeforeConditionalPut;
  if (
    input.IfMatch !== undefined &&
    replacement !== undefined &&
    replacement.key === input.Key
  ) {
    objects.set(input.Key, replacement.value);
    replacementBeforeConditionalPut = undefined;
  }
  const current = objects.get(input.Key);
  const conditionFailed =
    (input.IfNoneMatch === "*" && current !== undefined) ||
    (input.IfMatch !== undefined &&
      (current === undefined || input.IfMatch !== objectEtag(current)));
  if (conditionFailed) {
    const error = new Error("PreconditionFailed");
    error.name = "PreconditionFailed";
    throw error;
  }
  objects.set(input.Key, String(input.Body ?? ""));
  return {};
});
cloudFrontMock.on(CreateInvalidationCommand).resolves({
  Invalidation: invalidation("invalidation-1", "Completed"),
});

beforeEach(() => {
  objects.clear();
  archivedKeys.clear();
  replacementBeforeConditionalPut = undefined;
});

setupDatabaseAdapterTestSuite({
  name: "AWS S3 database adapter v2",
  createAdapter: () => s3Database({ bucketName }),
  migrate: () => undefined,
  reset: () => {
    objects.clear();
  },
  dispose: () => undefined,
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
  it("writes an immutable revision below the configured base path", async () => {
    const adapter = s3Database({ bucketName, basePath: "/metadata/" });

    await adapter.create({
      model: "channels",
      data: { id: "production", name: "production" },
    });

    const pointerKey = `metadata/${BLOB_DATABASE_SNAPSHOT_KEY}`;
    const revision = readActiveRevision(pointerKey);
    expect(
      JSON.parse(
        objects.get(
          `metadata/_hot-updater/database/revisions/${revision}/snapshot.json`,
        ) ?? "null",
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
      Key: pointerKey,
      ContentType: "application/json",
      CacheControl: "no-cache",
      IfNoneMatch: "*",
    });
    const revisionWrites = s3Mock
      .commandCalls(PutObjectCommand)
      .filter(({ args }) =>
        args[0].input.Key?.includes("/_hot-updater/database/revisions/"),
      );
    expect(revisionWrites).not.toHaveLength(0);
    expect(
      revisionWrites.every(
        ({ args }) =>
          args[0].input.IfNoneMatch === "*" &&
          args[0].input.CacheControl === "max-age=31536000",
      ),
    ).toBe(true);
  });

  it("uses the loaded snapshot ETag for conditional replacement", async () => {
    const adapter = s3Database({ bucketName });
    await adapter.create({
      model: "channels",
      data: { id: "production", name: "production" },
    });
    const previous = objects.get(BLOB_DATABASE_SNAPSHOT_KEY);
    if (previous === undefined) throw new Error("Snapshot was not written.");

    await adapter.create({ model: "bundles", data: bundleRow("1") });

    const snapshotWrites = s3Mock
      .commandCalls(PutObjectCommand)
      .filter(({ args }) => args[0].input.Key === BLOB_DATABASE_SNAPSHOT_KEY);
    expect(snapshotWrites.at(-1)?.args[0].input).toMatchObject({
      IfMatch: objectEtag(previous),
    });
  });

  it("preserves a concurrent snapshot when the conditional write loses", async () => {
    const adapter = s3Database({ bucketName });
    await adapter.create({
      model: "channels",
      data: { id: "production", name: "production" },
    });
    const external = JSON.stringify({
      version: 2,
      bundles: [],
      bundle_patches: [],
      channels: [{ id: "external", name: "external" }],
    });
    replacementBeforeConditionalPut = {
      key: BLOB_DATABASE_SNAPSHOT_KEY,
      value: external,
    };

    await expect(
      adapter.create({ model: "bundles", data: bundleRow("1") }),
    ).rejects.toThrow("changed while a mutation was in progress");
    expect(objects.get(BLOB_DATABASE_SNAPSHOT_KEY)).toBe(external);
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

  it("encodes CloudFront invalidation path segments", async () => {
    const adapter = s3Database({
      bucketName,
      cloudfrontDistributionId: "distribution-1",
    });
    await adapter.create({
      model: "channels",
      data: { id: "release-channel", name: "release candidate" },
    });

    await adapter.create({
      model: "bundles",
      data: {
        ...bundleRow("1"),
        channel: "release candidate",
        channel_id: "release-channel",
      },
    });

    expect(
      cloudFrontMock.commandCalls(CreateInvalidationCommand).at(-1)?.args[0]
        .input.InvalidationBatch?.Paths?.Items,
    ).toContain(
      "/api/check-update/app-version/ios/1.0.0/release%20candidate/*",
    );
  });

  it("fails closed when an active revision manifest is archived", async () => {
    const adapter = s3Database({ bucketName });
    await adapter.create({
      model: "channels",
      data: { id: "production", name: "production" },
    });
    await adapter.create({ model: "bundles", data: bundleRow("1") });
    const revision = readActiveRevision(BLOB_DATABASE_SNAPSHOT_KEY);
    archivedKeys.add(
      `_hot-updater/database/revisions/${revision}/manifests/production/ios/1.0.0/update.json`,
    );

    await expect(
      adapter.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: fixtureId("0"),
        channel: "production",
        platform: "ios",
      }),
    ).rejects.toThrow("is archived");
  });

  it("rejects an empty active database root", async () => {
    objects.set(BLOB_DATABASE_SNAPSHOT_KEY, "");

    await expect(
      s3Database({ bucketName }).count({ model: "bundles" }),
    ).rejects.toThrow("is empty");
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
  channel: "production",
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
