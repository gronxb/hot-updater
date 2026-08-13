import { PGlite } from "@electric-sql/pglite";
import type { LegacyBundle } from "@hot-updater/core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  NIL_UUID,
} from "@hot-updater/core";
import {
  bundleToRow,
  commitReleaseCatalogMutation,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { standaloneRepository } from "../../../plugins/standalone/src";
import { createInMemoryDatabasePlugin } from "../../test-utils/test/inMemoryDatabasePlugin";
import { kyselyAdapter } from "./adapters/kysely";
import { createMigrator } from "./db";
import { createHotUpdater } from "./index";

const db = new PGlite();
const kysely = new Kysely<object>({ dialect: new PGliteDialect(db) });
const api = createHotUpdater({
  database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
  basePath: "/hot-updater",
  features: {
    updateCheck: true,
    bundles: true,
    analytics: { queryAccess: "public" },
  },
});
const baseUrl = "http://localhost:3000";
const server = setupServer();
const handleRequest = async (request: Request) => {
  const response = await api.handler(request);
  return new HttpResponse(await response.text(), {
    status: response.status,
    headers: response.headers,
  });
};

beforeAll(async () => {
  const result = await createMigrator(api).migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await result.execute();
  server.listen({ onUnhandledRequest: "error" });
  server.use(
    http.all(`${baseUrl}/hot-updater/*`, ({ request }) =>
      handleRequest(request),
    ),
  );
});

afterEach(async () => {
  await db.exec("DELETE FROM bundle_patches");
  await db.exec("DELETE FROM release_catalogs");
  await db.exec("DELETE FROM releases");
  await db.exec("DELETE FROM bundles");
  await db.exec("DELETE FROM channels");
});

afterAll(async () => {
  server.close();
  await kysely.destroy();
  await db.close();
});

const createTestBundle = (overrides?: Partial<LegacyBundle>): LegacyBundle => ({
  id: NIL_UUID,
  platform: "ios",
  channel: "production",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "test-hash",
  gitCommitHash: null,
  message: null,
  targetAppVersion: "*",
  storageUri: "test://storage",
  fingerprintHash: null,
  ...overrides,
});

const createStandaloneClient = (base = `${baseUrl}/hot-updater`) =>
  createDatabaseClient(standaloneRepository({ baseUrl: base }));

describe("Handler <-> Standalone Repository Integration", () => {
  it("uses Standalone for bundle management and the server database for Analytics", async () => {
    const bundleId = uuidv7();
    const installId = "standalone-install";
    await createStandaloneClient().insertBundle(
      createTestBundle({ id: bundleId }),
    );

    const ingestion = await api.handler(
      new Request(`${baseUrl}/hot-updater/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "hot-updater-sdk-version": "2.0.0",
        },
        body: JSON.stringify({
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          fingerprintHash: null,
          fromBundleId: NIL_UUID,
          installId,
          platform: "ios",
          toBundleId: bundleId,
          type: "UPDATE_APPLIED",
          updateStrategy: "appVersion",
        }),
      }),
    );
    const overview = await api.handler(
      new Request(`${baseUrl}/hot-updater/api/installations/overview`),
    );

    expect(ingestion.status).toBe(204);
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toEqual({
      bundles: [{ bundleId, installations: 1 }],
      trackedInstallations: 1,
    });
  });

  it("atomically commits and reads Release catalogs through standalone management routes", async () => {
    const repository = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
    });
    const channel = await repository.models.channels.insert({
      onConflict: "returnExisting",
      row: { id: uuidv7(), name: "production" },
    });
    const bundle = createTestBundle({ id: uuidv7() });
    const scopeKey = createReleaseCatalogScopeKey({
      authorityId: "default",
      channelKey: encodeChannelKey("production"),
      platform: "ios",
      strategy: "APP_VERSION",
    });
    const releaseId = uuidv7();

    const committed = await commitReleaseCatalogMutation({
      companionChanges: [
        {
          model: "bundles",
          operation: "insert",
          row: bundleToRow(bundle, channel.row.id),
        },
      ],
      database: repository,
      mutation: {
        operation: "insert",
        row: {
          bundle_id: bundle.id,
          channel_id: channel.row.id,
          created_at_ms: 1,
          enabled: true,
          fingerprint_hash: null,
          id: releaseId,
          kind: "BUNDLE",
          message: null,
          operation: "DEPLOY",
          platform: "ios",
          revision: 1,
          rollout_cohort_count: 1000,
          scope_key: scopeKey,
          should_force_update: false,
          source_release_id: null,
          strategy: "APP_VERSION",
          target_app_version: "*",
          target_cohorts: [],
          updated_at_ms: 1,
        },
      },
      scope: {
        authorityId: "default",
        channelId: channel.row.id,
        channelName: channel.row.name,
        fingerprintHash: null,
        platform: "ios",
        scopeKey,
        strategy: "APP_VERSION",
      },
    });

    await expect(
      repository.models.releases.findById(releaseId),
    ).resolves.toMatchObject({
      bundle_id: bundle.id,
      revision: 1,
    });
    await expect(
      repository.models.releaseCatalogs.findByScopeKey(scopeKey),
    ).resolves.toMatchObject({ generation: committed.catalog.generation });
    const response = await api.handler(
      new Request(
        `${baseUrl}/hot-updater/v2/release-catalogs/app-version/default/ios/${encodeChannelKey("production")}/1.0.0`,
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      releases: [{ bundleId: bundle.id, releaseId }],
    });
  });

  it("keeps Standalone management routes separate from client access-key protection", async () => {
    const protectedApi = createHotUpdater({
      database: createInMemoryDatabasePlugin(),
      basePath: "/protected-hot-updater",
      features: {
        updateCheck: true,
        bundles: true,
        clientAccessKeys: true,
      },
    });
    server.use(
      http.all(`${baseUrl}/protected-hot-updater/*`, async ({ request }) => {
        const response = await protectedApi.handler(request);
        return new HttpResponse(await response.text(), {
          status: response.status,
          headers: response.headers,
        });
      }),
    );
    const bundleId = uuidv7();
    const client = createStandaloneClient(`${baseUrl}/protected-hot-updater`);

    await client.insertBundle(createTestBundle({ id: bundleId }));
    const updateCheck = await protectedApi.handler(
      new Request(
        `${baseUrl}/protected-hot-updater/app-version/ios/1.0.0/production/${NIL_UUID}/${NIL_UUID}`,
      ),
    );

    await expect(client.getBundleById(bundleId)).resolves.toMatchObject({
      id: bundleId,
    });
    expect(updateCheck.status).toBe(401);
  });

  it("creates a bundle through handler POST /bundles", async () => {
    const client = createStandaloneClient();
    const bundleId = uuidv7();

    await client.insertBundle(
      createTestBundle({ id: bundleId, fileHash: "integration-hash-1" }),
    );

    const response = await api.handler(
      new Request(`${baseUrl}/hot-updater/api/bundles/${bundleId}`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: bundleId,
      fileHash: "integration-hash-1",
    });
  });

  it("retrieves a bundle through handler GET /bundles/:id", async () => {
    const bundleId = uuidv7();
    await api.insertBundle(
      createTestBundle({ id: bundleId, fileHash: "get-hash-1" }),
    );

    const retrieved = await createStandaloneClient().getBundleById(bundleId);

    expect(retrieved).toMatchObject({ id: bundleId, fileHash: "get-hash-1" });
  });

  it("refuses to delete an artifact referenced by a Release", async () => {
    const bundleId = uuidv7();
    const bundle = createTestBundle({ id: bundleId });
    await api.insertBundle(bundle);
    const client = createStandaloneClient();

    await expect(client.deleteBundleById(bundleId)).rejects.toThrow(
      "still referenced",
    );

    await expect(api.getBundleById(bundleId)).resolves.toMatchObject({
      id: bundleId,
    });
  });

  it("lists and filters artifacts through handler GET /bundles", async () => {
    await api.insertBundle(
      createTestBundle({ id: uuidv7(), channel: "production" }),
    );
    await api.insertBundle(
      createTestBundle({ id: uuidv7(), channel: "production" }),
    );
    await api.insertBundle(
      createTestBundle({ id: uuidv7(), channel: "staging" }),
    );
    const client = createStandaloneClient();

    const all = await client.getBundles({ limit: 50 });
    const ios = await client.getBundles({
      where: { platform: "ios" },
      limit: 50,
    });

    expect(all.data).toHaveLength(3);
    expect(all.pagination.total).toBe(3);
    expect(ios.data).toHaveLength(3);
  });

  it("lists Channel rows through handler GET /channels", async () => {
    await api.insertBundle(
      createTestBundle({ id: uuidv7(), channel: "production" }),
    );
    await api.insertBundle(createTestBundle({ id: uuidv7(), channel: "beta" }));

    const channels = await createStandaloneClient().getChannels();

    expect(channels.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["production", "beta"]),
    );
    expect(channels.every(({ id }) => id.length > 0)).toBe(true);
    expect(new Set(channels.map(({ name }) => name)).size).toBe(
      channels.length,
    );
  });

  it("creates and deletes an empty Channel through the canonical routes", async () => {
    const client = createStandaloneClient();
    const id = uuidv7();

    await expect(
      client.insertChannel({
        row: { id, name: "preview" },
        onConflict: "returnExisting",
      }),
    ).resolves.toEqual({
      row: { id, name: "preview" },
      inserted: true,
    });
    await expect(client.deleteChannel({ id })).resolves.toEqual({
      deleted: true,
    });
    await expect(client.deleteChannel({ id })).resolves.toEqual({
      deleted: false,
      reason: "not_found",
    });
  });

  it("refuses to delete a Channel referenced by a Release", async () => {
    const client = createStandaloneClient();
    const bundleId = uuidv7();
    await api.insertBundle(
      createTestBundle({ id: bundleId, channel: "preview" }),
    );
    const channel = (await client.getChannels()).find(
      ({ name }) => name === "preview",
    );

    expect(channel).toBeDefined();
    if (!channel) throw new Error("preview Channel was not created");
    await expect(client.deleteChannel({ id: channel.id })).resolves.toEqual({
      deleted: false,
      reason: "not_empty",
    });
    await expect(client.getBundleById(bundleId)).resolves.toMatchObject({
      id: bundleId,
    });
  });

  it("creates, retrieves, updates, and deletes through existing routes", async () => {
    const client = createStandaloneClient();
    const bundleId = uuidv7();
    await client.insertBundle(
      createTestBundle({ id: bundleId, fileHash: "e2e-hash" }),
    );

    await expect(client.getBundleById(bundleId)).resolves.toMatchObject({
      fileHash: "e2e-hash",
    });
    await client.updateBundleById(bundleId, { storageUri: "test://updated" });
    await expect(client.getBundleById(bundleId)).resolves.toMatchObject({
      storageUri: "test://updated",
    });
    await client.deleteBundleById(bundleId);
    await expect(client.getBundleById(bundleId)).resolves.toBeNull();
  });

  it("creates multiple bundles through the existing create endpoint", async () => {
    const client = createStandaloneClient();
    const ids = [uuidv7(), uuidv7(), uuidv7()];

    for (const id of ids) await client.insertBundle(createTestBundle({ id }));

    for (const id of ids) {
      await expect(api.getBundleById(id)).resolves.toMatchObject({ id });
    }
  });

  it("rolls back the entire create batch when one bundle cannot be inserted", async () => {
    const existingId = uuidv7();
    const newId = uuidv7();
    await api.insertBundle(createTestBundle({ id: existingId }));

    const response = await api.handler(
      new Request(`${baseUrl}/hot-updater/api/bundles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          createTestBundle({ id: newId }),
          createTestBundle({ id: existingId }),
        ]),
      }),
    );

    expect(response.status).toBe(500);
    await expect(api.getBundleById(newId)).resolves.toBeNull();
  });

  it("works with a custom basePath", async () => {
    const customApi = createHotUpdater({
      database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
      basePath: "/api/v2",
      features: { updateCheck: true, bundles: true },
    });
    server.use(
      http.all(`${baseUrl}/api/v2/*`, async ({ request }) => {
        const response = await customApi.handler(request);
        return new HttpResponse(await response.text(), {
          status: response.status,
          headers: response.headers,
        });
      }),
    );
    const bundleId = uuidv7();
    const client = createStandaloneClient(`${baseUrl}/api/v2`);

    await client.insertBundle(
      createTestBundle({ id: bundleId, fileHash: "custom-hash" }),
    );

    await expect(client.getBundleById(bundleId)).resolves.toMatchObject({
      fileHash: "custom-hash",
    });
  });

  it("returns null when the bundle endpoint returns 404", async () => {
    await expect(
      createStandaloneClient().getBundleById(uuidv7()),
    ).resolves.toBeNull();
  });

  it("updates a bundle without creating a duplicate row", async () => {
    const memoryApi = createHotUpdater({
      database: createInMemoryDatabasePlugin(),
      basePath: "/memory-hot-updater",
      features: { updateCheck: true, bundles: true },
    });
    server.use(
      http.all(`${baseUrl}/memory-hot-updater/*`, async ({ request }) => {
        const response = await memoryApi.handler(request);
        return new HttpResponse(await response.text(), {
          status: response.status,
          headers: response.headers,
        });
      }),
    );
    const client = createStandaloneClient(`${baseUrl}/memory-hot-updater`);
    const bundleId = uuidv7();
    await client.insertBundle(
      createTestBundle({
        id: bundleId,
        targetAppVersion: "1.x.x",
        storageUri: "s3://test-bucket/original.zip",
      }),
    );

    await client.updateBundleById(bundleId, {
      storageUri: "s3://test-bucket/updated.zip",
    });

    await expect(client.getBundleById(bundleId)).resolves.toMatchObject({
      id: bundleId,
      storageUri: "s3://test-bucket/updated.zip",
    });
    await expect(client.getBundles({ limit: 50 })).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          id: bundleId,
          storageUri: "s3://test-bucket/updated.zip",
        }),
      ],
      pagination: { total: 1 },
    });
  });
});
