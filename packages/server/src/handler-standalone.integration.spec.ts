import { PGlite } from "@electric-sql/pglite";
import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { createDatabaseClient } from "@hot-updater/plugin-core";
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
  await db.exec("DELETE FROM bundle_events");
  await db.exec("DELETE FROM bundle_patches");
  await db.exec("DELETE FROM bundles");
});

afterAll(async () => {
  server.close();
  await kysely.destroy();
  await db.close();
});

const createTestBundle = (overrides?: Partial<Bundle>): Bundle => ({
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

  it("deletes a bundle through handler DELETE /bundles/:id", async () => {
    const bundleId = uuidv7();
    const bundle = createTestBundle({ id: bundleId });
    await api.insertBundle(bundle);
    const client = createStandaloneClient();

    await client.deleteBundleById(bundleId);

    await expect(api.getBundleById(bundleId)).resolves.toBeNull();
  });

  it("lists and filters bundles through handler GET /bundles", async () => {
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
    const production = await client.getBundles({
      where: { channel: "production" },
      limit: 50,
    });

    expect(all.data).toHaveLength(3);
    expect(all.pagination.total).toBe(3);
    expect(production.data).toHaveLength(2);
  });

  it("lists channels through handler GET /bundles/channels", async () => {
    await api.insertBundle(
      createTestBundle({ id: uuidv7(), channel: "production" }),
    );
    await api.insertBundle(createTestBundle({ id: uuidv7(), channel: "beta" }));

    const channels = await createStandaloneClient().getChannels();

    expect(channels).toEqual(expect.arrayContaining(["production", "beta"]));
    expect(channels).toHaveLength(2);
  });

  it("creates, retrieves, updates, and deletes through existing routes", async () => {
    const client = createStandaloneClient();
    const bundleId = uuidv7();
    await client.insertBundle(
      createTestBundle({ id: bundleId, fileHash: "e2e-hash" }),
    );

    await expect(client.getBundleById(bundleId)).resolves.toMatchObject({
      enabled: true,
    });
    await client.updateBundleById(bundleId, { enabled: false });
    await expect(client.getBundleById(bundleId)).resolves.toMatchObject({
      enabled: false,
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

    await client.updateBundleById(bundleId, { targetAppVersion: "1.0.2" });

    await expect(client.getBundleById(bundleId)).resolves.toMatchObject({
      id: bundleId,
      targetAppVersion: "1.0.2",
    });
    await expect(client.getBundles({ limit: 50 })).resolves.toMatchObject({
      data: [
        expect.objectContaining({
          id: bundleId,
          targetAppVersion: "1.0.2",
        }),
      ],
      pagination: { total: 1 },
    });
  });
});
