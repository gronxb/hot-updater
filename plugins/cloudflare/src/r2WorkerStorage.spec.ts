import {
  assertRuntimeStorageOperations,
  assertStorageDelete,
  assertStorageUpload,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import type {
  CloudflareWorkerStorageBucket,
  CloudflareWorkerStorageConfig,
} from "./r2WorkerStorage";
import { r2WorkerStorage } from "./r2WorkerStorage";

const createBucket = (overrides: Partial<CloudflareWorkerStorageBucket> = {}) =>
  ({
    delete: vi.fn(),
    get: vi.fn(async () => null),
    head: vi.fn(async () => null),
    put: vi.fn(),
    ...overrides,
  }) satisfies CloudflareWorkerStorageBucket;

const createConfig = (
  overrides: Partial<CloudflareWorkerStorageConfig> = {},
): CloudflareWorkerStorageConfig => ({
  bucket: createBucket(),
  jwtSecret: "secret",
  publicBaseUrl: "https://assets.example.com",
  ...overrides,
});

describe("r2WorkerStorage", () => {
  it("reads manifest text directly from the R2 binding", async () => {
    const get = vi.fn(async (key: string) => ({
      arrayBuffer: async () => new Response(key).arrayBuffer(),
      text: async () => `text:${key}`,
    }));
    const storage = r2WorkerStorage(
      createConfig({ bucket: createBucket({ get }) }),
    )();
    assertRuntimeStorageOperations(storage);

    await expect(
      storage.readText({ storageUri: "r2://bundles/app/manifest.json" }),
    ).resolves.toBe("text:app/manifest.json");
    expect(get).toHaveBeenCalledWith("app/manifest.json");
  });

  it("reads object bytes directly from the R2 binding", async () => {
    const data = await new Response("bundle").arrayBuffer();
    const get = vi.fn(async () => ({
      arrayBuffer: async () => data,
      text: async () => "bundle",
    }));
    const storage = r2WorkerStorage(
      createConfig({ bucket: createBucket({ get }) }),
    )();
    if (!storage.readBytes) {
      throw new Error("expected readBytes operation");
    }

    await expect(
      storage.readBytes({ storageUri: "r2://bundles/app/bundle.zip" }),
    ).resolves.toEqual(data);
    expect(get).toHaveBeenCalledWith("app/bundle.zip");
  });

  it("deletes objects through the R2 binding", async () => {
    const deleteObject = vi.fn();
    const storage = r2WorkerStorage(
      createConfig({ bucket: createBucket({ delete: deleteObject }) }),
    )();
    assertStorageDelete(storage);

    await storage.delete({
      storageUri: "r2://bundles/app/bundle.zip",
    });

    expect(deleteObject).toHaveBeenCalledWith("app/bundle.zip");
  });

  it("checks object existence through the R2 binding", async () => {
    const head = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    const storage = r2WorkerStorage(
      createConfig({ bucket: createBucket({ head }) }),
    )();
    if (!storage.exists) {
      throw new Error("expected exists operation");
    }

    await expect(
      storage.exists({ storageUri: "r2://bundles/app/bundle.zip" }),
    ).resolves.toBe(true);
    await expect(
      storage.exists({ storageUri: "r2://bundles/app/missing.zip" }),
    ).resolves.toBe(false);
  });

  it("signs download URLs with Worker env config", async () => {
    const storage = r2WorkerStorage(
      createConfig({ publicBaseUrl: "https://updates.example.dev/ignored" }),
    )();
    if (!storage.getDownloadUrl) {
      throw new Error("expected getDownloadUrl operation");
    }

    const { fileUrl } = await storage.getDownloadUrl({
      storageUri: "r2://bundles/app/bundle.zip",
    });
    const url = new URL(fileUrl);

    expect(url.origin).toBe("https://updates.example.dev");
    expect(url.pathname).toBe("/bundles/app/bundle.zip");
    expect(url.searchParams.get("token")).toEqual(expect.any(String));
  });

  it("uploads bytes through the R2 binding", async () => {
    const put = vi.fn();
    const storage = r2WorkerStorage(
      createConfig({
        bucket: createBucket({ put }),
        bucketName: "updates",
      }),
    )();
    assertStorageUpload(storage);

    await expect(
      storage.upload({
        key: "app/manifest.json",
        source: {
          kind: "bytes",
          data: '{"bundleId":"app"}',
          contentType: "application/json",
        },
      }),
    ).resolves.toEqual({
      storageUri: "r2://updates/app/manifest.json",
    });
    expect(put).toHaveBeenCalledWith(
      "app/manifest.json",
      '{"bundleId":"app"}',
      {
        httpMetadata: {
          contentType: "application/json",
        },
      },
    );
  });

  it("rejects file upload sources in worker runtimes", async () => {
    const storage = r2WorkerStorage(createConfig())();
    assertStorageUpload(storage);

    await expect(
      storage.upload({
        key: "app/bundle.zip",
        source: {
          kind: "file",
          filePath: "bundle.zip",
        },
      }),
    ).rejects.toThrow("r2WorkerStorage only supports bytes upload sources.");
  });
});
