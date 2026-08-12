import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { s3Storage } from "./s3Storage";

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

  it("uploads bytes to the complete object key", async () => {
    uploadDone.mockResolvedValue({
      Bucket: "updates",
      Key: "root/bundles/bundle.zip",
    });
    const storage = s3Storage({
      basePath: "root",
      bucketName: "updates",
      region: "us-east-1",
    });

    await expect(
      storage.put({
        key: "bundles/bundle.zip",
        body: new TextEncoder().encode("bundle"),
        contentType: "application/zip",
      }),
    ).resolves.toEqual({
      storageUri: "s3://updates/root/bundles/bundle.zip",
    });
    expect(uploadOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Bucket: "updates",
          Key: "root/bundles/bundle.zip",
        }),
      }),
    );
  });

  it("returns provider bytes as a streaming Web Response", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
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
      storageUri: "s3://updates/bundles/bundle.zip",
    });

    expect(response?.headers.get("content-type")).toBe("application/zip");
    await expect(response?.text()).resolves.toBe("bundle");
  });

  it("deletes exactly the key referenced by the storage URI", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValue({} as never);
    const storage = s3Storage({ bucketName: "updates", region: "us-east-1" });

    await expect(
      storage.delete({
        storageUri: "s3://updates/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      storageUri: "s3://updates/releases/bundle.zip",
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: "updates", Key: "releases/bundle.zip" },
      }),
    );
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("returns a signed server download URL when configured", async () => {
    const storage = s3Storage({
      bucketName: "updates",
      region: "us-east-1",
      downloadUrlSigningKey: "test-signing-key",
    });

    await expect(
      storage.getDownloadUrl?.({
        storageUri: "s3://updates/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      url: expect.stringMatching(/^\/storage\//),
    });
  });
});
