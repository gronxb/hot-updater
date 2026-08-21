import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const repoDir = path.resolve(__dirname, "../..");
const controllerPath = path.join(
  repoDir,
  "e2e/detox/control-server/controller.ts",
);

describe("Detox remote asset proxy URLs", () => {
  it("does not expose the provider signed URL in the app-visible proxy URL", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");

    expect(controllerSource).not.toContain("/e2e/proxy-url?url=");
    expect(controllerSource).toContain("/e2e/proxy-url/");
  });

  it("rewrites update asset URLs to opaque paths that resolve server-side", async () => {
    const resultsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-proxy-url-"),
    );
    const signedBundleUrl =
      "https://storage.example.com/bundles/bundle.zip?Signature=a%2Fb%2B1&Expires=1780876479";
    const signedManifestUrl =
      "https://storage.example.com/bundles/manifest.json?token=abc.def";
    const signedPatchUrl =
      "https://storage.example.com/bundles/bundle.bsdiff?Signature=patch";
    const fetchTargets: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : input;
      fetchTargets.push(url);

      if (url.startsWith("https://provider.example.com/hot-updater/")) {
        return new Response(
          JSON.stringify({
            changedAssets: {
              "assets/example.bmp": {
                file: { url: signedBundleUrl },
                patch: {
                  algorithm: "bsdiff",
                  baseBundleId: "019ea44a-0000-7000-8000-000000000000",
                  patchUrl: signedPatchUrl,
                },
              },
            },
            fileUrl: signedBundleUrl,
            manifestUrl: signedManifestUrl,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      }

      if (url === signedBundleUrl || url === signedPatchUrl) {
        return new Response(
          url === signedPatchUrl ? "patch-bytes" : "bundle-bytes",
          {
            headers: {
              "content-encoding": "br",
              "content-length": "999",
              "content-type": "application/zip",
            },
            status: 200,
          },
        );
      }

      return new Response("unexpected fetch target", { status: 500 });
    });

    vi.resetModules();
    vi.stubEnv(
      "HOT_UPDATER_E2E_APP_BASE_URL",
      "https://provider.example.com/hot-updater",
    );
    vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "com.hotupdater.example");
    vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "booted");
    vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", "ios");
    vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", resultsDir);
    vi.stubEnv("PORT", "3107");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const controller = await import("./control-server/controller.ts");
      const updateResponse = await controller.handleProxyUpdateRequest(
        new Request(
          "http://localhost:3107/hot-updater/artifacts/target/from/current",
        ),
      );
      const payload = (await updateResponse.json()) as {
        changedAssets: Record<
          string,
          { file: { url: string }; patch: { patchUrl: string } }
        >;
        fileUrl: string;
        manifestUrl: string;
      };

      expect(payload.fileUrl).toMatch(
        /^http:\/\/localhost:3107\/e2e\/proxy-url\/[-0-9a-f]+$/,
      );
      expect(payload.manifestUrl).toMatch(
        /^http:\/\/localhost:3107\/e2e\/proxy-url\/[-0-9a-f]+$/,
      );
      expect(payload.fileUrl).not.toContain("?url=");
      expect(payload.fileUrl).not.toContain("Signature");
      expect(payload.fileUrl).not.toContain("storage.example.com");

      const assetUrl = payload.changedAssets["assets/example.bmp"]?.file.url;
      expect(assetUrl).toMatch(
        /^http:\/\/localhost:3107\/e2e\/proxy-url\/[-0-9a-f]+$/,
      );
      const patchUrl =
        payload.changedAssets["assets/example.bmp"]?.patch.patchUrl;
      expect(patchUrl).toMatch(
        /^http:\/\/localhost:3107\/e2e\/proxy-url\/[-0-9a-f]+$/,
      );

      const assetResponse = await controller.handleProxyRemoteAssetRequest(
        new Request(payload.fileUrl),
      );

      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-encoding")).toBeNull();
      expect(assetResponse.headers.get("content-length")).toBeNull();
      expect(assetResponse.headers.get("content-type")).toBe("application/zip");
      expect(await assetResponse.text()).toBe("bundle-bytes");
      expect(fetchTargets).toContain(signedBundleUrl);

      const patchResponse = await controller.handleProxyRemoteAssetRequest(
        new Request(patchUrl),
      );

      expect(patchResponse.status).toBe(200);
      expect(await patchResponse.text()).toBe("patch-bytes");
      expect(fetchTargets).toContain(signedPatchUrl);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await fs.rm(resultsDir, { force: true, recursive: true });
    }
  });

  it("proxies client-relative storage URLs without rewriting manifest bytes", async () => {
    const resultsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-relative-proxy-url-"),
    );
    const baseUrl = "https://provider.example.com/hot-updater";
    const bundlePath = "/storage/bundles/bundle.zip?token=bundle";
    const manifestPath = "/storage/bundles/manifest.json?token=manifest";
    const assetPath = "/storage/assets/sha256/asset?token=asset";
    const patchPath = "/storage/bundles/bundle.bsdiff?token=patch";
    const manifestBytes =
      '{\n  "bundleId": "target",\n  "signature": "signed"\n}\n';
    const fetchTargets: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : input;
      fetchTargets.push(url);

      if (url === `${baseUrl}/artifacts/target/from/current`) {
        return Response.json({
          changedAssets: {
            "assets/example.bmp": {
              file: { url: assetPath },
              patch: {
                algorithm: "bsdiff",
                baseBundleId: "019ea44a-0000-7000-8000-000000000000",
                patchUrl: patchPath,
              },
            },
          },
          fileUrl: bundlePath,
          manifestUrl: manifestPath,
        });
      }

      if (url === `${baseUrl}${manifestPath}`) {
        return new Response(manifestBytes, {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${baseUrl}${bundlePath}`) {
        return new Response("bundle-bytes");
      }
      if (url === `${baseUrl}${assetPath}`) {
        return new Response("asset-bytes");
      }
      if (url === `${baseUrl}${patchPath}`) {
        return new Response("patch-bytes");
      }

      return new Response("unexpected fetch target", { status: 500 });
    });

    vi.resetModules();
    vi.stubEnv("HOT_UPDATER_E2E_APP_BASE_URL", baseUrl);
    vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "com.hotupdater.example");
    vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "booted");
    vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", "ios");
    vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", resultsDir);
    vi.stubEnv("PORT", "3107");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const controller = await import("./control-server/controller.ts");
      const updateResponse = await controller.handleProxyUpdateRequest(
        new Request(
          "http://localhost:3107/hot-updater/artifacts/target/from/current",
        ),
      );
      const payload = (await updateResponse.json()) as {
        changedAssets: Record<
          string,
          { file: { url: string }; patch: { patchUrl: string } }
        >;
        fileUrl: string;
        manifestUrl: string;
      };
      const assetUrl = payload.changedAssets["assets/example.bmp"]!.file.url;
      const patchUrl =
        payload.changedAssets["assets/example.bmp"]!.patch.patchUrl;
      for (const url of [
        payload.fileUrl,
        payload.manifestUrl,
        assetUrl,
        patchUrl,
      ]) {
        expect(url).toMatch(
          /^http:\/\/localhost:3107\/e2e\/proxy-url\/[-0-9a-f]+$/,
        );
      }

      const manifestResponse = await controller.handleProxyRemoteAssetRequest(
        new Request(payload.manifestUrl),
      );
      expect(await manifestResponse.text()).toBe(manifestBytes);

      controller.handleConfigureProxy({ artifactFailures: 1 });
      const failedBundleResponse =
        await controller.handleProxyRemoteAssetRequest(
          new Request(payload.fileUrl),
        );
      expect(failedBundleResponse.status).toBe(503);
      expect(controller.handleProxyState().artifactFailuresRemaining).toBe(0);
      expect(
        await (
          await controller.handleProxyRemoteAssetRequest(
            new Request(payload.fileUrl),
          )
        ).text(),
      ).toBe("bundle-bytes");
      expect(
        await (
          await controller.handleProxyRemoteAssetRequest(new Request(assetUrl))
        ).text(),
      ).toBe("asset-bytes");
      expect(
        await (
          await controller.handleProxyRemoteAssetRequest(new Request(patchUrl))
        ).text(),
      ).toBe("patch-bytes");

      expect(fetchTargets).toEqual(
        expect.arrayContaining([
          `${baseUrl}${bundlePath}`,
          `${baseUrl}${manifestPath}`,
          `${baseUrl}${assetPath}`,
          `${baseUrl}${patchPath}`,
        ]),
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await fs.rm(resultsDir, { force: true, recursive: true });
    }
  });

  it("uses the client access key for direct and proxied update requests", async () => {
    const resultsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-client-key-proxy-"),
    );
    const observedKeys: Array<string | null> = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedKeys.push(new Headers(init?.headers).get("x-api-key"));
        return Response.json({ status: "NO_UPDATE" });
      },
    );

    vi.resetModules();
    vi.stubEnv("HOT_UPDATER_API_KEY", "client-access-key");
    vi.stubEnv(
      "HOT_UPDATER_E2E_APP_BASE_URL",
      "https://provider.example.com/hot-updater",
    );
    vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "com.hotupdater.example");
    vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "booted");
    vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", "ios");
    vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", resultsDir);
    vi.stubEnv("PORT", "3107");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const controller = await import("./control-server/controller.ts");
      const url =
        "http://localhost:3107/hot-updater/artifacts/target/from/current";

      expect(
        controller.getHotUpdaterClientRequestHeaders().get("x-api-key"),
      ).toBe("client-access-key");

      await controller.handleProxyUpdateRequest(new Request(url));
      await controller.handleProxyUpdateRequest(
        new Request(url, { headers: { "x-api-key": "app-provided-key" } }),
      );

      expect(observedKeys).toEqual(["client-access-key", "app-provided-key"]);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await fs.rm(resultsDir, { force: true, recursive: true });
    }
  });

  it("captures and replays exact catalog generations without artifact traffic", async () => {
    const resultsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-catalog-proxy-"),
    );
    let generation = 1;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).has("if-none-match")) {
          return new Response(null, {
            headers: {
              "content-type":
                "application/vnd.hot-updater.release-catalog+json;version=1",
              etag: '"catalog-generation-2"',
            },
            status: 304,
          });
        }
        return new Response(
          JSON.stringify({
            authorityId: "provider-project",
            catalogHash: `sha256:${generation.toString().padStart(64, "0")}`,
            fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
            generation,
            releases: [],
            schemaVersion: 1,
            scopeKey: "v1:app-version:provider-project:ios:am9iLXByb2R1Y3Rpb24",
          }),
          {
            headers: {
              "content-type":
                "application/vnd.hot-updater.release-catalog+json;version=1",
            },
          },
        );
      },
    );

    vi.resetModules();
    vi.stubEnv(
      "HOT_UPDATER_E2E_APP_BASE_URL",
      "https://provider.example.com/hot-updater",
    );
    vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "com.hotupdater.example");
    vi.stubEnv("HOT_UPDATER_E2E_CHANNEL_NAMESPACE", "job");
    vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "booted");
    vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", "ios");
    vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", resultsDir);
    vi.stubEnv("PORT", "3107");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const controller = await import("./control-server/controller.ts");
      const url =
        "http://localhost:3107/hot-updater/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0";
      expect(
        await (
          await controller.handleProxyUpdateRequest(new Request(url))
        ).json(),
      ).toMatchObject({
        generation: 1,
        scopeKey: "v1:app-version:provider-project:ios:cHJvZHVjdGlvbg",
      });
      generation = 2;
      expect(
        await (
          await controller.handleProxyUpdateRequest(new Request(url))
        ).json(),
      ).toMatchObject({
        generation: 2,
        scopeKey: "v1:app-version:provider-project:ios:cHJvZHVjdGlvbg",
      });
      const notModifiedResponse = await controller.handleProxyUpdateRequest(
        new Request(url, {
          headers: { "if-none-match": '"catalog-generation-2"' },
        }),
      );
      expect(notModifiedResponse.status).toBe(304);
      expect(await notModifiedResponse.text()).toBe("");

      controller.handleConfigureProxy({
        catalogMode: "replay",
        replayGeneration: 1,
      });
      expect(
        await (
          await controller.handleProxyUpdateRequest(new Request(url))
        ).json(),
      ).toMatchObject({
        generation: 1,
        scopeKey: "v1:app-version:provider-project:ios:cHJvZHVjdGlvbg",
      });
      expect(
        controller.handleAssertProxy({ artifactRequests: 0 }),
      ).toMatchObject({
        pathCardinality: 1,
        requestCounts: { artifact: 0, catalog: 4, legacy: 0 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "https://provider.example.com/hot-updater/release-catalogs/app-version/ios/am9iLXByb2R1Y3Rpb24/1.0.0",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await fs.rm(resultsDir, { force: true, recursive: true });
    }
  });
});
