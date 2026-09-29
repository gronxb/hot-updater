import type { Bundle } from "@hot-updater/core";
import { createHotUpdater } from "@hot-updater/server";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { d1Database, plugins } from "../../src/worker";
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
    BUCKET_NAME: string;
    STORAGE_DOWNLOAD_URL_SIGNING_KEY: string;
  }
}

const PUBLIC_BASE_URL = "https://updates.example.com";
const API_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const toRuntimeBundle = (bundle: Bundle): Bundle => {
  return {
    ...bundle,
    manifestStorageUri: `r2://${env.BUCKET_NAME}/${bundle.id}/manifest.json`,
    assetBaseStorageUri: `r2://${env.BUCKET_NAME}/assets`,
  };
};

/** A server on the test database with the plugins the Worker runs. */
const createSeedServer = () =>
  createHotUpdater({ database: d1Database(env.DB), plugins });

const seedBundles = async (bundles: Bundle[]) => {
  const { core } = createSeedServer();
  // A deploy publishes into each scope at most once, so each bundle deploys alone.
  for (const bundle of bundles) {
    await core.deploy([
      {
        bundle: toRuntimeBundle(bundle),
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: "hello",
          shouldForceUpdate: false,
          targetAppVersion: "1.0",
        },
      },
    ]);
  }
};

describe.sequential("cloudflare worker runtime acceptance", () => {
  beforeAll(async () => {
    await env.DB.prepare(inject("prepareSql")).run();
    await createSeedServer().api.apiKeys.register({
      apiKey: API_KEY,
      name: "Runtime acceptance",
    });
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bundle_patches").run();
    await env.DB.prepare("DELETE FROM release_catalogs").run();
    await env.DB.prepare("DELETE FROM releases").run();
    await env.DB.prepare("DELETE FROM bundles").run();
    await env.DB.prepare("DELETE FROM channels").run();
    await env.DB.prepare("DELETE FROM bundle_totals").run();
    await env.DB.prepare("DELETE FROM base_candidates").run();
  });

  it("serves unversioned Release Catalog routes from the worker entrypoint", async () => {
    expect(HOT_UPDATER_BASE_PATH).toBe("/");
    await seedBundles([
      {
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        gitCommitHash: null,
        manifestStorageUri: "storage://unused/manifest.json",
        manifestFileHash: "manifest-hash",
        assetBaseStorageUri: "storage://assets",
      },
    ]);

    const unauthorized = await worker.fetch(
      new Request(
        `${PUBLIC_BASE_URL}/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0`,
      ),
      env,
    );
    expect(unauthorized.status).toBe(401);

    const response = await worker.fetch(
      new Request(
        `${PUBLIC_BASE_URL}/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.0.0`,
        { headers: { "x-api-key": API_KEY } },
      ),
      env,
    );

    await expect(response.json()).resolves.toMatchObject({
      catalogId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      releases: [{ bundleId: "00000000-0000-0000-0000-000000000001" }],
    });
  });

  it("does not support the legacy exact path", async () => {
    const response = await worker.fetch(
      new Request(`${PUBLIC_BASE_URL}/api/check-update`),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Not found",
    });
  });

  it("does not expose management routes from the worker entrypoint", async () => {
    const response = await worker.fetch(
      new Request(`${PUBLIC_BASE_URL}/admin/bundles`),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Not found",
    });
  });
});
