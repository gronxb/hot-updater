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

  it("omits stale Content-Length from rewritten catalog and artifact JSON", async () => {
    const resultsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-proxy-length-"),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const payload = url.includes("/release-catalogs/")
        ? {
            catalogId: "provider-project",
            catalogHash: `sha256:${"a".repeat(64)}`,
            fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
            generation: 1,
            releases: [],
            schemaVersion: 1,
            scopeKey: "provider-scope",
          }
        : {
            fileHash: "archive-hash",
            fileUrl: "https://storage.example.com/bundle.zip",
          };
      return new Response(JSON.stringify(payload), {
        headers: {
          "content-length": "1",
          "content-type": "application/json",
        },
      });
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
      const catalogResponse = await controller.handleProxyUpdateRequest(
        new Request(
          "http://localhost:3107/hot-updater/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0",
        ),
      );
      const artifactResponse = await controller.handleProxyUpdateRequest(
        new Request(
          "http://localhost:3107/hot-updater/artifacts/target/from/current",
        ),
      );

      expect(catalogResponse.headers.get("content-length")).toBeNull();
      expect(artifactResponse.headers.get("content-length")).toBeNull();
      await expect(catalogResponse.json()).resolves.toMatchObject({
        scopeKey: "v1:app-version:ios:cHJvZHVjdGlvbg",
      });
      await expect(artifactResponse.json()).resolves.toMatchObject({
        fileUrl: expect.stringContaining("/e2e/proxy-url/"),
      });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await fs.rm(resultsDir, { force: true, recursive: true });
    }
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
        if (url.endsWith("/artifacts/archive-target/from/current")) {
          return Response.json({
            fileHash: "archive-hash",
            fileUrl: signedBundleUrl,
          });
        }
        return new Response(
          JSON.stringify({
            changedAssets: {
              "assets/example.bmp": {
                file: { url: signedBundleUrl },
                fileHash: "asset-target-hash",
                patch: {
                  algorithm: "bsdiff",
                  baseBundleId: "019ea44a-0000-7000-8000-000000000000",
                  baseFileHash: "asset-base-hash",
                  patchFileHash: "asset-patch-hash",
                  patchUrl: signedPatchUrl,
                },
              },
            },
            fileUrl: signedBundleUrl,
            manifestFileHash: "manifest-hash",
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
      expect(
        controller.handleAssertBundleArtifactSelection({
          currentBundleId: "current",
          requiredPatchAssetPaths: ["assets/example.bmp"],
          selection: "manifest-diff",
          targetBundleId: "target",
        }),
      ).toMatchObject({
        changedAssetCount: 1,
        changedAssetFilePaths: ["assets/example.bmp"],
        changedAssetPatchPaths: ["assets/example.bmp"],
        changedAssetsPresent: true,
        currentBundleId: "current",
        manifestUrlPresent: true,
        targetBundleId: "target",
      });
      expect(() =>
        controller.handleAssertBundleArtifactSelection({
          currentBundleId: "current",
          requiredRawAssetPaths: ["assets/example.bmp"],
          selection: "manifest-diff",
          targetBundleId: "target",
        }),
      ).toThrow("Required raw-only asset was not observed");
      expect(() =>
        controller.handleAssertBundleArtifactSelection({
          currentBundleId: "current",
          requireArchiveAbsent: true,
          selection: "manifest-diff",
          targetBundleId: "target",
        }),
      ).toThrow("Delta selection retained an archive fallback");
      expect(() =>
        controller.handleAssertBundleArtifactSelection({
          currentBundleId: "current",
          selection: "archive-only",
          targetBundleId: "target",
        }),
      ).toThrow("Unexpected Bundle artifact selection");
      const controlRoutes = (await import("./control-server/routes.ts"))
        .default;
      const routeAssertion = await controlRoutes.request(
        "/e2e/assert-bundle-artifact-selection",
        {
          body: JSON.stringify({
            currentBundleId: "current",
            selection: "manifest-diff",
            targetBundleId: "target",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(routeAssertion.status).toBe(200);
      expect(await routeAssertion.json()).toMatchObject({
        currentBundleId: "current",
        targetBundleId: "target",
      });
      const changedAssetMutation = await controlRoutes.request(
        "/e2e/proxy-control",
        {
          body: JSON.stringify({
            changedAssetMutation: {
              assetPath: "detail.lynx.bundle",
              mode: "corrupt",
              remaining: 1,
            },
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(changedAssetMutation.status).toBe(200);
      expect(await changedAssetMutation.json()).toMatchObject({
        changedAssetMutation: {
          assetPath: "detail.lynx.bundle",
          mode: "corrupt",
          remaining: 1,
        },
      });
      const invalidChangedAssetMutation = await controlRoutes.request(
        "/e2e/proxy-control",
        {
          body: JSON.stringify({
            changedAssetMutation: {
              assetPath: "main.lynx.bundle",
              mode: "corrupt",
              remaining: 1,
            },
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(invalidChangedAssetMutation.status).toBe(400);
      const invalidRouteAssertion = await controlRoutes.request(
        "/e2e/assert-bundle-artifact-selection",
        {
          body: JSON.stringify({
            currentBundleId: "current",
            selection: "unknown",
            targetBundleId: "target",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(invalidRouteAssertion.status).toBe(400);
      const sizeAwareProfileValidation = await controlRoutes.request(
        "/e2e/jobs/deploy-bundle",
        {
          body: JSON.stringify({
            bundleProfile: "sizeAwareLargeDiff",
            channel: "production",
            marker: "size-aware-route-contract",
            mode: "reset",
            patchMaxBaseBundles: 0,
            safeBundleIds: [],
            targetAppVersion: "1.0.x",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(sizeAwareProfileValidation.status).toBe(400);
      expect(await sizeAwareProfileValidation.json()).toEqual({
        error: "patchMaxBaseBundles must be an integer between 1 and 5",
      });
      const crossProvenanceValidation = await controlRoutes.request(
        "/e2e/jobs/deploy-bundle",
        {
          body: JSON.stringify({
            channel: "production",
            crossProvenance: "arbitrary-runtime-id",
            marker: "cross-provenance-route-contract",
            mode: "reset",
            safeBundleIds: [],
            targetAppVersion: "1.0.x",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(crossProvenanceValidation.status).toBe(400);
      expect(await crossProvenanceValidation.json()).toEqual({
        error: "crossProvenance must be a boolean",
      });

      await controller.handleProxyUpdateRequest(
        new Request(
          "http://localhost:3107/hot-updater/artifacts/archive-target/from/current",
        ),
      );
      expect(
        controller.handleAssertBundleArtifactSelection({
          currentBundleId: "current",
          selection: "archive-only",
          targetBundleId: "archive-target",
        }),
      ).toMatchObject({
        changedAssetsPresent: false,
        currentBundleId: "current",
        fileUrlPresent: true,
        manifestFileHashPresent: false,
        manifestUrlPresent: false,
        targetBundleId: "archive-target",
      });
      await expect(
        controller.handleAssertManifestDiffApplied({
          bundleId: "archive-target",
          previousBundleId: "current",
        }),
      ).resolves.toEqual({ selection: "archive-only", skipped: true });

      controller.handleConfigureProxy({ reset: true });
      expect(() =>
        controller.handleAssertBundleArtifactSelection({
          currentBundleId: "current",
          selection: "archive-only",
          targetBundleId: "archive-target",
        }),
      ).toThrow("Bundle artifact request was not observed");

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
            "detail.lynx.bundle": {
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
      const assetUrl = payload.changedAssets["detail.lynx.bundle"]!.file.url;
      const patchUrl =
        payload.changedAssets["detail.lynx.bundle"]!.patch.patchUrl;
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

      controller.handleConfigureProxy({
        changedAssetMutation: {
          assetPath: "detail.lynx.bundle",
          mode: "corrupt",
          remaining: 1,
        },
      });
      expect(
        await (
          await controller.handleProxyRemoteAssetRequest(new Request(assetUrl))
        ).text(),
      ).toBe("corrupt changed asset bytes");
      expect(controller.handleProxyState().changedAssetMutation).toMatchObject({
        remaining: 0,
      });

      controller.handleConfigureProxy({
        changedAssetMutation: {
          assetPath: "detail.lynx.bundle",
          mode: "missing",
          remaining: 1,
        },
      });
      const missingDetail = await controller.handleProxyRemoteAssetRequest(
        new Request(assetUrl),
      );
      expect(missingDetail.status).toBe(404);

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

  it("requires consistent artifact captures before skipping manifest reuse", async () => {
    const resultsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-selection-history-"),
    );
    let artifactPayload: unknown;
    const fetchMock = vi.fn(async () => Response.json(artifactPayload));
    const archiveOnly = {
      fileHash: "archive-hash",
      fileUrl: "https://storage.example.com/bundle.zip",
    };
    const manifestDiff = {
      changedAssets: {
        "main.bundle": {
          file: null,
          fileHash: "main-target-hash",
          patch: {
            algorithm: "bsdiff",
            baseBundleId: "base-bundle",
            baseFileHash: "main-base-hash",
            patchFileHash: "main-patch-hash",
            patchUrl: "https://storage.example.com/main.patch?token=one",
          },
        },
        "metadata.json": {
          file: {
            compression: null,
            url: "https://storage.example.com/metadata.json?token=one",
          },
          fileHash: "metadata-target-hash",
          patch: null,
        },
      },
      fileHash: "archive-hash",
      fileUrl: "https://storage.example.com/archive.zip?token=one",
      manifestFileHash: "manifest-hash",
      manifestUrl: "https://storage.example.com/manifest.json?token=one",
      patchAssetPath: "main.bundle",
    };

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
      const artifactUrl =
        "http://localhost:3107/hot-updater/artifacts/target/from/current";
      const capture = async (payload: unknown) => {
        artifactPayload = payload;
        const response = await controller.handleProxyUpdateRequest(
          new Request(artifactUrl),
        );
        expect(response.status).toBe(200);
      };
      const assertManifestDiff = () =>
        controller.handleAssertManifestDiffApplied({
          bundleId: "target",
          previousBundleId: "current",
        });
      const assertManifestConflict = async (mutate: (payload: any) => void) => {
        const changed = structuredClone(manifestDiff);
        mutate(changed);
        controller.handleConfigureProxy({ reset: true });
        await capture(manifestDiff);
        await capture(changed);
        await expect(assertManifestDiff()).rejects.toThrow(
          "Unexpected Bundle artifact selection",
        );
      };

      for (const captures of [
        [archiveOnly, manifestDiff],
        [manifestDiff, archiveOnly],
      ]) {
        controller.handleConfigureProxy({ reset: true });
        for (const payload of captures) await capture(payload);
        await expect(assertManifestDiff()).rejects.toThrow(
          "Unexpected Bundle artifact selection",
        );
      }

      controller.handleConfigureProxy({ reset: true });
      await capture(archiveOnly);
      await capture(archiveOnly);
      await expect(assertManifestDiff()).resolves.toEqual({
        selection: "archive-only",
        skipped: true,
      });

      controller.handleConfigureProxy({ reset: true });
      await capture(manifestDiff);
      await capture(manifestDiff);
      const strictPath = new AbortController();
      strictPath.abort(new Error("strict manifest assertion reached"));
      await expect(
        controller.handleAssertManifestDiffApplied({
          bundleId: "target",
          previousBundleId: "current",
          signal: strictPath.signal,
        }),
      ).rejects.toThrow(
        "Control job cancelled: strict manifest assertion reached",
      );

      for (const mutate of [
        (payload: any) => (payload.manifestFileHash = "other-manifest-hash"),
        (payload: any) =>
          (payload.changedAssets["metadata.json"].fileHash =
            "other-asset-hash"),
        (payload: any) =>
          (payload.changedAssets["main.bundle"].patch.patchFileHash =
            "other-patch-hash"),
        (payload: any) =>
          (payload.changedAssets["main.bundle"].patch.algorithm = "other"),
        (payload: any) =>
          (payload.changedAssets["main.bundle"].patch.baseBundleId =
            "other-base-bundle"),
      ]) {
        await assertManifestConflict(mutate);
      }

      controller.handleConfigureProxy({ reset: true });
      await capture(archiveOnly);
      await capture({ ...archiveOnly, fileHash: "other-archive-hash" });
      await expect(assertManifestDiff()).rejects.toThrow(
        "Unexpected Bundle artifact selection",
      );

      for (const changedAssets of [
        {
          "main.bundle": {
            file: {},
            fileHash: "main-target-hash",
            patch: null,
          },
        },
        {
          "main.bundle": {
            file: null,
            fileHash: "main-target-hash",
            patch: {
              algorithm: "bsdiff",
              baseBundleId: "base-bundle",
              baseFileHash: "main-base-hash",
              patchUrl: "https://storage.example.com/main.patch",
            },
          },
        },
      ]) {
        controller.handleConfigureProxy({ reset: true });
        await capture({ ...manifestDiff, changedAssets });
        await expect(assertManifestDiff()).rejects.toThrow(
          "Unexpected Bundle artifact selection",
        );
      }

      controller.handleConfigureProxy({ reset: true });
      await capture(manifestDiff);
      await capture({
        ...manifestDiff,
        changedAssets: {
          ...manifestDiff.changedAssets,
          "main.bundle": {
            ...manifestDiff.changedAssets["main.bundle"],
            patch: {
              ...manifestDiff.changedAssets["main.bundle"].patch,
              patchUrl: "https://renewed.example.com/main.patch?token=two",
            },
          },
          "metadata.json": {
            ...manifestDiff.changedAssets["metadata.json"],
            file: {
              ...manifestDiff.changedAssets["metadata.json"].file,
              url: "https://renewed.example.com/metadata.json?token=two",
            },
          },
        },
        fileUrl: "https://renewed.example.com/archive.zip?token=two",
        manifestUrl: "https://renewed.example.com/manifest.json?token=two",
      });
      await expect(
        controller.handleAssertManifestDiffApplied({
          bundleId: "target",
          previousBundleId: "current",
          signal: strictPath.signal,
        }),
      ).rejects.toThrow(
        "Control job cancelled: strict manifest assertion reached",
      );

      controller.handleConfigureProxy({ reset: true });
      await capture({
        changedAssets: {},
        manifestFileHash: "manifest-hash",
        manifestUrl: "https://storage.example.com/manifest.json",
      });
      await expect(assertManifestDiff()).rejects.toThrow(
        "Unexpected Bundle artifact selection",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await fs.rm(resultsDir, { force: true, recursive: true });
    }
  });

  it("uses the API key for direct and proxied update requests", async () => {
    const resultsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-api-key-proxy-"),
    );
    const observedKeys: Array<string | null> = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedKeys.push(new Headers(init?.headers).get("x-api-key"));
        return Response.json({ status: "NO_UPDATE" });
      },
    );

    vi.resetModules();
    vi.stubEnv("HOT_UPDATER_API_KEY", "api-key");
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
      ).toBe("api-key");

      await controller.handleProxyUpdateRequest(new Request(url));
      await controller.handleProxyUpdateRequest(
        new Request(url, { headers: { "x-api-key": "app-provided-key" } }),
      );

      expect(observedKeys).toEqual(["api-key", "app-provided-key"]);
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
            catalogId: "provider-project",
            catalogHash: `sha256:${generation.toString().padStart(64, "0")}`,
            fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
            generation,
            releases: [],
            schemaVersion: 1,
            scopeKey: "v1:app-version:ios:am9iLXByb2R1Y3Rpb24",
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
        scopeKey: "v1:app-version:ios:cHJvZHVjdGlvbg",
      });
      generation = 2;
      expect(
        await (
          await controller.handleProxyUpdateRequest(new Request(url))
        ).json(),
      ).toMatchObject({
        generation: 2,
        scopeKey: "v1:app-version:ios:cHJvZHVjdGlvbg",
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
        scopeKey: "v1:app-version:ios:cHJvZHVjdGlvbg",
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
