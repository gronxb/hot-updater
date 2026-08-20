import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { s3Storage } from "./s3Storage";

const stream = (value: string) => new Blob([value]).stream();

const { uploadDone, uploadOptions } = vi.hoisted(() => ({
  uploadDone: vi.fn(),
  uploadOptions: vi.fn(),
}));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(options: unknown) {
      uploadOptions(options);
    }

    async done() {
      return uploadDone();
    }
  },
}));

describe("s3Storage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    uploadDone.mockReset();
    uploadOptions.mockReset();
  });

  it("streams bytes with their length to the complete encoded object URI", async () => {
    uploadDone.mockResolvedValue({
      Bucket: "updates",
      Key: "root/bundles/한글 #%.zip",
    });
    const storage = s3Storage({
      basePath: "root",
      bucketName: "updates",
      region: "us-east-1",
    });

    await expect(
      storage.put({
        key: "bundles/한글 #%.zip",
        body: stream("bundle"),
        contentLength: 6,
        contentType: "application/zip",
      }),
    ).resolves.toEqual({
      storageUri: "s3://updates/root/bundles/%ED%95%9C%EA%B8%80%20%23%25.zip",
    });
    expect(uploadOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Bucket: "updates",
          ContentLength: 6,
          Key: "root/bundles/한글 #%.zip",
        }),
      }),
    );
  });

  it("returns provider bytes as a streaming Web Response", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command).toMatchObject({
        input: { Bucket: "updates", Key: "bundles/한글@2x #%.zip" },
      });
      return {
        Body: {
          transformToWebStream: () => new Response("bundle").body!,
        },
        ContentLength: 6,
        ContentType: "application/zip",
      } as never;
    });
    const storage = s3Storage({ bucketName: "updates", region: "us-east-1" });

    const { response } = await storage.get({
      storageUri: "s3://updates/bundles/%ED%95%9C%EA%B8%80%402x%20%23%25.zip",
    });

    expect(response?.headers.get("content-type")).toBe("application/zip");
    expect(response?.headers.get("content-length")).toBe("6");
    await expect(response?.text()).resolves.toBe("bundle");
  });

  it("deletes exactly one decoded key and is idempotent", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValue({} as never);
    const storage = s3Storage({ bucketName: "updates", region: "us-east-1" });

    const input = {
      storageUri: "s3://updates/releases/%ED%95%9C%EA%B8%80%20%23%25.zip",
    };
    await expect(storage.delete(input)).resolves.toEqual({ deleted: true });
    await expect(storage.delete(input)).resolves.toEqual({ deleted: true });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: "updates", Key: "releases/한글 #%.zip" },
      }),
    );
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("returns missing results without hiding other S3 errors", async () => {
    const missing = Object.assign(new Error("missing"), { name: "NoSuchKey" });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(missing);
    const storage = s3Storage({ bucketName: "updates", region: "us-east-1" });

    await expect(
      storage.get({ storageUri: "s3://updates/missing.zip" }),
    ).resolves.toEqual({ response: null });
    await expect(
      storage.exists({ storageUri: "s3://updates/missing.zip" }),
    ).resolves.toEqual({ exists: false });
  });

  it("rejects storage URIs owned by another bucket", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    const storage = s3Storage({ bucketName: "updates", region: "us-east-1" });

    await expect(
      storage.get({ storageUri: "s3://other/bundle.zip" }),
    ).rejects.toThrow('Bucket name mismatch: expected "updates"');
    await expect(
      storage.exists({ storageUri: "s3://other/bundle.zip" }),
    ).rejects.toThrow('Bucket name mismatch: expected "updates"');
    await expect(
      storage.delete({ storageUri: "s3://other/bundle.zip" }),
    ).rejects.toThrow('Bucket name mismatch: expected "updates"');
    expect(send).not.toHaveBeenCalled();
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
          } as never;
        }
        return {
          Contents: [
            {
              Key: "releases/bundles/bundle-id/bundle.zip",
              Size: 34,
            },
          ],
        } as never;
      });
    const storage = s3Storage({
      basePath: "/releases/",
      bucketName: "updates",
    });

    await expect(storage.listObjects?.()).resolves.toEqual([
      {
        key: "assets/sha256/aa/asset.png",
        lastModifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        size: 12,
        storageUri: "s3://updates/releases/assets/sha256/aa/asset.png",
      },
      {
        key: "bundles/bundle-id/bundle.zip",
        lastModifiedAt: undefined,
        size: 34,
        storageUri: "s3://updates/releases/bundles/bundle-id/bundle.zip",
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
        return {} as never;
      },
    );
    const storage = s3Storage({ bucketName: "updates" });
    const keys = Array.from({ length: 1001 }, (_, index) => `assets/${index}`);

    await storage.deleteObjects?.(keys);

    expect(deletedBatches).toHaveLength(2);
    expect(deletedBatches[0]).toHaveLength(1000);
    expect(deletedBatches[1]).toEqual(["assets/1000"]);
  });

  it("reports partial S3 batch deletion failures", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Errors: [{ Code: "AccessDenied", Key: "assets/orphan.png" }],
    } as never);
    const storage = s3Storage({ bucketName: "updates" });

    await expect(
      storage.deleteObjects?.(["assets/orphan.png"]),
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
        return {} as never;
      },
    );
    const storage = s3Storage({
      basePath: "/releases/",
      bucketName: "updates",
    });

    await storage.deleteObjects?.([
      "legacy/files/logo#dark?.png",
      "legacy/files/한글 100%.png",
    ]);

    expect(deletedKeys).toEqual([
      "releases/legacy/files/logo#dark?.png",
      "releases/legacy/files/한글 100%.png",
    ]);
  });

  it("returns a signed server download URL when configured", async () => {
    const storage = s3Storage({
      bucketName: "updates",
      region: "us-east-1",
      downloadUrlSigningKey: "test-signing-key",
    });

    await expect(
      storage.getDownloadUrl({
        storageUri: "s3://updates/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      url: expect.stringMatching(/^\/storage\//),
    });
  });
});
