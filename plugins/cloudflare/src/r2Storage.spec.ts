import { Buffer } from "buffer";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { r2Storage } from "./r2Storage";

let fakeStore: Record<string, Buffer> = {};
let deletedKeys: string[] = [];
let uploadedParams:
  | {
      Body: ReadableStream<Uint8Array>;
      Bucket: string;
      CacheControl?: string;
      ContentLength?: number;
      ContentType?: string;
      Key: string;
    }
  | undefined;

const createBody = (value: string) => new Response(value).body!;

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    params: {
      Body: ReadableStream<Uint8Array>;
      Bucket: string;
      CacheControl?: string;
      ContentLength?: number;
      ContentType?: string;
      Key: string;
    };

    constructor({
      params,
    }: {
      params: {
        Body: ReadableStream<Uint8Array>;
        Bucket: string;
        CacheControl?: string;
        ContentLength?: number;
        ContentType?: string;
        Key: string;
      };
    }) {
      this.params = params;
      uploadedParams = params;
    }

    async done() {
      fakeStore[this.params.Key] = Buffer.from(
        await new Response(this.params.Body).arrayBuffer(),
      );
      return {
        Bucket: this.params.Bucket,
        Key: this.params.Key,
      };
    }
  },
}));

describe("r2Storage", () => {
  beforeEach(() => {
    fakeStore = {};
    deletedKeys = [];
    uploadedParams = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockS3Client = () => {
    return vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async (command: any) => {
        if (command instanceof HeadObjectCommand) {
          const key = command.input.Key!;
          if (fakeStore[key]) {
            return {};
          }

          const error = new Error("Not found");
          error.name = "NotFound";
          throw error;
        }

        if (command instanceof GetObjectCommand) {
          const key = command.input.Key!;
          const object = fakeStore[key];
          if (!object) {
            const error = new Error("No such key");
            error.name = "NoSuchKey";
            throw error;
          }

          return {
            Body: {
              transformToByteArray: async () => new Uint8Array(object),
              transformToString: async () => object.toString("utf8"),
              transformToWebStream: () => new Response(object).body!,
            },
          };
        }

        if (command instanceof DeleteObjectCommand) {
          deletedKeys.push(command.input.Key!);
          delete fakeStore[command.input.Key!];
          return {};
        }

        throw new Error("Unsupported command");
      });
  };

  it("uploads R2 objects through the S3 API when credentials are provided", async () => {
    mockS3Client();

    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    });

    await expect(
      storage.put?.({
        key: "releases/bundle-1/hot-updater-r2-upload.txt",
        body: createBody("hello r2"),
        contentLength: 8,
        contentType: "text/plain",
      }),
    ).resolves.toEqual({
      storageUri:
        "r2://test-bucket/releases/bundle-1/hot-updater-r2-upload.txt",
    });
    expect(
      fakeStore["releases/bundle-1/hot-updater-r2-upload.txt"].toString(),
    ).toBe("hello r2");
    expect(uploadedParams).toMatchObject({
      ContentLength: 8,
      ContentType: "text/plain",
    });
  });

  it("round-trips spaces, Unicode, fragments, and percent signs in S3 keys", async () => {
    mockS3Client();
    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    });
    const key = "릴리스 folder/logo@2x #100%/bundle.zip";

    const uploaded = await storage.put?.({
      key,
      body: createBody("bundle"),
      contentLength: 6,
      contentType: "application/zip",
    });
    expect(uploaded?.storageUri).toContain("logo%402x");
    expect(uploaded?.storageUri).not.toContain("#100%");
    await expect(
      storage.get?.({ storageUri: uploaded!.storageUri }),
    ).resolves.toEqual({ response: expect.any(Response) });
    await storage.delete?.({ storageUri: uploaded!.storageUri });
    await storage.delete?.({ storageUri: uploaded!.storageUri });

    expect(deletedKeys).toEqual([key, key]);
  });

  it("downloads R2 objects through the S3 API when credentials are provided", async () => {
    mockS3Client();
    fakeStore["releases/bundle-1/manifest.json"] = Buffer.from(
      JSON.stringify({
        assets: {},
        bundleId: "bundle-1",
      }),
    );

    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    });

    const { response } = (await storage.get?.({
      storageUri: "r2://test-bucket/releases/bundle-1/manifest.json",
    })) ?? { response: null };

    expect(JSON.parse((await response?.text()) ?? "")).toEqual({
      assets: {},
      bundleId: "bundle-1",
    });
  });

  it("checks R2 object existence through the S3 API", async () => {
    mockS3Client();
    fakeStore["releases/logo.png"] = Buffer.from("logo");

    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    });

    await expect(
      storage.exists?.({ storageUri: "r2://test-bucket/releases/logo.png" }),
    ).resolves.toEqual({ exists: true });
    await expect(
      storage.exists?.({ storageUri: "r2://test-bucket/releases/missing.png" }),
    ).resolves.toEqual({ exists: false });
  });

  it("deletes R2 objects through the S3 API", async () => {
    mockS3Client();
    fakeStore["releases/logo.png"] = Buffer.from("logo");

    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    });

    await expect(
      storage.delete?.({
        storageUri: "r2://test-bucket/releases/logo.png",
      }),
    ).resolves.toEqual({
      deleted: true,
    });

    expect(deletedKeys).toEqual(["releases/logo.png"]);
    expect(fakeStore["releases/logo.png"]).toBeUndefined();
  });

  it("reads R2 text through the runtime S3 API when credentials are provided", async () => {
    mockS3Client();
    fakeStore["releases/bundle-1/manifest.json"] = Buffer.from(
      JSON.stringify({
        assets: {},
        bundleId: "bundle-1",
      }),
    );

    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    });

    const { response } = (await storage.get?.({
      storageUri: "r2://test-bucket/releases/bundle-1/manifest.json",
    })) ?? { response: null };
    expect(await response?.text()).toBe('{"assets":{},"bundleId":"bundle-1"}');
    await expect(
      storage.get?.({
        storageUri: "r2://test-bucket/releases/missing.json",
      }),
    ).resolves.toEqual({ response: null });
  });

  it("rejects configs without S3 credentials", () => {
    expect(() =>
      r2Storage({
        accountId: "account-id",
        bucketName: "test-bucket",
      } as never),
    ).toThrow("r2Storage requires S3-compatible credentials");
  });

  it("does not add getDownloadUrl to a deploy-only configuration", () => {
    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    });

    expect(Reflect.has(storage, "getDownloadUrl")).toBe(false);
  });

  it("adds a signed download URL operation when configured for a server", async () => {
    mockS3Client();
    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
      downloadUrlSigningKey: "test-signing-key",
    });

    await expect(
      storage.getDownloadUrl?.({
        storageUri: "r2://test-bucket/releases/bundle.zip",
      }),
    ).resolves.toEqual({
      url: expect.stringMatching(/^\/storage\//),
    });
  });

  it("rejects downloads from a different bucket", async () => {
    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    });

    await expect(
      storage.get?.({
        storageUri: "r2://other-bucket/releases/bundle-1/manifest.json",
      }),
    ).rejects.toThrow(
      'Bucket name mismatch: expected "test-bucket", but found "other-bucket".',
    );
  });
});
