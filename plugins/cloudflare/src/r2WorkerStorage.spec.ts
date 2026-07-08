import {
  assertRuntimeStorageOperations,
  assertStorageDelete,
  assertStorageUpload,
  type RequestEnvContext,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  type CloudflareWorkerStorageEnv,
  r2WorkerStorage,
} from "./r2WorkerStorage";

type TestContext = RequestEnvContext<CloudflareWorkerStorageEnv>;

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
  it("reads manifest text directly from the R2 binding", async () => {
    const get = vi.fn(async (key: string) => ({
      arrayBuffer: async () => new Response(key).arrayBuffer(),
      text: async () => `text:${key}`,
    }));
    const storage = r2WorkerStorage({
      jwtSecret: "secret",
      publicBaseUrl: "https://assets.example.com",
    })();
    assertRuntimeStorageOperations(storage);

    await expect(
      storage.readText("r2://bundles/app/manifest.json", {
        env: {
          BUCKET: createBucket({ get }),
          JWT_SECRET: "secret",
        },
        request: new Request("https://updates.example.com"),
      } satisfies TestContext),
    ).resolves.toBe("text:app/manifest.json");
    expect(get).toHaveBeenCalledWith("app/manifest.json");
  });

  it("reads object bytes directly from the R2 binding", async () => {
    const data = await new Response("bundle").arrayBuffer();
    const get = vi.fn(async () => ({
      arrayBuffer: async () => data,
      text: async () => "bundle",
    }));
    const storage = r2WorkerStorage({
      jwtSecret: "secret",
      publicBaseUrl: "https://assets.example.com",
    })();
    if (!storage.readBytes) {
      throw new Error("expected readBytes operation");
    }

    await expect(
      storage.readBytes("r2://bundles/app/bundle.zip", {
        env: {
          BUCKET: createBucket({ get }),
          JWT_SECRET: "secret",
        },
        request: new Request("https://updates.example.com"),
      } satisfies TestContext),
    ).resolves.toEqual(data);
    expect(get).toHaveBeenCalledWith("app/bundle.zip");
  });

  it("deletes objects through the R2 binding", async () => {
    const deleteObject = vi.fn();
    const storage = r2WorkerStorage({
      jwtSecret: "secret",
      publicBaseUrl: "https://assets.example.com",
    })();
    assertStorageDelete(storage);

    await storage.delete("r2://bundles/app/bundle.zip", {
      env: {
        BUCKET: createBucket({ delete: deleteObject }),
        JWT_SECRET: "secret",
      },
      request: new Request("https://updates.example.com"),
    } satisfies TestContext);

    expect(deleteObject).toHaveBeenCalledWith("app/bundle.zip");
  });

  it("checks object existence through the R2 binding", async () => {
    const head = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce(null);
    const storage = r2WorkerStorage({
      jwtSecret: "secret",
      publicBaseUrl: "https://assets.example.com",
    })();
    if (!storage.exists) {
      throw new Error("expected exists operation");
    }
    const context = {
      env: {
        BUCKET: createBucket({ head }),
        JWT_SECRET: "secret",
      },
      request: new Request("https://updates.example.com"),
    } satisfies TestContext;

    await expect(
      storage.exists("r2://bundles/app/bundle.zip", context),
    ).resolves.toBe(true);
    await expect(
      storage.exists("r2://bundles/app/missing.zip", context),
    ).resolves.toBe(false);
  });

  it("uploads bytes through the R2 binding", async () => {
    const put = vi.fn();
    const storage = r2WorkerStorage({
      bucketName: "updates",
      jwtSecret: "secret",
      publicBaseUrl: "https://assets.example.com",
    })();
    assertStorageUpload(storage);

    await expect(
      storage.upload(
        "app/manifest.json",
        {
          kind: "bytes",
          data: '{"bundleId":"app"}',
          contentType: "application/json",
        },
        {
          env: {
            BUCKET: createBucket({ put }),
            JWT_SECRET: "secret",
          },
          request: new Request("https://updates.example.com"),
        } satisfies TestContext,
      ),
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

  it("fails fast when the R2 binding is missing", async () => {
    const storage = r2WorkerStorage({
      jwtSecret: "secret",
      publicBaseUrl: "https://assets.example.com",
    })();
    assertRuntimeStorageOperations(storage);

    await expect(
      storage.readText("r2://bundles/app/manifest.json", {
        env: {
          JWT_SECRET: "secret",
        },
        request: new Request("https://updates.example.com"),
      } as TestContext),
    ).rejects.toThrow(
      "r2WorkerStorage requires env.BUCKET in the hot updater context.",
    );
  });
});
