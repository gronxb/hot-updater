import { randomUUID } from "node:crypto";

import { BLOB_DATABASE_SNAPSHOT_KEY } from "@hot-updater/plugin-core";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createHotUpdater } from "../../../packages/server/src";
import {
  api,
  baseUrl,
  createInMemoryBlobDatabase,
  createStandaloneClient,
  createTestBundle,
  resetServer,
  server,
  startServer,
  stopServer,
} from "./standaloneServer.integration.testFixtures";

beforeAll(startServer);
afterEach(resetServer);
afterAll(stopServer);

describe("Handler <-> Standalone Repository Integration", () => {
  it("creates a bundle through handler POST /bundles", async () => {
    const client = createStandaloneClient();
    const bundleId = randomUUID();

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
    const bundleId = randomUUID();
    await api.insertBundle(
      createTestBundle({ id: bundleId, fileHash: "get-hash-1" }),
    );

    const retrieved = await createStandaloneClient().getBundleById(bundleId);

    expect(retrieved).toMatchObject({ id: bundleId, fileHash: "get-hash-1" });
  });

  it("deletes a bundle through handler DELETE /bundles/:id", async () => {
    const bundleId = randomUUID();
    const bundle = createTestBundle({ id: bundleId });
    await api.insertBundle(bundle);
    const client = createStandaloneClient();

    await client.deleteBundleById(bundleId);

    await expect(api.getBundleById(bundleId)).resolves.toBeNull();
  });

  it("lists and filters bundles through handler GET /bundles", async () => {
    await api.insertBundle(
      createTestBundle({ id: randomUUID(), channel: "production" }),
    );
    await api.insertBundle(
      createTestBundle({ id: randomUUID(), channel: "production" }),
    );
    await api.insertBundle(
      createTestBundle({ id: randomUUID(), channel: "staging" }),
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
      createTestBundle({ id: randomUUID(), channel: "production" }),
    );
    await api.insertBundle(
      createTestBundle({ id: randomUUID(), channel: "beta" }),
    );

    const channels = await createStandaloneClient().getChannels();

    expect(channels).toEqual(expect.arrayContaining(["production", "beta"]));
    expect(channels).toHaveLength(2);
  });

  it("creates, retrieves, updates, and deletes through existing routes", async () => {
    const client = createStandaloneClient();
    const bundleId = randomUUID();
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
    const ids = [randomUUID(), randomUUID(), randomUUID()];

    for (const id of ids) await client.insertBundle(createTestBundle({ id }));

    for (const id of ids) {
      await expect(api.getBundleById(id)).resolves.toMatchObject({ id });
    }
  });

  it("rolls back the entire create batch when one bundle cannot be inserted", async () => {
    // Given
    const existingId = randomUUID();
    const newId = randomUUID();
    await api.insertBundle(createTestBundle({ id: existingId }));

    // When
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

    // Then
    expect(response.status).toBe(500);
    await expect(api.getBundleById(newId)).resolves.toBeNull();
  });

  it("works with a custom basePath", async () => {
    const customStore: Record<string, string> = {};
    const customApi = createHotUpdater({
      database: createInMemoryBlobDatabase(customStore),
      basePath: "/api/v2",
      coreRoutes: {
        updateCheck: true,
        bundles: { access: { kind: "public" } },
      },
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
    const bundleId = randomUUID();
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
      createStandaloneClient().getBundleById(randomUUID()),
    ).resolves.toBeNull();
  });

  it("updates a blob-backed bundle without creating a duplicate row", async () => {
    const store: Record<string, string> = {};
    const blobApi = createHotUpdater({
      database: createInMemoryBlobDatabase(store),
      basePath: "/blob-hot-updater",
      coreRoutes: {
        updateCheck: true,
        bundles: { access: { kind: "public" } },
      },
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
    const bundleId = randomUUID();
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
    const pointer = JSON.parse(store[BLOB_DATABASE_SNAPSHOT_KEY] ?? "{}") as {
      active_revision?: string;
    };
    const snapshotKey = `_hot-updater/database/revisions/${pointer.active_revision}/snapshot.json`;
    const snapshot = JSON.parse(store[snapshotKey] ?? "{}") as {
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
