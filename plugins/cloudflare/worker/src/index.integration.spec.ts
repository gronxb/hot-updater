import { type Bundle, type GetBundlesArgs, NIL_UUID } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
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

import worker, { HOT_UPDATER_BASE_PATH } from "./index";

declare module "vitest" {
  export interface ProvidedContext {
    prepareSql: string;
  }
}

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    BUCKET: R2Bucket;
    JWT_SECRET: string;
  }
}

const PUBLIC_BASE_URL = "https://updates.example.com";

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const createInsertBundleQuery = (bundle: Bundle) => {
  const rolloutCohortCount = bundle.rolloutCohortCount ?? 1000;
  const targetCohorts = bundle.targetCohorts
    ? sqlString(JSON.stringify(bundle.targetCohorts))
    : "null";
  const metadata = sqlString(JSON.stringify(bundle.metadata ?? {}));

  return `
    INSERT INTO bundles (
      id, file_hash, platform, target_app_version,
      should_force_update, enabled, git_commit_hash, message, channel,
      storage_uri, fingerprint_hash, metadata, rollout_cohort_count,
      target_cohorts
    ) VALUES (
      ${sqlString(bundle.id)},
      ${sqlString(bundle.fileHash)},
      ${sqlString(bundle.platform)},
      ${bundle.targetAppVersion ? sqlString(bundle.targetAppVersion) : "null"},
      ${bundle.shouldForceUpdate},
      ${bundle.enabled},
      ${bundle.gitCommitHash ? sqlString(bundle.gitCommitHash) : "null"},
      ${bundle.message ? sqlString(bundle.message) : "null"},
      ${sqlString(bundle.channel)},
      ${bundle.storageUri ? sqlString(bundle.storageUri) : "null"},
      ${bundle.fingerprintHash ? sqlString(bundle.fingerprintHash) : "null"},
      ${metadata},
      ${rolloutCohortCount},
      ${targetCohorts}
    ) ON CONFLICT(id) DO UPDATE SET
      file_hash = excluded.file_hash,
      platform = excluded.platform,
      target_app_version = excluded.target_app_version,
      should_force_update = excluded.should_force_update,
      enabled = excluded.enabled,
      git_commit_hash = excluded.git_commit_hash,
      message = excluded.message,
      channel = excluded.channel,
      storage_uri = excluded.storage_uri,
      fingerprint_hash = excluded.fingerprint_hash,
      metadata = excluded.metadata,
      rollout_cohort_count = excluded.rollout_cohort_count,
      target_cohorts = excluded.target_cohorts;
  `;
};

const toRuntimeBundle = (bundle: Bundle): Bundle => {
  return {
    ...bundle,
    storageUri: `r2://bundles/${bundle.id}/bundle.zip`,
  };
};

const seedBundles = async (bundles: Bundle[]) => {
  for (const bundle of bundles.map(toRuntimeBundle)) {
    await env.DB.prepare(createInsertBundleQuery(bundle)).run();
  }
};

const createManifest = (bundleId: string, hbcHash: string) => ({
  assets: {
    "assets/logo.png": {
      fileHash: "hash-logo",
    },
    "index.ios.bundle": {
      fileHash: hbcHash,
    },
  },
  bundleId,
});

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
    await env.DB.prepare("DELETE FROM bundles").run();
  });

  const getUpdateInfo = async (bundles: Bundle[], args: GetBundlesArgs) => {
    await seedBundles(bundles);

    const response = await worker.fetch(
      new Request(`${PUBLIC_BASE_URL}${createCanonicalPath(args)}`),
      env,
    );

    return (await response.json()) as any;
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });

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

  it("returns manifest metadata and bsdiff patch descriptors from the worker entrypoint", async () => {
    const currentBundleId = "00000000-0000-0000-0000-000000000201";
    const nextBundleId = "00000000-0000-0000-0000-000000000202";

    await Promise.all([
      putR2Object(
        `${nextBundleId}/patches/${currentBundleId}/index.ios.bundle.bsdiff`,
        "patch-bytes",
        "application/octet-stream",
      ),
      putR2Object(`${currentBundleId}/bundle.zip`, "zip", "application/zip"),
      putR2Object(`${nextBundleId}/bundle.zip`, "zip", "application/zip"),
    ]);

    await seedBundles([
      {
        id: currentBundleId,
        platform: "ios",
        targetAppVersion: "1.0.0",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-current-zip",
        gitCommitHash: null,
        message: "current",
        channel: "production",
        storageUri: "storage://unused",
        fingerprintHash: null,
        metadata: {
          asset_base_storage_uri: `r2://bundles/${currentBundleId}/files`,
          manifest_file_hash: "sig:manifest-current",
          manifest_storage_uri: `https://manifest-fixtures.example.com/${currentBundleId}/manifest.json`,
        },
      },
      {
        id: nextBundleId,
        platform: "ios",
        targetAppVersion: "1.0.0",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-next-zip",
        gitCommitHash: null,
        message: "next",
        channel: "production",
        storageUri: "storage://unused",
        fingerprintHash: null,
        metadata: {
          asset_base_storage_uri: `r2://bundles/${nextBundleId}/files`,
          diff_base_bundle_id: currentBundleId,
          hbc_patch_algorithm: "bsdiff",
          hbc_patch_asset_path: "index.ios.bundle",
          hbc_patch_base_file_hash: "hash-old-bundle",
          hbc_patch_file_hash: "hash-bsdiff",
          hbc_patch_storage_uri: `r2://bundles/${nextBundleId}/patches/${currentBundleId}/index.ios.bundle.bsdiff`,
          manifest_file_hash: "sig:manifest-next",
          manifest_storage_uri: `https://manifest-fixtures.example.com/${nextBundleId}/manifest.json`,
        },
      },
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);

        if (url.endsWith(`${currentBundleId}/manifest.json`)) {
          return new Response(
            JSON.stringify(createManifest(currentBundleId, "hash-old-bundle")),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (url.endsWith(`${nextBundleId}/manifest.json`)) {
          return new Response(
            JSON.stringify(createManifest(nextBundleId, "hash-new-bundle")),
            {
              headers: { "content-type": "application/json" },
            },
          );
        }

        return new Response("not found", { status: 404 });
      }),
    );

    try {
      const response = await worker.fetch(
        new Request(
          `${PUBLIC_BASE_URL}${createCanonicalPath({
            appVersion: "1.0.0",
            bundleId: currentBundleId,
            platform: "ios",
            _updateStrategy: "appVersion",
          })}`,
        ),
        env,
      );

      expect(response.ok).toBe(true);
      const body = (await response.json()) as {
        changedAssets?: Record<string, any>;
        id?: string;
        manifestFileHash?: string;
        status?: string;
      };

      expect(body).toMatchObject({
        id: nextBundleId,
        manifestFileHash: "sig:manifest-next",
        status: "UPDATE",
      });
      expect(body.changedAssets?.["index.ios.bundle"]).toMatchObject({
        fileHash: "hash-new-bundle",
        patch: {
          algorithm: "bsdiff",
          baseBundleId: currentBundleId,
          baseFileHash: "hash-old-bundle",
          patchFileHash: "hash-bsdiff",
        },
      });
      expect(
        body.changedAssets?.["index.ios.bundle"]?.patch?.patchUrl,
      ).toContain(
        `/bundles/${nextBundleId}/patches/${currentBundleId}/index.ios.bundle.bsdiff`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
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
