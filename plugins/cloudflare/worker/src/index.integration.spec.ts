import {
  type AppUpdateInfo,
  type GetBundlesArgs,
  type LegacyBundle as Bundle,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import { createHotUpdater } from "@hot-updater/server";
import {
  setupBsdiffManifestUpdateInfoTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

import { d1Database } from "../../src/worker";
import worker, { HOT_UPDATER_BASE_PATH } from "./index";

declare module "vitest" {
  export interface ProvidedContext {
    prepareSql: string;
  }
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    AUTHORITY_ID: string;
    BUCKET: R2Bucket;
    BUCKET_NAME: string;
    STORAGE_DOWNLOAD_URL_SIGNING_KEY: string;
  }
}

const PUBLIC_BASE_URL = "https://updates.example.com";

const toRuntimeBundle = (bundle: Bundle): Bundle => {
  return {
    ...bundle,
    storageUri: `r2://${env.BUCKET_NAME}/${bundle.id}/bundle.zip`,
  };
};

const seedBundles = async (bundles: Bundle[]) => {
  const seedHotUpdater = createHotUpdater({
    authorityId: env.AUTHORITY_ID,
    database: d1Database(env.DB),
  });
  for (const bundle of bundles.map(toRuntimeBundle)) {
    const existing = await seedHotUpdater.getBundleById(bundle.id);
    if (existing === null) {
      await seedHotUpdater.insertBundle(bundle);
    } else {
      await seedHotUpdater.updateBundleById(bundle.id, bundle);
    }
  }
};

const putR2Object = async (key: string, value: string, contentType: string) => {
  await env.BUCKET.put(key, value, {
    httpMetadata: {
      contentType,
    },
  });
};

const createCanonicalPath = (args: GetBundlesArgs) => {
  const channel = args.channel ?? "production";
  const minBundleId = args.minBundleId ?? NIL_UUID;
  const cohortSegment = args.cohort
    ? `/${encodeURIComponent(args.cohort)}`
    : "";

  if (args._updateStrategy === "appVersion") {
    return `${HOT_UPDATER_BASE_PATH}/app-version/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.appVersion)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
  }

  return `${HOT_UPDATER_BASE_PATH}/fingerprint/${encodeURIComponent(args.platform)}/${encodeURIComponent(args.fingerprintHash)}/${encodeURIComponent(channel)}/${encodeURIComponent(minBundleId)}/${encodeURIComponent(args.bundleId)}${cohortSegment}`;
};

describe.sequential("cloudflare worker runtime acceptance", () => {
  beforeAll(async () => {
    await env.DB.prepare(inject("prepareSql")).run();
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bundle_patches").run();
    await env.DB.prepare("DELETE FROM release_catalogs").run();
    await env.DB.prepare("DELETE FROM releases").run();
    await env.DB.prepare("DELETE FROM bundles").run();
    await env.DB.prepare("DELETE FROM channels").run();
  });

  const requestUpdateInfo = async (args: GetBundlesArgs) => {
    const response = await worker.fetch(
      new Request(`${PUBLIC_BASE_URL}${createCanonicalPath(args)}`),
      env,
    );

    return response.json() as Promise<UpdateInfo | AppUpdateInfo | null>;
  };

  const getUpdateInfo = async (bundles: Bundle[], args: GetBundlesArgs) => {
    await seedBundles(bundles);

    return requestUpdateInfo(args);
  };

  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
    manifestArtifacts: {
      prepareArtifacts: async (fixture) => {
        await Promise.all([
          putR2Object(
            `${fixture.currentBundleId}/manifest.json`,
            JSON.stringify(fixture.currentManifest),
            "application/json",
          ),
          putR2Object(
            `${fixture.nextBundleId}/manifest.json`,
            JSON.stringify(fixture.nextManifest),
            "application/json",
          ),
        ]);

        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>(async () => {
            return new Response("worker subrequest failed", { status: 502 });
          }),
        );

        return {
          cleanup: () => {
            vi.unstubAllGlobals();
          },
          currentArtifacts: {
            assetBaseStorageUri: `r2://${env.BUCKET_NAME}/${fixture.currentBundleId}/files`,
            manifestFileHash: "sig:manifest-current",
            manifestStorageUri: `r2://${env.BUCKET_NAME}/${fixture.currentBundleId}/manifest.json`,
          },
          nextArtifacts: {
            assetBaseStorageUri: `r2://${env.BUCKET_NAME}/${fixture.nextBundleId}/files`,
            manifestFileHash: "sig:manifest-next",
            manifestStorageUri: `r2://${env.BUCKET_NAME}/${fixture.nextBundleId}/manifest.json`,
          },
        };
      },
      expectFileUrl: (fileUrl) => {
        expect(fileUrl).toContain(`${HOT_UPDATER_BASE_PATH}/storage/`);
      },
      expectManifestUrl: (manifestUrl) => {
        expect(manifestUrl).toContain(`${HOT_UPDATER_BASE_PATH}/storage/`);
      },
    },
  });

  setupBsdiffManifestUpdateInfoTestSuite({
    seedBundles,
    getUpdateInfo: requestUpdateInfo,
    prepareArtifacts: async (fixture) => {
      await Promise.all([
        putR2Object(
          `${fixture.currentBundleId}/manifest.json`,
          JSON.stringify(fixture.currentManifest),
          "application/json",
        ),
        putR2Object(
          `${fixture.nextBundleId}/manifest.json`,
          JSON.stringify(fixture.nextManifest),
          "application/json",
        ),
        putR2Object(
          fixture.patchPath,
          "patch-bytes",
          "application/octet-stream",
        ),
        putR2Object(
          `${fixture.currentBundleId}/bundle.zip`,
          "zip",
          "application/zip",
        ),
        putR2Object(
          `${fixture.nextBundleId}/bundle.zip`,
          "zip",
          "application/zip",
        ),
      ]);

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => {
          return new Response("worker subrequest failed", { status: 502 });
        }),
      );

      return {
        cleanup: () => {
          vi.unstubAllGlobals();
        },
        currentArtifacts: {
          assetBaseStorageUri: `r2://${env.BUCKET_NAME}/${fixture.currentBundleId}/files`,
          manifestFileHash: "sig:manifest-current",
          manifestStorageUri: `r2://${env.BUCKET_NAME}/${fixture.currentBundleId}/manifest.json`,
        },
        nextArtifacts: {
          assetBaseStorageUri: `r2://${env.BUCKET_NAME}/${fixture.nextBundleId}/files`,
          manifestFileHash: "sig:manifest-next",
          manifestStorageUri: `r2://${env.BUCKET_NAME}/${fixture.nextBundleId}/manifest.json`,
          patches: [
            {
              baseBundleId: fixture.currentBundleId,
              baseFileHash: "hash-old-bundle",
              patchFileHash: "hash-bsdiff",
              patchStorageUri: `r2://${env.BUCKET_NAME}/${fixture.patchPath}`,
            },
          ],
        },
      };
    },
    expectPatchUrl: (patchUrl) => {
      expect(patchUrl).toContain(`${HOT_UPDATER_BASE_PATH}/storage/`);
    },
  });

  it("serves canonical routes from the worker entrypoint", async () => {
    await seedBundles([
      {
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash",
        gitCommitHash: null,
        message: "hello",
        channel: "production",
        storageUri: "storage://unused",
        fingerprintHash: null,
      },
    ]);

    const response = await worker.fetch(
      new Request(
        `${PUBLIC_BASE_URL}${createCanonicalPath({
          appVersion: "1.0",
          bundleId: NIL_UUID,
          platform: "ios",
          _updateStrategy: "appVersion",
        })}`,
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      id: "00000000-0000-0000-0000-000000000001",
      status: "UPDATE",
    });
  });

  it("does not support the legacy exact path", async () => {
    const response = await worker.fetch(
      new Request(`${PUBLIC_BASE_URL}${HOT_UPDATER_BASE_PATH}`),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Not found",
    });
  });

  it("does not expose management routes from the worker entrypoint", async () => {
    const response = await worker.fetch(
      new Request(`${PUBLIC_BASE_URL}${HOT_UPDATER_BASE_PATH}/api/bundles`),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Not found",
    });
  });
});
