import { PGlite } from "@electric-sql/pglite";
import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  createBlobDatabaseAdapter,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { standaloneRepository } from "../../../plugins/standalone/src";
import { kyselyAdapter } from "./adapters/kysely";
import { createMigrator } from "./db";
import { createHotUpdater } from "./index";

const db = new PGlite();
const kysely = new Kysely({ dialect: new PGliteDialect(db) });
const api = createHotUpdater({
  database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
  basePath: "/hot-updater",
  routes: { updateCheck: true, bundles: true },
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
  await db.exec("DELETE FROM bundles");
  await db.exec("DELETE FROM channels");
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

const createInMemoryBlobDatabase = (store: Record<string, string>) =>
  createBlobDatabaseAdapter({
    name: "blob-test",
    factory: () => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix: string) =>
        Object.keys(store).filter((key) => key.startsWith(prefix)),
      loadObject: async (key: string) => {
        const value = store[key];
        return value ? (JSON.parse(value) as unknown) : null;
      },
      uploadObject: async (key: string, data: unknown) => {
        store[key] = JSON.stringify(data);
      },
      invalidatePaths: async () => {},
    }),
  })({});

describe("Handler <-> Standalone Repository Integration", () => {
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

  it("works with a custom basePath", async () => {
    const customApi = createHotUpdater({
      database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
      basePath: "/api/v2",
      routes: { updateCheck: true, bundles: true },
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
      createStandaloneClient().getBundleById("non-existent-bundle"),
    ).resolves.toBeNull();
  });

  it("updates a blob-backed bundle without creating a duplicate row", async () => {
    const store: Record<string, string> = {};
    const blobApi = createHotUpdater({
      database: createInMemoryBlobDatabase(store),
      basePath: "/blob-hot-updater",
      routes: { updateCheck: true, bundles: true },
    });
    server.use(
      http.all(`${baseUrl}/blob-hot-updater/*`, async ({ request }) => {
        const response = await blobApi.handler(request);
        return new HttpResponse(await response.text(), {
          status: response.status,
          headers: response.headers,
        });
      }),
    );
    const client = createStandaloneClient(`${baseUrl}/blob-hot-updater`);
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
    const snapshot = JSON.parse(store[BLOB_DATABASE_SNAPSHOT_KEY] ?? "{}") as {
      bundles?: Array<{ id: string; target_app_version: string }>;
    };
    expect(snapshot.bundles).toEqual([
      expect.objectContaining({
        id: bundleId,
        target_app_version: "1.0.2",
      }),
    ]);
  });
});
