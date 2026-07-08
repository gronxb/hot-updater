import {
  assertRuntimeStorageOperations,
  assertStorageDelete,
  assertStorageUpload,
} from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudflareWorkerStorageEnv } from "./r2WorkerStorage";

const { workerEnv } = vi.hoisted(
  (): { workerEnv: CloudflareWorkerStorageEnv } => ({
    workerEnv: {
      BUCKET: {
        delete: vi.fn(async (_key: string | string[]) => {}),
        get: vi.fn(async (_key: string) => null),
        head: vi.fn(async (_key: string) => null),
        put: vi.fn(async () => ({})),
      },
      HOT_UPDATER_PUBLIC_BASE_URL: "https://assets.example.com",
      JWT_SECRET: "secret",
    },
  }),
);

vi.mock("cloudflare:workers", () => ({
  env: workerEnv,
}));

import { r2WorkerStorage } from "./r2WorkerStorage";

const createBucket = (
  overrides: Partial<CloudflareWorkerStorageEnv["BUCKET"]> = {},
) =>
  ({
    delete: vi.fn(),
    get: vi.fn(async () => null),
    head: vi.fn(async () => null),
    put: vi.fn(),
    ...overrides,
  }) satisfies CloudflareWorkerStorageEnv["BUCKET"];

describe("r2WorkerStorage", () => {
  beforeEach(() => {
    workerEnv.BUCKET = createBucket();
    workerEnv.HOT_UPDATER_PUBLIC_BASE_URL = "https://assets.example.com";
    workerEnv.JWT_SECRET = "secret";
  });

  it("reads manifest text directly from the R2 binding", async () => {
    const get = vi.fn(async (key: string) => ({
      arrayBuffer: async () => new Response(key).arrayBuffer(),
      text: async () => `text:${key}`,
    }));
    workerEnv.BUCKET = createBucket({ get });
    const storage = r2WorkerStorage()();
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
    workerEnv.BUCKET = createBucket({ get });
    const storage = r2WorkerStorage()();
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
    workerEnv.BUCKET = createBucket({ delete: deleteObject });
    const storage = r2WorkerStorage()();
    assertStorageDelete(storage);

    await storage.delete({
      storageUri: "r2://bundles/app/bundle.zip",
    });

    expect(deleteObject).toHaveBeenCalledWith("app/bundle.zip");
  });

  it("checks object existence through the R2 binding", async () => {
    const head = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    workerEnv.BUCKET = createBucket({ head });
    const storage = r2WorkerStorage()();
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
    workerEnv.HOT_UPDATER_PUBLIC_BASE_URL =
      "https://updates.example.dev/ignored";
    const storage = r2WorkerStorage()();
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
    workerEnv.BUCKET = createBucket({ put });
    const storage = r2WorkerStorage({
      bucketName: "updates",
    })();
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
    const storage = r2WorkerStorage()();
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
