import fs from "fs/promises";

import { ExecaError } from "execa";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { r2Storage } from "./r2Storage";

const { wrangler } = vi.hoisted(() => ({
  wrangler: vi.fn(),
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
    wrangler.mockReset();
  });

  it("downloads R2 objects with wrangler to the given file path", async () => {
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
