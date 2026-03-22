import { NIL_UUID } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import { describe, expect, it, vi } from "vitest";
import { createSupabaseServerApp } from "./server";

const createHotUpdaterMock = (): HotUpdaterAPI => {
  return {
    getAppUpdateInfo: vi.fn().mockResolvedValue({
      id: NIL_UUID,
      message: null,
      shouldForceUpdate: true,
      status: "ROLLBACK",
      fileHash: null,
      fileUrl: null,
    }),
    handler: vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json",
        },
      }),
    ),
    getBundleById: vi.fn(),
    getBundles: vi.fn(),
    insertBundle: vi.fn(),
    updateBundleById: vi.fn(),
    deleteBundleById: vi.fn(),
    getChannels: vi.fn(),
    adapterName: "mock",
    createMigrator: vi.fn(),
    generateSchema: vi.fn(),
  } as unknown as HotUpdaterAPI;
};

describe("createSupabaseServerApp", () => {
  it("uses functionName as the default base path", async () => {
    const hotUpdater = createHotUpdaterMock();
    const app = createSupabaseServerApp({
      hotUpdater,
      functionName: "hot-updater",
    });

    const response = await app.request(
      "https://example.com/hot-updater/fingerprint/android/fp-hash/production/default/bundle-id",
    );

    expect(response.status).toBe(200);
    expect(hotUpdater.handler).toHaveBeenCalledOnce();
  });
});
