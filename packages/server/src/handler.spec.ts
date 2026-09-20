import type { ReleaseCatalog } from "@hot-updater/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  createHandlers,
  createHotUpdaterHandlers,
  type HandlerAPI,
} from "./handler";
import { createApi } from "./handler.testFixtures";
import { HOT_UPDATER_INFRASTRUCTURE_GENERATION } from "./handlerVersionRoutes";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

describe("createHandlers client routes", () => {
  it("reports the v1 infrastructure generation", async () => {
    const handler = createHandlers(createApi()).client;
    const response = await handler(new Request("http://localhost/version"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      infrastructureGeneration: HOT_UPDATER_INFRASTRUCTURE_GENERATION,
      version: HOT_UPDATER_SERVER_VERSION,
    });
  });

  it.each([
    "/app-version/ios/1.0.0/production/default/default",
    "/fingerprint/android/fingerprint-123/production/default/default",
  ])("does not expose the v0 route %s", async (path) => {
    const handler = createHandlers(createApi()).client;

    const response = await handler(new Request(`http://localhost${path}`));

    expect(response.status).toBe(404);
  });

  it.each([
    "/v2/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0",
    "/v2/artifacts/target-bundle/from/current-bundle",
    "/artifacts/target-bundle/from/current-bundle",
  ])("does not expose the unsupported route %s", async (path) => {
    const handler = createHandlers(createApi()).client;

    const response = await handler(new Request(`http://localhost${path}`));

    expect(response.status).toBe(404);
  });

  it("does not match the admin mount namespace", async () => {
    const handler = createHandlers(createApi()).client;

    const response = await handler(
      new Request("http://localhost/admin/channels"),
    );

    expect(response.status).toBe(404);
  });

  it("returns the stored Catalog identity without accepting identity parameters", async () => {
    const catalog = {
      catalogId: "project-a",
      catalogHash: "sha256:catalog",
      fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
      generation: 1,
      releases: [],
      schemaVersion: 1,
      scopeKey: "v1:fingerprint:android:cHJvZHVjdGlvbg:fingerprint-123",
    } satisfies ReleaseCatalog;
    const getReleaseCatalog = vi
      .fn<NonNullable<HandlerAPI["getReleaseCatalog"]>>()
      .mockResolvedValue(catalog);
    const handler = createHandlers({
      ...createApi(),
      getReleaseCatalog,
    }).client;
    const url =
      "http://localhost/release-catalogs/fingerprint/android/" +
      "cHJvZHVjdGlvbg/fingerprint-123";

    const response = await handler(new Request(url));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      catalogId: "project-a",
    });
    expect(getReleaseCatalog).toHaveBeenCalledWith({
      channelKey: "cHJvZHVjdGlvbg",
      fingerprintHash: "fingerprint-123",
      platform: "android",
      strategy: "FINGERPRINT",
    });

    const legacyAuthorityPath = await handler(
      new Request(url.replace("/android/", "/project-a/android/")),
    );
    expect(legacyAuthorityPath.status).toBe(404);
    expect(getReleaseCatalog).toHaveBeenCalledOnce();
  });

  it("serves client-relative storage paths under a framework mount", async () => {
    const api = {
      ...createApi(),
      getArtifactInfo: vi.fn().mockResolvedValue({
        artifactProtocolVersion: 1,
        assets: {
          "index.bundle": {
            file: {
              url: "/storage/asset-token/asset-signature",
            },
            fileHash: "asset-hash",
            patch: {
              algorithm: "bsdiff",
              baseBundleId: "bundle-1",
              baseFileHash: "base-hash",
              patchFileHash: "patch-hash",
              patchUrl: "/storage/patch-token/patch-signature",
            },
          },
        },
        manifestFileHash: "manifest-hash",
        manifestUrl: "/storage/manifest-token/manifest-signature",
      }),
    };
    const handlers = createHotUpdaterHandlers(
      api,
      undefined,
      undefined,
      async () => new Response("bundle archive"),
    );
    const app = new Hono();
    app.mount("/hot-updater", handlers.client);

    const response = await app.request(
      "/hot-updater/artifacts/v1/bundle-2/from/bundle-1",
    );

    expect(response.status).toBe(200);
    const info = (await response.json()) as {
      assets: Record<
        string,
        { file: { url: string }; patch: { patchUrl: string } }
      >;
      manifestUrl: string;
    };
    expect(info).toMatchObject({
      assets: {
        "index.bundle": {
          file: { url: "/storage/asset-token/asset-signature" },
          patch: { patchUrl: "/storage/patch-token/patch-signature" },
        },
      },
      manifestUrl: "/storage/manifest-token/manifest-signature",
    });

    const download = await app.request(
      `/hot-updater${info.assets["index.bundle"]!.file.url}`,
    );
    expect(download.status).toBe(200);
    await expect(download.text()).resolves.toBe("bundle archive");
  });

  it("serves artifact protocol v1 on an explicit route", async () => {
    const getArtifactInfo = vi
      .fn<NonNullable<HandlerAPI["getArtifactInfo"]>>()
      .mockResolvedValue({
        artifactProtocolVersion: 1,
        assets: {
          "index.ios.bundle": {
            file: { url: "/storage/file-token/file-signature" },
            fileHash: "target-hash",
          },
        },
        manifestFileHash: "manifest-hash",
        manifestUrl: "/storage/manifest-token/manifest-signature",
      });
    const handler = createHandlers({
      ...createApi(),
      getArtifactInfo,
    }).client;

    const response = await handler(
      new Request("http://localhost/artifacts/v1/target/from/current"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.hot-updater.artifact+json; version=1",
    );
    await expect(response.json()).resolves.toMatchObject({
      artifactProtocolVersion: 1,
      assets: {
        "index.ios.bundle": {
          file: { url: "/storage/file-token/file-signature" },
        },
      },
    });
    expect(getArtifactInfo).toHaveBeenCalledWith("target", "current", 1);
  });

  it("does not expose provider errors from the public client handler", async () => {
    const api = {
      ...createApi(),
      getReleaseCatalog: vi
        .fn()
        .mockRejectedValue(new Error("private database connection details")),
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const handler = createHandlers(api).client;

    const response = await handler(
      new Request(
        "http://localhost/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0",
      ),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Hot Updater handler error:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
