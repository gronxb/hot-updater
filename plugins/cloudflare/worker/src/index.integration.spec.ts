import {
  type AppUpdateInfo,
  getBundlePatches,
  type Bundle,
  type GetBundlesArgs,
  NIL_UUID,
  type UpdateInfo,
} from "@hot-updater/core";
import {
  createManagedServerPlugins,
  registerManagedServerClientKey,
} from "@hot-updater/managed";
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

import { getHotUpdaterCoreMetadata } from "../../../../packages/server/src/createHotUpdaterCore";
import { d1WorkerDatabase } from "../../src/worker";
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
const RAW_API_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WRONG_API_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

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
      storage_uri, fingerprint_hash, metadata, manifest_storage_uri,
      manifest_file_hash, asset_base_storage_uri, rollout_cohort_count,
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
      ${bundle.manifestStorageUri ? sqlString(bundle.manifestStorageUri) : "null"},
      ${bundle.manifestFileHash ? sqlString(bundle.manifestFileHash) : "null"},
      ${bundle.assetBaseStorageUri ? sqlString(bundle.assetBaseStorageUri) : "null"},
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
      manifest_storage_uri = excluded.manifest_storage_uri,
      manifest_file_hash = excluded.manifest_file_hash,
      asset_base_storage_uri = excluded.asset_base_storage_uri,
      rollout_cohort_count = excluded.rollout_cohort_count,
      target_cohorts = excluded.target_cohorts;
  `;
};

const createInsertBundlePatchQueries = (bundle: Bundle) =>
  getBundlePatches(bundle).map(
    (patch, index) => `
    INSERT INTO bundle_patches (
      id,
      bundle_id,
      base_bundle_id,
      base_file_hash,
      patch_file_hash,
      patch_storage_uri,
      order_index
    ) VALUES (
      ${sqlString(`${bundle.id}:${patch.baseBundleId}`)},
      ${sqlString(bundle.id)},
      ${sqlString(patch.baseBundleId)},
      ${sqlString(patch.baseFileHash)},
      ${sqlString(patch.patchFileHash)},
      ${sqlString(patch.patchStorageUri)},
      ${index}
    ) ON CONFLICT(id) DO UPDATE SET
      bundle_id = excluded.bundle_id,
      base_bundle_id = excluded.base_bundle_id,
      base_file_hash = excluded.base_file_hash,
      patch_file_hash = excluded.patch_file_hash,
      patch_storage_uri = excluded.patch_storage_uri,
      order_index = excluded.order_index;
  `,
  );

const toRuntimeBundle = (bundle: Bundle): Bundle => {
  return {
    ...bundle,
    storageUri: `r2://bundles/${bundle.id}/bundle.zip`,
  };
};

