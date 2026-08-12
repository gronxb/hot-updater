import { Buffer } from "buffer";
import fs from "fs/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ExecaError } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { r2Storage } from "./r2Storage";

const { wrangler } = vi.hoisted(() => ({
  wrangler: vi.fn(),
}));

let fakeStore: Record<string, Buffer> = {};
let deletedKeys: string[] = [];

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    params: {
      Body: Buffer;
      Bucket: string;
      CacheControl?: string;
      ContentType?: string;
      Key: string;
    };

    constructor({
      params,
    }: {
      params: {
        Body: Buffer;
        Bucket: string;
        CacheControl?: string;
        ContentType?: string;
        Key: string;
      };
    }) {
      this.params = params;
    }

    async done() {
      fakeStore[this.params.Key] = this.params.Body;
      return {
        Bucket: this.params.Bucket,
        Key: this.params.Key,
      };
    }
  },
}));

vi.mock("./utils/createWrangler", () => ({
  createWrangler: vi.fn(() => wrangler),
}));

const createExecaError = (message: string) =>
  Object.assign(Object.create(ExecaError.prototype), {
    message,
    shortMessage: message,
    stderr: message,
    stdout: "",
  }) as ExecaError;

describe("r2Storage", () => {
  beforeEach(() => {
    fakeStore = {};
    deletedKeys = [];
    wrangler.mockReset();
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
        body: new TextEncoder().encode("hello r2"),
        contentType: "text/plain",
      }),
    ).resolves.toEqual({
      storageUri:
        "r2://test-bucket/releases/bundle-1/hot-updater-r2-upload.txt",
    });
    expect(fakeStore["releases/bundle-1/hot-updater-r2-upload.txt"]).toEqual(
      new TextEncoder().encode("hello r2"),
    );
    expect(wrangler).not.toHaveBeenCalled();
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
    expect(wrangler).not.toHaveBeenCalled();
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
      storageUri: "r2://test-bucket/releases/logo.png",
    });

    expect(deletedKeys).toEqual(["releases/logo.png"]);
    expect(fakeStore["releases/logo.png"]).toBeUndefined();
    expect(wrangler).not.toHaveBeenCalled();
  });

  it("deletes exactly one R2 object through the Wrangler fallback", async () => {
    wrangler.mockResolvedValue({ exitCode: 0, stderr: "" });
    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      cloudflareApiToken: "api-token",
    });

    await expect(
      storage.delete?.({
        storageUri: "r2://test-bucket/releases/logo.png",
      }),
    ).resolves.toEqual({
      storageUri: "r2://test-bucket/releases/logo.png",
    });

    expect(wrangler).toHaveBeenCalledWith(
      "r2",
      "object",
      "delete",
      "test-bucket/releases/logo.png",
      "--remote",
    );
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

  it("falls back to wrangler without S3 credentials", async () => {
    wrangler.mockImplementation(async (...args: string[]) => {
      const fileIndex = args.indexOf("--file");
      const downloadPath = args[fileIndex + 1];

      await fs.writeFile(
        downloadPath,
        JSON.stringify({
          bundleId: "bundle-1",
          assets: {},
        }),
      );

      return {
        exitCode: 0,
        stderr: "",
      };
    });

    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      cloudflareApiToken: "api-token",
    });

    const { response } = (await storage.get?.({
      storageUri: "r2://test-bucket/releases/bundle-1/manifest.json",
    })) ?? { response: null };

    expect(JSON.parse((await response?.text()) ?? "")).toEqual({
      bundleId: "bundle-1",
      assets: {},
    });
    expect(wrangler).toHaveBeenCalledWith(
      "r2",
      "object",
      "get",
      "test-bucket/releases/bundle-1/manifest.json",
      "--file",
      expect.any(String),
      "--remote",
    );
  });

  it("does not add getDownloadUrl to a deploy-only configuration", () => {
    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      cloudflareApiToken: "api-token",
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
      cloudflareApiToken: "api-token",
    });

    await expect(
      storage.get?.({
        storageUri: "r2://other-bucket/releases/bundle-1/manifest.json",
      }),
    ).rejects.toThrow(
      'Bucket name mismatch: expected "test-bucket", but found "other-bucket".',
    );
    expect(wrangler).not.toHaveBeenCalled();
  });

  it("returns false when the R2 object does not exist", async () => {
    wrangler.mockRejectedValueOnce(createExecaError("object not found"));

    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      cloudflareApiToken: "api-token",
    });

    await expect(
      storage.exists?.({ storageUri: "r2://test-bucket/releases/logo.png" }),
    ).resolves.toEqual({ exists: false });
    expect(wrangler).toHaveBeenCalledWith(
      "r2",
      "object",
      "get",
      "test-bucket/releases/logo.png",
      "--file",
      expect.any(String),
      "--remote",
    );
  });

  it("rethrows non-missing R2 existence errors", async () => {
    const error = createExecaError("Authentication failed");
    wrangler.mockRejectedValueOnce(error);

    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      cloudflareApiToken: "api-token",
    });

    await expect(
      storage.exists?.({ storageUri: "r2://test-bucket/releases/logo.png" }),
    ).rejects.toBe(error);
  });
});
