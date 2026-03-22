import { NIL_UUID } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import { describe, expect, it, vi } from "vitest";
import {
  createAwsLambdaEdgeServer,
  createAwsLambdaEdgeServerApp,
} from "./server";

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

describe("createAwsLambdaEdgeServerApp", () => {
  it("sets cache headers for the legacy route", async () => {
    const hotUpdater = createHotUpdaterMock();
    const app = createAwsLambdaEdgeServerApp({ hotUpdater });

    const response = await app.request("https://example.com/api/check-update", {
      headers: {
        "x-app-platform": "ios",
        "x-app-version": "1.0.0",
        "x-bundle-id": "bundle-id",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("sets shared cache headers for canonical update routes", async () => {
    const hotUpdater = createHotUpdaterMock();
    const app = createAwsLambdaEdgeServerApp({ hotUpdater });

    const response = await app.request(
      "https://example.com/api/check-update/app-version/ios/1.0.0/production/default/default",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=31536000, must-revalidate",
    );
  });
});

describe("createAwsLambdaEdgeServer", () => {
  it("creates a lambda-edge handler", () => {
    const hotUpdater = createHotUpdaterMock();

    expect(createAwsLambdaEdgeServer({ hotUpdater })).toBeTypeOf("function");
  });
});