const seedBundles = async (bundles: Bundle[]) => {
  for (const bundle of bundles.map(toRuntimeBundle)) {
    await env.DB.prepare(createInsertBundleQuery(bundle)).run();
    for (const patchSql of createInsertBundlePatchQueries(bundle)) {
      await env.DB.prepare(patchSql).run();
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
  let componentMigrations: readonly {
    readonly changed: boolean;
    readonly componentId: string;
    readonly version: string;
  }[] = [];

  beforeAll(async () => {
    await env.DB.prepare(inject("prepareSql")).run();
    const coreMigration = inject("d1Migrations").find(
      ({ name }) => name === "0006_hot-updater_0.36.0.sql",
    );
    if (coreMigration === undefined) {
      throw new Error("Cloudflare Core schema migration is missing.");
    }
    await env.DB.prepare(coreMigration.sql).run();
    const database = d1WorkerDatabase(env.DB);
    const deploymentTarget = createHotUpdater({
      database,
      plugins: createManagedServerPlugins(),
    });
    const metadata = getHotUpdaterCoreMetadata(deploymentTarget);
    if (metadata === undefined) {
      throw new Error("Cloudflare deployment target metadata is missing.");
    }
    const migrate = metadata.universalComponentDataAdapter?.migrate;
    if (migrate === undefined) {
      throw new Error("Cloudflare universal component migration is missing.");
    }
    componentMigrations = await Promise.all(
      (metadata.components?.schemas ?? []).map(async (schema) => ({
        ...(await migrate(schema)),
        componentId: schema.id,
      })),
    );
    await registerManagedServerClientKey({
      apiKey: RAW_API_KEY,
      createdAt: 1,
      name: "Runtime test",
      target: deploymentTarget,
    });
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bundle_patches").run();
    await env.DB.prepare("DELETE FROM bundles").run();
  });

  it("prepares the component schema consumed by the managed Worker", async () => {
    expect(componentMigrations).toEqual([
      expect.objectContaining({
        changed: true,
        componentId: "analytics",
        version: "2",
      }),
      expect.objectContaining({
        changed: true,
        componentId: "better-auth-managed-access-keys",
        version: "1",
      }),
    ]);

    const event = await worker.fetch(
      new Request(`${PUBLIC_BASE_URL}${HOT_UPDATER_BASE_PATH}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": RAW_API_KEY,
        },
        body: JSON.stringify({
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          fingerprintHash: null,
          fromBundleId: null,
          installId: "cloudflare-managed-install",
          platform: "ios",
          toBundleId: "bundle-1",
          type: "UNCHANGED",
          updateStrategy: null,
        }),
      }),
      env,
    );
    const query = await worker.fetch(
      new Request(
        `${PUBLIC_BASE_URL}${HOT_UPDATER_BASE_PATH}/api/installations/overview`,
        { headers: { "x-api-key": RAW_API_KEY } },
      ),
      env,
    );

    expect(event.status).toBe(204);
    expect(query.status).toBe(401);
    expect(query.headers.get("cache-control")).toBe("private, no-store");
  });

  const requestUpdateInfo = async (args: GetBundlesArgs) => {
    const response = await worker.fetch(
      new Request(`${PUBLIC_BASE_URL}${createCanonicalPath(args)}`, {
        headers: { "x-api-key": RAW_API_KEY },
      }),
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
            assetBaseStorageUri: `r2://bundles/${fixture.currentBundleId}/files`,
            manifestFileHash: "sig:manifest-current",
            manifestStorageUri: `r2://bundles/${fixture.currentBundleId}/manifest.json`,
          },
          nextArtifacts: {
            assetBaseStorageUri: `r2://bundles/${fixture.nextBundleId}/files`,
            manifestFileHash: "sig:manifest-next",
            manifestStorageUri: `r2://bundles/${fixture.nextBundleId}/manifest.json`,
          },
        };
      },
      expectFileUrl: (fileUrl, fixture) => {
        expect(fileUrl).toContain(
          `/bundles/${fixture.nextBundleId}/files/${fixture.changedAssetPath}`,
        );
      },
      expectManifestUrl: (manifestUrl, fixture) => {
        expect(manifestUrl).toContain(`/${fixture.nextBundleId}/manifest.json`);
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
          assetBaseStorageUri: `r2://bundles/${fixture.currentBundleId}/files`,
          manifestFileHash: "sig:manifest-current",
          manifestStorageUri: `r2://bundles/${fixture.currentBundleId}/manifest.json`,
        },
        nextArtifacts: {
          assetBaseStorageUri: `r2://bundles/${fixture.nextBundleId}/files`,
          manifestFileHash: "sig:manifest-next",
          manifestStorageUri: `r2://bundles/${fixture.nextBundleId}/manifest.json`,
          patches: [
            {
              baseBundleId: fixture.currentBundleId,
              baseFileHash: "hash-old-bundle",
              patchFileHash: "hash-bsdiff",
              patchStorageUri: `r2://bundles/${fixture.patchPath}`,
            },
          ],
        },
      };
    },
    expectPatchUrl: (patchUrl, fixture) => {
      expect(patchUrl).toContain(`/bundles/${fixture.patchPath}`);
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
        { headers: { "x-api-key": RAW_API_KEY } },
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      id: "00000000-0000-0000-0000-000000000001",
      status: "UPDATE",
    });
  });

  it("requires a managed client key for update checks", async () => {
    const url = `${PUBLIC_BASE_URL}${createCanonicalPath({
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
      _updateStrategy: "appVersion",
    })}`;

    for (const headers of [
      undefined,
      { "x-api-key": WRONG_API_KEY },
    ] as const) {
      const response = await worker.fetch(new Request(url, { headers }), env);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Unauthorized",
      });
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
