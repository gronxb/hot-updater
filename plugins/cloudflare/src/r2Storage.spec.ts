import { Buffer } from "buffer";
import fs from "fs/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => "https://signed-r2.example.com/object"),
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
    })();

    const filePath = "/tmp/hot-updater-r2-upload.txt";
    await fs.writeFile(filePath, "hello r2");

    await expect(
      storage.profiles.node.upload("releases/bundle-1", filePath),
    ).resolves.toEqual({
      storageUri:
        "r2://test-bucket/releases/bundle-1/hot-updater-r2-upload.txt",
    });
    expect(fakeStore["releases/bundle-1/hot-updater-r2-upload.txt"]).toEqual(
      Buffer.from("hello r2"),
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
    })();

    const downloadPath = "/tmp/hot-updater-test-manifest.json";
    await fs.rm(downloadPath, { force: true });

    await storage.profiles.node.downloadFile(
      "r2://test-bucket/releases/bundle-1/manifest.json",
      downloadPath,
    );

    expect(JSON.parse(await fs.readFile(downloadPath, "utf8"))).toEqual({
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
    })();

    await expect(
      storage.profiles.node.exists("r2://test-bucket/releases/logo.png"),
    ).resolves.toBe(true);
    await expect(
      storage.profiles.node.exists("r2://test-bucket/releases/missing.png"),
    ).resolves.toBe(false);
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
    })();

    await storage.profiles.node.delete("r2://test-bucket/releases/logo.png");

    expect(deletedKeys).toEqual(["releases/logo.png"]);
    expect(fakeStore["releases/logo.png"]).toBeUndefined();
    expect(wrangler).not.toHaveBeenCalled();
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
    })();

    await expect(
      storage.profiles.runtime.readText(
        "r2://test-bucket/releases/bundle-1/manifest.json",
      ),
    ).resolves.toBe('{"assets":{},"bundleId":"bundle-1"}');
    await expect(
      storage.profiles.runtime.readText(
        "r2://test-bucket/releases/missing.json",
      ),
    ).resolves.toBeNull();
  });

  it("creates signed R2 download URLs through the runtime S3 API", async () => {
    mockS3Client();
    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      credentials: {
        accessKeyId: "access-key-id",
        secretAccessKey: "secret-access-key",
      },
    })();

    await expect(
      storage.profiles.runtime.getDownloadUrl(
        "r2://test-bucket/releases/bundle-1/index.bundle",
      ),
    ).resolves.toEqual({
      fileUrl: "https://signed-r2.example.com/object",
    });
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.any(S3Client),
      expect.any(GetObjectCommand),
      { expiresIn: 3600 },
    );
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
    })();

    const downloadPath = "/tmp/hot-updater-test-manifest.json";
    await fs.rm(downloadPath, { force: true });

    await storage.profiles.node.downloadFile(
      "r2://test-bucket/releases/bundle-1/manifest.json",
      downloadPath,
    );

    expect(JSON.parse(await fs.readFile(downloadPath, "utf8"))).toEqual({
      bundleId: "bundle-1",
      assets: {},
    });
    expect(wrangler).toHaveBeenCalledWith(
      "r2",
      "object",
      "get",
      "test-bucket/releases/bundle-1/manifest.json",
      "--file",
      downloadPath,
      "--remote",
    );
  });

  it("keeps the deprecated wrangler path node-only at runtime", async () => {
    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      cloudflareApiToken: "api-token",
    })();

    await expect(
      storage.profiles.runtime.readText(
        "r2://test-bucket/releases/bundle-1/manifest.json",
      ),
    ).rejects.toThrow("r2Storage runtime profile requires R2 S3 credentials.");
  });

  it("rejects downloads from a different bucket", async () => {
    const storage = r2Storage({
      accountId: "account-id",
      bucketName: "test-bucket",
      cloudflareApiToken: "api-token",
    })();

    await expect(
      storage.profiles.node.downloadFile(
        "r2://other-bucket/releases/bundle-1/manifest.json",
        "/tmp/hot-updater-test-manifest.json",
      ),
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
    })();

    await expect(
      storage.profiles.node.exists("r2://test-bucket/releases/logo.png"),
    ).resolves.toBe(false);
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
    })();

    await expect(
      storage.profiles.node.exists("r2://test-bucket/releases/logo.png"),
    ).rejects.toBe(error);
  });
});
