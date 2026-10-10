import type { ReleaseCatalog } from "@hot-updater/protocol";
import { describe, expect, it, vi } from "vitest";

import { createHotUpdaterHandlers } from "./handler";
import { createApi, createHandlers } from "./handler.testFixtures";
import { HOT_UPDATER_INFRASTRUCTURE_GENERATION } from "./handlerVersionRoutes";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

describe("createHandlers client routes", () => {
  it("reports the v1 infrastructure generation", async () => {
    const handler = createHandlers(createApi()).client;
    const response = await handler(new Request("http://localhost/version"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      adminProtocol: 2,
      infrastructureGeneration: HOT_UPDATER_INFRASTRUCTURE_GENERATION,
      version: HOT_UPDATER_SERVER_VERSION,
    });
  });

  it("keeps the plugins the server runs off the client /version", async () => {
    const handler = createHotUpdaterHandlers({
      api: createApi(),
      plugins: ["insights", "apiKeys"],
    }).client;

    const response = await handler(new Request("http://localhost/version"));

    await expect(response.json()).resolves.toEqual({
      adminProtocol: 2,
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
    const api = createApi();
    const getReleaseCatalog = vi
      .spyOn(api.core, "getReleaseCatalog")
      .mockResolvedValue(catalog);
    const handler = createHandlers(api).client;
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

  it("serves artifact protocol v1 on an explicit route", async () => {
    const api = createApi();
    const getArtifactInfo = vi
      .spyOn(api.core, "getArtifactInfo")
      .mockResolvedValue({
        artifactProtocolVersion: 1,
        assets: {
          "index.ios.bundle": {
            file: { url: "https://cdn.example.com/file" },
            fileHash: "target-hash",
          },
        },
        manifestFileHash: "manifest-hash",
        manifestUrl: "https://cdn.example.com/manifest.json",
      });
    const handler = createHandlers(api).client;

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
          file: { url: "https://cdn.example.com/file" },
        },
      },
    });
    expect(getArtifactInfo).toHaveBeenCalledWith("target", "current", 1);
  });

  it("authenticates artifact protocol v1 before resolving artifacts", async () => {
    const api = createApi();
    const getArtifactInfo = vi
      .spyOn(api.core, "getArtifactInfo")
      .mockResolvedValue({
        artifactProtocolVersion: 1,
        assets: {},
        manifestFileHash: "manifest-hash",
        manifestUrl: "https://cdn.example.com/manifest.json",
      });
    const authenticate = vi.fn(async (request: Request) => {
      const apiKey = request.headers.get("x-api-key");
      if (apiKey === "unavailable") {
        throw new Error("credential storage unavailable");
      }
      return apiKey === "valid";
    });
    const handler = createHotUpdaterHandlers({
      api,
      clientPolicy: { authenticate, varyHeaders: ["x-api-key"] },
    }).client;
    const url = "http://localhost/artifacts/v1/target/from/current";

    const missing = await handler(new Request(url));
    const invalid = await handler(
      new Request(url, { headers: { "x-api-key": "invalid" } }),
    );
    const valid = await handler(
      new Request(url, { headers: { "x-api-key": "valid" } }),
    );
    const unavailable = await handler(
      new Request(url, { headers: { "x-api-key": "unavailable" } }),
    );

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(valid.status).toBe(200);
    expect(unavailable.status).toBe(503);
    expect(authenticate).toHaveBeenCalledTimes(4);
    expect(getArtifactInfo).toHaveBeenCalledOnce();
    expect(getArtifactInfo).toHaveBeenCalledWith("target", "current", 1);
  });

  it.each([
    [
      "a channel name where its key belongs",
      "/release-catalogs/app-version/ios/production/1.0.0",
    ],
    [
      "a channel key that is not canonically encoded",
      "/release-catalogs/app-version/ios/cHJvZHVjdGlvbg==/1.0.0",
    ],
    [
      "a fingerprint hash that is no URL-safe segment",
      "/release-catalogs/fingerprint/ios/cHJvZHVjdGlvbg/hash%20with%20spaces",
    ],
  ])("answers 400 to %s without reading a catalog", async (_, path) => {
    const api = createApi();
    const getReleaseCatalog = vi.spyOn(api.core, "getReleaseCatalog");
    const handler = createHandlers(api).client;

    const response = await handler(new Request(`http://localhost${path}`));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: expect.any(String),
    });
    expect(getReleaseCatalog).not.toHaveBeenCalled();
  });

  it("does not expose provider errors from the public client handler", async () => {
    const api = createApi();
    vi.spyOn(api.core, "getReleaseCatalog").mockRejectedValue(
      new Error("private database connection details"),
    );
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
