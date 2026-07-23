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
  databaseAnalyticsSupport,
} from "@hot-updater/plugin-core";
import {
  setupDatabasePluginTestSuite,
  setupDatabaseClientTestSuite,
} from "@hot-updater/test-utils";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
beforeEach(() => {
  objects.clear();
  archivedKeys.clear();
  replacementBeforeConditionalPut = undefined;
  cloudFrontMock.reset();
  cloudFrontMock.on(CreateInvalidationCommand).resolves({
    Invalidation: invalidation("invalidation-1", "Completed"),
  });
});

setupDatabasePluginTestSuite({
  name: "AWS S3 fixed-model database plugin",
  createPlugin: () => s3Database({ bucketName }),
  migrate: () => undefined,
  reset: () => {
    objects.clear();
  },
  dispose: () => undefined,
});

setupDatabaseClientTestSuite({
  name: "AWS S3 database aggregate client",
  createPlugin: () => s3Database({ bucketName }),
  createClient: createDatabaseClient,
  migrate: () => undefined,
  reset: () => {
    objects.clear();
  },
  dispose: () => undefined,
});

describe("s3Database storage behavior", () => {
  it("does not opt in to concurrent bundle event writes", () => {
    // Given / When
    const plugin = s3Database({ bucketName });

    // Then
    expect(plugin[databaseAnalyticsSupport]).toBeUndefined();
  });

  it("writes an immutable revision below the configured base path", async () => {
    const plugin = s3Database({ bucketName, basePath: "/metadata/" });

    await plugin.create({ model: "bundles", data: bundleRow("1") });

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
      bundles: [bundleRow("1")],
      bundle_patches: [],
      bundle_events: [],
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
    const plugin = s3Database({ bucketName });
    await plugin.create({ model: "bundles", data: bundleRow("1") });
    const previous = objects.get(BLOB_DATABASE_SNAPSHOT_KEY);
    if (previous === undefined) throw new Error("Snapshot was not written.");

    await plugin.create({ model: "bundles", data: bundleRow("2") });

    const snapshotWrites = s3Mock
      .commandCalls(PutObjectCommand)
      .filter(({ args }) => args[0].input.Key === BLOB_DATABASE_SNAPSHOT_KEY);
    expect(snapshotWrites.at(-1)?.args[0].input).toMatchObject({
      IfMatch: objectEtag(previous),
    });
  });

  it("merges a concurrent snapshot when the conditional write loses", async () => {
    const plugin = s3Database({ bucketName });
    await plugin.create({ model: "bundles", data: bundleRow("1") });
    const externalRevision = "00000000-0000-7000-8000-000000000099";
    const external = JSON.stringify({
      version: 2,
      active_revision: externalRevision,
    });
    objects.set(
      `_hot-updater/database/revisions/${externalRevision}/snapshot.json`,
      JSON.stringify({
        version: 2,
        bundles: [bundleRow("1"), bundleRow("99")],
        bundle_patches: [],
        bundle_events: [],
      }),
    );
    replacementBeforeConditionalPut = {
      key: BLOB_DATABASE_SNAPSHOT_KEY,
      value: external,
    };

    await plugin.create({ model: "bundles", data: bundleRow("2") });

    await expect(plugin.count({ model: "bundles" })).resolves.toBe(3);
    await expect(
      plugin.findOne({
        model: "bundles",
        where: [{ field: "id", value: bundleRow("99").id }],
      }),
    ).resolves.toMatchObject(bundleRow("99"));
  });

  it("invalidates the existing CloudFront update route after a bundle write", async () => {
    const plugin = s3Database({
      bucketName,
      cloudfrontDistributionId: "distribution-1",
    });
    await plugin.create({ model: "bundles", data: bundleRow("1") });

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

  it("retries a transient CloudFront invalidation submission failure", async () => {
    cloudFrontMock
      .on(CreateInvalidationCommand)
      .rejectsOnce(new Error("Throttling"))
      .resolves({
        Invalidation: invalidation("invalidation-1", "Completed"),
      });
    const plugin = s3Database({
      bucketName,
      cloudfrontDistributionId: "distribution-1",
    });

    await expect(
      plugin.create({ model: "bundles", data: bundleRow("1") }),
    ).resolves.toEqual(bundleRow("1"));

    expect(cloudFrontMock.commandCalls(CreateInvalidationCommand)).toHaveLength(
      2,
    );
  });

  it("reports exhausted CloudFront invalidation submissions without rejecting the committed mutation", async () => {
    cloudFrontMock
      .on(CreateInvalidationCommand)
      .rejects(new Error("ServiceUnavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plugin = s3Database({
      bucketName,
      cloudfrontDistributionId: "distribution-1",
    });

    await expect(
      plugin.create({ model: "bundles", data: bundleRow("1") }),
    ).resolves.toEqual(bundleRow("1"));

    expect(cloudFrontMock.commandCalls(CreateInvalidationCommand)).toHaveLength(
      3,
    );
    expect(warn).toHaveBeenCalledOnce();
    await expect(plugin.count({ model: "bundles" })).resolves.toBe(1);
    warn.mockRestore();
  });

  it("encodes CloudFront invalidation path segments", async () => {
    const plugin = s3Database({
      bucketName,
      cloudfrontDistributionId: "distribution-1",
    });
    await plugin.create({
      model: "bundles",
      data: {
        ...bundleRow("1"),
        channel: "release candidate",
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
    const plugin = s3Database({ bucketName });
    await plugin.create({ model: "bundles", data: bundleRow("1") });
    const revision = readActiveRevision(BLOB_DATABASE_SNAPSHOT_KEY);
    archivedKeys.add(
      `_hot-updater/database/revisions/${revision}/manifests/production/ios/1.0.0/update.json`,
    );

    await expect(
      plugin.getUpdateInfo?.({
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
    const plugin = s3Database({
      bucketName,
    });
    await plugin.create({ model: "bundles", data: bundleRow("1") });

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
