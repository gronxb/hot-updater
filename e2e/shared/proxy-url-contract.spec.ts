import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const repoDir = path.resolve(__dirname, "../..");
const controllerPath = path.join(
  repoDir,
  "e2e/shared/control-server/controller.ts",
);

describe("E2E remote asset proxy URLs", () => {
  it("does not expose the provider signed URL in the app-visible proxy URL", async () => {
    const controllerSource = await fs.readFile(controllerPath, "utf8");

    expect(controllerSource).not.toContain("/e2e/proxy-url?url=");
    expect(controllerSource).toContain("/e2e/proxy-url/");
  });

  it("rewrites update asset URLs to opaque paths that resolve server-side", async () => {
    const resultsDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-proxy-url-"),
    );
    const signedAssetUrl =
      "https://storage.example.com/assets/example.bmp?Signature=a%2Fb%2B1&Expires=1780876479";
    const signedArchiveUrl =
      "https://storage.example.com/bundles/bundle.tar.br?Signature=archive%2F1&Expires=1780876479";
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
          JSON.stringify(
            url.endsWith("/files")
              ? { files: { "assets/example.bmp": { url: signedAssetUrl } } }
              : {
                  archiveUrl: signedArchiveUrl,
                  artifactProtocolVersion: 2,
                  manifestFileHash: "manifest-hash",
                  manifestUrl: signedManifestUrl,
                  patch: {
                    algorithm: "bsdiff",
                    assetPath: "assets/example.bmp",
                    baseBundleId: "019ea44a-0000-7000-8000-000000000000",
                    patchUrl: signedPatchUrl,
                  },
                },
          ),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      }

      if (
        url === signedArchiveUrl ||
        url === signedAssetUrl ||
        url === signedPatchUrl
      ) {
        return new Response(
          url === signedArchiveUrl
            ? "archive-bytes"
            : url === signedPatchUrl
              ? "patch-bytes"
              : "asset-bytes",
          {
            headers: {
              "content-encoding": "br",
              "content-length": "999",
              "content-type": "application/octet-stream",
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
          "http://localhost:3107/hot-updater/artifacts/v2/target/from/current",
        ),
      );
      const payload = (await updateResponse.json()) as {
        archiveUrl: string;
        manifestUrl: string;
        patch: { patchUrl: string };
      };
      const filesResponse = await controller.handleProxyUpdateRequest(
        new Request(
          "http://localhost:3107/hot-updater/artifacts/v2/target/files",
          {
            body: JSON.stringify({ paths: ["assets/example.bmp"] }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      );
      const files = (await filesResponse.json()) as {
        files: Record<string, { url: string }>;
      };

      expect(payload.manifestUrl).toMatch(
        /^http:\/\/localhost:3107\/e2e\/proxy-url\/[-0-9a-f]+$/,
      );
      expect(payload.archiveUrl).toMatch(
        /^http:\/\/localhost:3107\/e2e\/proxy-url\/[-0-9a-f]+$/,
      );
      const assetUrl = files.files["assets/example.bmp"]?.url;
      expect(assetUrl).toMatch(
        /^http:\/\/localhost:3107\/e2e\/proxy-url\/[-0-9a-f]+$/,
      );
      const patchUrl = payload.patch.patchUrl;
      expect(patchUrl).toMatch(
        /^http:\/\/localhost:3107\/e2e\/proxy-url\/[-0-9a-f]+$/,
      );
      expect(
        controller.handleAssertBundleArtifactSelection({
          currentBundleId: "current",
          selection: "manifest-v2",
          targetBundleId: "target",
        }),
      ).toMatchObject({
        artifactProtocolVersion: 2,
        assetsPresent: false,
        assets: [{ fileUrl: assetUrl, patchUrl, path: "assets/example.bmp" }],
        currentBundleId: "current",
        filesRequests: 1,
        manifestUrlPresent: true,
        targetBundleId: "target",
      });
      const controlRoutes = (await import("./control-server/routes.ts"))
        .default;
      const routeAssertion = await controlRoutes.request(
        "/e2e/assert-bundle-artifact-selection",
        {
          body: JSON.stringify({
            currentBundleId: "current",
            selection: "manifest-v2",
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

      const assetResponse = await controller.handleProxyRemoteAssetRequest(
        new Request(assetUrl),
      );

      expect(assetResponse.status).toBe(200);
      expect(assetResponse.headers.get("content-encoding")).toBeNull();
      expect(assetResponse.headers.get("content-length")).toBeNull();
      expect(assetResponse.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(await assetResponse.text()).toBe("asset-bytes");
      expect(
        controller.handleProxyState().assetTransfers[
          new URL(assetUrl).pathname
        ],
      ).toEqual({ requests: 1, bytes: 11 });
      expect(fetchTargets).toContain(signedAssetUrl);

      const patchResponse = await controller.handleProxyRemoteAssetRequest(
        new Request(patchUrl),
      );

      expect(patchResponse.status).toBe(200);
      expect(await patchResponse.text()).toBe("patch-bytes");
      expect(fetchTargets).toContain(signedPatchUrl);
      expect(
        controller.handleAssertBundleArtifactTransfers({
          archiveRequests: 0,
          currentBundleId: "current",
          fileRequests: 1,
          maxRequestsPerAsset: 2,
          minNetworkAssets: 1,
          patchRequests: 1,
          targetBundleId: "target",
        }),
      ).toMatchObject({
        archive: { bytes: 0, requests: 0 },
        fileRequests: 1,
        networkAssetCount: 1,
        patchRequests: 1,
      });
      expect(controller.handleProxyState().remoteTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            assetPath: "assets/example.bmp",
            bytes: 11,
            kind: "file",
            requests: 1,
          }),
          expect.objectContaining({
            assetPath: "assets/example.bmp",
            bytes: 11,
            kind: "patch",
            requests: 1,
          }),
        ]),
      );
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(resultsDir, "artifact-transfers-target.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        currentBundleId: "current",
        observed: {
          archive: { bytes: 0, requests: 0 },
          fileRequests: 1,
          patchRequests: 1,
        },
        platform: "ios",
        targetBundleId: "target",
      });

      controller.handleConfigureProxy({
        archiveFailureMode: "corrupt",
        archiveFailures: 1,
      });
      const corruptArchiveResponse =
        await controller.handleProxyRemoteAssetRequest(
          new Request(payload.archiveUrl),
        );
      expect(corruptArchiveResponse.status).toBe(200);
      expect(await corruptArchiveResponse.text()).toBe("corrupt tar.br bytes");
      expect(controller.handleProxyState()).toMatchObject({
        archiveFailureMode: "corrupt",
        archiveFailuresRemaining: 0,
      });
      expect(
        controller.handleProxyState().assetTransfers[
          new URL(payload.archiveUrl).pathname
        ],
      ).toEqual({ requests: 1, bytes: 20 });
      expect(fetchTargets).not.toContain(signedArchiveUrl);
      expect(
        controller.handleAssertBundleArtifactTransfers({
          archiveRequests: 1,
          currentBundleId: "current",
          fileRequests: 1,
          maxRequestsPerAsset: 2,
          minNetworkAssets: 1,
          patchRequests: 1,
          targetBundleId: "target",
        }),
      ).toMatchObject({
        archive: { bytes: 20, requests: 1 },
        archiveFailuresRemaining: 0,
      });

      controller.handleConfigureProxy({
        archiveFailureMode: "not-found",
        archiveFailures: 1,
      });
      const missingArchiveResponse =
        await controller.handleProxyRemoteAssetRequest(
          new Request(payload.archiveUrl),
        );
      expect(missingArchiveResponse.status).toBe(404);
      expect(await missingArchiveResponse.text()).toBe(
        "Injected E2E archive 404",
      );
      expect(controller.handleProxyState().archiveFailuresRemaining).toBe(0);

      controller.handleConfigureProxy({
        archiveFailureMode: "interrupt",
        archiveFailures: 1,
        reset: true,
      });
      const resumablePayload = (await (
        await controller.handleProxyUpdateRequest(
          new Request(
            "http://localhost:3107/hot-updater/artifacts/v1/target/from/current",
          ),
        )
      ).json()) as { archiveUrl: string };
      const interruptedArchiveResponse =
        await controller.handleProxyRemoteAssetRequest(
          new Request(resumablePayload.archiveUrl),
        );
      expect(interruptedArchiveResponse.status).toBe(200);
      expect(interruptedArchiveResponse.headers.get("content-length")).toBe(
        "13",
      );
      await expect(interruptedArchiveResponse.text()).rejects.toThrow(
        "Injected E2E archive interruption",
      );
      const resumedArchiveResponse =
        await controller.handleProxyRemoteAssetRequest(
          new Request(resumablePayload.archiveUrl, {
            headers: {
              "if-range": interruptedArchiveResponse.headers.get("etag")!,
              range: "bytes=6-",
            },
          }),
        );
      expect(resumedArchiveResponse.status).toBe(206);
      expect(resumedArchiveResponse.headers.get("content-range")).toBe(
        "bytes 6-12/13",
      );
      expect(await resumedArchiveResponse.text()).toBe("e-bytes");
      expect(controller.handleProxyState()).toMatchObject({
        archiveFailuresRemaining: 0,
        archiveInterruptions: {
          [new URL(resumablePayload.archiveUrl).pathname]: {
            bytes: 13,
            interruptions: 1,
            resumes: 1,
          },
        },
      });
      const resumedWaitJobId = controller.startWaitForArchiveResumeJob();
      await vi.waitFor(() => {
        expect(controller.getJob(resumedWaitJobId)).toMatchObject({
          status: "succeeded",
        });
      });
      const resumedTransfers = {
        archiveInterruptions: 1,
        archiveRequests: 2,
        archiveResumes: 1,
        currentBundleId: "current",
        fileRequests: 0,
        patchRequests: 0,
        targetBundleId: "target",
      };
      expect(
        controller.handleAssertBundleArtifactTransfers(resumedTransfers),
      ).toMatchObject({
        archive: { bytes: 13, requests: 2 },
        archiveInterruption: { bytes: 13, interruptions: 1, resumes: 1 },
      });
      expect(() =>
        controller.handleAssertBundleArtifactTransfers({
          ...resumedTransfers,
          archiveResumes: 0,
        }),
      ).toThrow("Unexpected Bundle artifact transfers");
      // A mismatch is a definite result, so the runner does not quarantine.
      const transferMismatch = await controlRoutes.request(
        "/e2e/assert-bundle-artifact-transfers",
        {
          body: JSON.stringify({ ...resumedTransfers, archiveResumes: 0 }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(transferMismatch.status).toBe(422);

      controller.handleConfigureProxy({ archiveAvailable: false });
      const noArchivePayload = (await (
        await controller.handleProxyUpdateRequest(
          new Request(
            "http://localhost:3107/hot-updater/artifacts/v1/target/from/current",
          ),
        )
      ).json()) as Record<string, unknown>;
      expect(noArchivePayload).not.toHaveProperty("archiveUrl");
      expect(controller.handleProxyState().archiveAvailable).toBe(false);
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
    const archivePath = "/storage/bundles/bundle.tar.br?token=archive%2F1";
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

      if (url === `${baseUrl}/artifacts/v1/target/from/current`) {
        return Response.json({
          archiveUrl: archivePath,
          artifactProtocolVersion: 1,
          assets: {
            "assets/example.bmp": {
              file: { url: assetPath },
              fileHash: "asset-hash",
              patch: {
                algorithm: "bsdiff",
                baseBundleId: "019ea44a-0000-7000-8000-000000000000",
                patchUrl: patchPath,
              },
            },
          },
          manifestFileHash: "manifest-hash",
          manifestUrl: manifestPath,
        });
      }

      if (url === `${baseUrl}${manifestPath}`) {
        return new Response(manifestBytes, {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${baseUrl}${archivePath}`) {
        return new Response("archive-bytes");
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
          "http://localhost:3107/hot-updater/artifacts/v1/target/from/current",
        ),
      );
      const payload = (await updateResponse.json()) as {
        archiveUrl: string;
        assets: Record<
          string,
          { file: { url: string }; patch: { patchUrl: string } }
        >;
        manifestUrl: string;
      };
      const assetUrl = payload.assets["assets/example.bmp"]!.file.url;
      const patchUrl = payload.assets["assets/example.bmp"]!.patch.patchUrl;
      for (const url of [
        payload.archiveUrl,
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
      expect(
        await (
          await controller.handleProxyRemoteAssetRequest(
            new Request(payload.archiveUrl),
          )
        ).text(),
      ).toBe("archive-bytes");

      controller.handleConfigureProxy({ artifactFailures: 1 });
      const failedAssetResponse =
        await controller.handleProxyRemoteAssetRequest(new Request(assetUrl));
      expect(failedAssetResponse.status).toBe(503);
      expect(controller.handleProxyState().artifactFailuresRemaining).toBe(0);
      expect(
        controller.handleProxyState().assetTransfers[
          new URL(assetUrl).pathname
        ],
      ).toEqual({ requests: 1, bytes: 0 });
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
          `${baseUrl}${manifestPath}`,
          `${baseUrl}${archivePath}`,
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

  it("expects exactly the assets two signed manifests differ in, whatever the server selects", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-changed-assets-"),
    );
    const store = path.join(root, "Documents/bundle-store");
    const hash = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const manifests = {
      current: {
        "main.jsbundle": hash("bundle 1"),
        "assets/changed.png": hash("changed 1"),
        "assets/same.png": hash("same"),
      },
      // The bundle and changed.png change, new.png is added, same.png stays.
      target: {
        "main.jsbundle": hash("bundle 2"),
        "assets/changed.png": hash("changed 2"),
        "assets/new.png": hash("new"),
        "assets/same.png": hash("same"),
      },
    };
    for (const id of ["current", "target", "target-extra"] as const) {
      const assets = manifests[id === "current" ? "current" : "target"];
      await fs.mkdir(path.join(store, id), { recursive: true });
      await fs.writeFile(
        path.join(store, id, "manifest.json"),
        JSON.stringify({
          bundleId: id,
          assets: Object.fromEntries(
            Object.entries(assets).map(([key, fileHash]) => [
              key,
              { fileHash },
            ]),
          ),
        }),
      );
    }
    await fs.writeFile(
      path.join(root, "xcrun"),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(root)});\n`,
      { mode: 0o755 },
    );
    const baseUrl = "https://provider.example.com/hot-updater";
    const selection = (target: string, paths: string[]) => ({
      artifactProtocolVersion: 1,
      assets: Object.fromEntries(
        paths.map((assetPath) => [
          assetPath,
          {
            file: { url: `/storage/${target}/${assetPath}` },
            fileHash: "unused",
            ...(assetPath === "main.jsbundle"
              ? {
                  patch: {
                    algorithm: "bsdiff",
                    baseBundleId: "current",
                    patchUrl: `/storage/${target}/main.jsbundle.bsdiff`,
                  },
                }
              : {}),
          },
        ]),
      ),
      manifestFileHash: "manifest-hash",
      manifestUrl: `/storage/${target}/manifest.json`,
    });
    const changed = ["main.jsbundle", "assets/changed.png", "assets/new.png"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const match =
          /^\/hot-updater\/artifacts\/v1\/([^/]+)\/from\/current$/.exec(
            url.pathname,
          );
        if (match?.[1] === "target")
          return Response.json(selection("target", changed));
        if (match?.[1] === "target-extra") {
          return Response.json(
            selection("target-extra", [...changed, "assets/same.png"]),
          );
        }
        return new Response("bytes");
      }),
    );
    vi.resetModules();
    vi.stubEnv("HOT_UPDATER_E2E_APP_BASE_URL", baseUrl);
    vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "com.hotupdater.example");
    vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "test-simulator");
    vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", "ios");
    vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", root);
    vi.stubEnv("PATH", `${root}:${process.env.PATH ?? ""}`);
    vi.stubEnv("PORT", "3107");
    try {
      const controller = await import("./control-server/controller.ts");
      // One artifact request per target, as the client makes; then the
      // asset downloads it chooses, each read to the end.
      const select = async (target: string) => {
        const payload = (await (
          await controller.handleProxyUpdateRequest(
            new Request(
              `http://localhost:3107/hot-updater/artifacts/v1/${target}/from/current`,
            ),
          )
        ).json()) as {
          assets: Record<
            string,
            { file: { url: string }; patch?: { patchUrl: string } }
          >;
        };
        return async (paths: string[]) => {
          for (const assetPath of paths) {
            const asset = payload.assets[assetPath]!;
            await (
              await controller.handleProxyRemoteAssetRequest(
                new Request(asset.patch?.patchUrl ?? asset.file.url),
              )
            ).text();
          }
        };
      };
      const expectation = {
        archiveRequests: 0,
        currentBundleId: "current",
        fileRequests: "changed-assets" as const,
        maxRequestsPerAsset: 1,
        patchRequests: 1,
        targetBundleId: "target",
      };

      // The client skips new.png: one changed asset is missing.
      const download = await select("target");
      await download(["main.jsbundle", "assets/changed.png"]);
      expect(() =>
        controller.handleAssertBundleArtifactTransfers(expectation),
      ).toThrow("Unexpected Bundle artifact transfers");

      await download(["assets/new.png"]);
      expect(
        controller.handleAssertBundleArtifactTransfers(expectation),
      ).toMatchObject({
        changedAssetPaths: changed,
        expectedFileRequests: 2,
        fileRequests: 2,
        patchRequests: 1,
      });

      // The server also selects same.png, which no manifest changed. The
      // client downloads only the changed assets, so only the selection is
      // wrong.
      await (await select("target-extra"))(changed);
      expect(() =>
        controller.handleAssertBundleArtifactTransfers({
          ...expectation,
          targetBundleId: "target-extra",
        }),
      ).toThrow("Unexpected Bundle artifact transfers");

      // Without the current Bundle's manifest there is nothing to compare.
      await fs.rm(path.join(store, "current"), { recursive: true });
      expect(() =>
        controller.handleAssertBundleArtifactTransfers(expectation),
      ).toThrow("A Bundle manifest to compare is missing");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await fs.rm(root, { force: true, recursive: true });
    }
  }, 30_000);

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
        "http://localhost:3107/hot-updater/artifacts/v1/target/from/current";

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
        requestCounts: { artifact: 0, catalog: 4, other: 0 },
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

describe("E2E installed asset evidence", () => {
  it.each(["ios", "android"])(
    "reports manifest-matching installed files on %s",
    async (platform) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "hot-updater-installed-assets-"),
      );
      const bundleId = "installed-bundle";
      const assetPath = "assets/image.png";
      const bundleDir = path.join(
        root,
        platform === "ios" ? "Documents/bundle-store" : "bundle-store",
        bundleId,
      );
      const bytes =
        platform === "android"
          ? Buffer.alloc(3 * 1024 * 1024, 42)
          : Buffer.from("installed image bytes");
      await fs.mkdir(path.join(bundleDir, "assets"), { recursive: true });
      await fs.writeFile(path.join(bundleDir, assetPath), bytes);
      await fs.writeFile(
        path.join(bundleDir, "manifest.json"),
        JSON.stringify({
          bundleId,
          assets: {
            [assetPath]: {
              fileHash: createHash("sha256").update(bytes).digest("hex"),
            },
          },
        }),
      );
      const command = path.join(root, platform === "ios" ? "xcrun" : "adb");
      const fakeDevice =
        platform === "ios"
          ? `process.stdout.write(${JSON.stringify(root)});`
          : `const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2);
const relative = args.at(-1).split("/files/").at(-1).replace("files/", "");
const file = path.join(${JSON.stringify(root)}, relative);
if (args.includes("cat")) process.stdout.write(fs.readFileSync(file));
else process.exit(fs.existsSync(file) ? 0 : 1);`;
      await fs.writeFile(command, `#!/usr/bin/env node\n${fakeDevice}\n`);
      await fs.chmod(command, 0o755);

      vi.resetModules();
      vi.stubEnv(
        "HOT_UPDATER_E2E_APP_BASE_URL",
        "https://provider.example.com/hot-updater",
      );
      vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "com.hotupdater.example");
      vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "test-simulator");
      vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", platform);
      vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", root);
      vi.stubEnv("PATH", `${root}:${process.env.PATH ?? ""}`);
      vi.stubEnv("PORT", "3107");
      try {
        const controller = await import("./control-server/controller.ts");
        await expect(
          controller.handleAssertBundleAssetsStored({
            bundleId,
            assetPaths: [assetPath],
          }),
        ).resolves.toEqual({});
      } finally {
        vi.unstubAllEnvs();
        await fs.rm(root, { force: true, recursive: true });
      }
    },
    30_000,
  );
});
