import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { s3Storage } from "./s3Storage";

describe("s3Storage object management", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists every object relative to basePath across S3 pages", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async (command: unknown) => {
        if (!(command instanceof ListObjectsV2Command)) {
          throw new Error("Unexpected command");
        }

        if (!command.input.ContinuationToken) {
          return {
            Contents: [
              {
                Key: "releases/assets/sha256/aa/asset.png",
                LastModified: new Date("2026-08-01T00:00:00.000Z"),
                Size: 12,
              },
            ],
            NextContinuationToken: "page-2",
          };
        }

        return {
          Contents: [
            {
              Key: "releases/bundles/bundle-id/bundle.zip",
              Size: 34,
            },
          ],
        };
      });
    const storage = s3Storage({
      basePath: "/releases/",
      bucketName: "bucket",
    })();

    await expect(storage.profiles.node.listObjects?.()).resolves.toEqual([
      {
        key: "assets/sha256/aa/asset.png",
        lastModifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        size: 12,
        storageUri: "s3://bucket/releases/assets/sha256/aa/asset.png",
      },
      {
        key: "bundles/bundle-id/bundle.zip",
        lastModifiedAt: undefined,
        size: 34,
        storageUri: "s3://bucket/releases/bundles/bundle-id/bundle.zip",
      },
    ]);
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: expect.objectContaining({ Prefix: "releases/" }),
      }),
    );
  });

  it("deletes exact object URIs in S3 batches", async () => {
    const deletedBatches: string[][] = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation(
      async (command: unknown) => {
        if (!(command instanceof DeleteObjectsCommand)) {
          throw new Error("Unexpected command");
        }
        deletedBatches.push(
          command.input.Delete?.Objects?.map((object) => object.Key ?? "") ??
            [],
        );
        return {};
      },
    );
    const storage = s3Storage({ bucketName: "bucket" })();
    const storageUris = Array.from(
      { length: 1001 },
      (_, index) => `s3://bucket/assets/${index}`,
    );

    await storage.profiles.node.deleteObjects?.(storageUris);

    expect(deletedBatches).toHaveLength(2);
    expect(deletedBatches[0]).toHaveLength(1000);
    expect(deletedBatches[1]).toEqual(["assets/1000"]);
  });

  it("rejects exact deletion outside the configured bucket", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    const storage = s3Storage({ bucketName: "bucket" })();

    await expect(
      storage.profiles.node.deleteObjects?.([
        "s3://another-bucket/assets/orphan.png",
      ]),
    ).rejects.toThrow("Bucket name mismatch");
    expect(send).not.toHaveBeenCalled();
  });

  it("reports partial S3 batch deletion failures", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Errors: [{ Code: "AccessDenied", Key: "assets/orphan.png" }],
    } as never);
    const storage = s3Storage({ bucketName: "bucket" })();

    await expect(
      storage.profiles.node.deleteObjects?.(["s3://bucket/assets/orphan.png"]),
    ).rejects.toThrow("Failed to delete 1 S3 object");
  });
});
