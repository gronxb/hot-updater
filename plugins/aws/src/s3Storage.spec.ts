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

  it("deletes exact relative object keys in S3 batches", async () => {
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
    const keys = Array.from({ length: 1001 }, (_, index) => `assets/${index}`);

    await storage.profiles.node.deleteObjects?.(keys);

    expect(deletedBatches).toHaveLength(2);
    expect(deletedBatches[0]).toHaveLength(1000);
    expect(deletedBatches[1]).toEqual(["assets/1000"]);
  });

  it("reports partial S3 batch deletion failures", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Errors: [{ Code: "AccessDenied", Key: "assets/orphan.png" }],
    } as never);
    const storage = s3Storage({ bucketName: "bucket" })();

    await expect(
      storage.profiles.node.deleteObjects?.(["assets/orphan.png"]),
    ).rejects.toThrow("Failed to delete 1 S3 object");
  });

  it("preserves special characters in exact deletion keys", async () => {
    const deletedKeys: string[] = [];
    vi.spyOn(S3Client.prototype, "send").mockImplementation(
      async (command: unknown) => {
        if (!(command instanceof DeleteObjectsCommand)) {
          throw new Error("Unexpected command");
        }
        deletedKeys.push(
          ...(command.input.Delete?.Objects?.map(({ Key }) => Key ?? "") ?? []),
        );
        return {};
      },
    );
    const storage = s3Storage({
      basePath: "/releases/",
      bucketName: "bucket",
    })();

    await storage.profiles.node.deleteObjects?.([
      "legacy/files/logo#dark?.png",
      "legacy/files/한글 100%.png",
    ]);

    expect(deletedKeys).toEqual([
      "releases/legacy/files/logo#dark?.png",
      "releases/legacy/files/한글 100%.png",
    ]);
  });

  it("decodes percent-encoded object keys before signing", async () => {
    const storage = s3Storage({
      bucketName: "bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
      region: "us-east-1",
    })();

    const { fileUrl } = await storage.profiles.runtime.getDownloadUrl(
      "s3://bucket/releases/logo%402x.png",
    );

    expect(new URL(fileUrl).pathname).toBe("/releases/logo%402x.png");
  });
});
