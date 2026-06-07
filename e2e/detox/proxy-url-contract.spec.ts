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
              },
            },
            fileUrl: signedBundleUrl,
            id: "019ea44b-1360-7be6-b475-d67441755828",
            manifestUrl: signedManifestUrl,
            status: "UPDATE",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      }

      if (url === signedBundleUrl) {
        return new Response("bundle-bytes", { status: 200 });
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
          "http://localhost:3107/hot-updater/app-version/ios/1.0/production/min/current",
        ),
      );
      const payload = (await updateResponse.json()) as {
        changedAssets: Record<string, { file: { url: string } }>;
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

      const assetResponse = await controller.handleProxyRemoteAssetRequest(
        new Request(payload.fileUrl),
      );

      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toBe("bundle-bytes");
      expect(fetchTargets).toContain(signedBundleUrl);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await fs.rm(resultsDir, { force: true, recursive: true });
    }
  });
});
