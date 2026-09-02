import {
  type Bundle,
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/core";
import {
  commitReleaseCatalogMutations,
  createUUIDv7,
} from "@hot-updater/plugin-core";
import { createHotUpdater, registerApiKey } from "@hot-updater/server";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

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
    storageUri: `r2://${env.BUCKET_NAME}/${bundle.id}/bundle.zip`,
  };
};

const seedBundles = async (bundles: Bundle[]) => {
  const database = d1Database({
    database: env.DB,
    insightsDatabaseNamespace: env.INSIGHTS_DATABASE_NAMESPACE,
  });
  const seedHotUpdater = createHotUpdater({
    database,
    clientAccess: { type: "public" },
  });
  for (const bundle of bundles.map(toRuntimeBundle)) {
    const existing = await seedHotUpdater.getBundleById(bundle.id);
    if (existing === null) {
      await seedHotUpdater.insertBundle(bundle);
    } else {
      await seedHotUpdater.updateBundleById(bundle.id, bundle);
    }
    const channelName = "production";
    const channelKey = encodeChannelKey(channelName);
    const channel = (
      await database.models.channels.insert({
        row: { id: `channel:${channelKey}`, name: channelName },
        onConflict: "returnExisting",
      })
    ).row;
    const scopeKey = createReleaseCatalogScopeKey({
      channelKey,
      platform: bundle.platform,
      strategy: "APP_VERSION",
    });
    const now = Date.now();
    const releaseId = createUUIDv7();
    await commitReleaseCatalogMutations({
      database,
      mutations: [
        {
          mutation: {
            operation: "insert",
            row: {
              bundle_id: bundle.id,
              channel_id: channel.id,
              created_at_ms: now,
              enabled: true,
              fingerprint_hash: null,
              id: releaseId,
              kind: "BUNDLE",
              message: "hello",
              operation: "DEPLOY",
              platform: bundle.platform,
              revision: 1,
              rollout_cohort_count: 1_000,
              scope_key: scopeKey,
              should_force_update: false,
              source_release_id: null,
              strategy: "APP_VERSION",
              target_app_version: "1.0",
              target_cohorts: [],
              updated_at_ms: now,
            },
          },
          scope: {
            channelId: channel.id,
            channelName,
            fingerprintHash: null,
            platform: bundle.platform,
            scopeKey,
            strategy: "APP_VERSION",
          },
          updatedAtMs: now,
        },
      ],
    });
  }
};

describe.sequential("cloudflare worker runtime acceptance", () => {
  beforeAll(async () => {
    await env.DB.prepare(inject("prepareSql")).run();
    const database = d1Database({
      database: env.DB,
      insightsDatabaseNamespace: env.INSIGHTS_DATABASE_NAMESPACE,
    });
    await registerApiKey({
      apiKey: API_KEY,
      apiKeys: database.models.apiKeys,
      name: "Runtime acceptance",
    });
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bundle_patches").run();
    await env.DB.prepare("DELETE FROM release_catalogs").run();
    await env.DB.prepare("DELETE FROM releases").run();
    await env.DB.prepare("DELETE FROM bundles").run();
    await env.DB.prepare("DELETE FROM channels").run();
  });

  it("serves unversioned Release Catalog routes from the worker entrypoint", async () => {
    expect(HOT_UPDATER_BASE_PATH).toBe("/");
    await seedBundles([
      {
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        fileHash: "hash",
        gitCommitHash: null,
        storageUri: "storage://unused",
        archiveByteSize: 3_000_000_001,
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
