import { PGlite } from "@electric-sql/pglite";
import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { standaloneRepository } from "@hot-updater/standalone";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { uuidv7 } from "uuidv7";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHotUpdater } from "./db";

/**
 * Integration tests between @hot-updater/server handler and @hot-updater/standalone repository
 *
 * This test suite verifies real-world compatibility by:
 * 1. Using actual standaloneRepository (not mocks)
 * 2. Using actual handler (not mocks)
 * 3. Simulating HTTP communication via MSW
 * 4. Testing end-to-end flows: standalone → HTTP → handler → database
 */

// Create in-memory database for testing
const db = new PGlite();
const kysely = new Kysely({ dialect: new PGliteDialect(db) });

// Create handler API with in-memory DB
const api = createHotUpdater({
  database: kyselyAdapter({
    db: kysely,
    provider: "postgresql",
  }),
  basePath: "/hot-updater",
});

// Setup MSW server to intercept HTTP requests
const baseUrl = "http://localhost:3000";
const server = setupServer();

beforeAll(async () => {
  // Initialize database
  const migrator = api.createMigrator();
  const result = await migrator.migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await result.execute();

  // Start MSW server
  server.listen({ onUnhandledRequest: "error" });

  // Route all requests to our handler
  const handleRequest = async (request: Request) => {
    const response = await api.handler(request);
    const data = (await response.json()) as Record<string, unknown>;
    return HttpResponse.json(data, {
      status: response.status,
      headers: response.headers,
    });
  };

  server.use(
    // Specific routes
    http.get(`${baseUrl}/hot-updater/bundles`, ({ request }) =>
      handleRequest(request),
    ),
    http.get(`${baseUrl}/hot-updater/bundles/:id`, ({ request }) =>
      handleRequest(request),
    ),
    http.post(`${baseUrl}/hot-updater/bundles`, ({ request }) =>
      handleRequest(request),
    ),
    http.delete(`${baseUrl}/hot-updater/bundles/:id`, ({ request }) =>
      handleRequest(request),
    ),
  );
});

afterEach(async () => {
  // Clean up database after each test
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

describe("Handler <-> Standalone Repository Integration", () => {
  it("Real integration: appendBundle + commitBundle → handler POST /bundles", async () => {
    // Create standalone repository pointing to our test server
    const repo = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
    })({ cwd: process.cwd() });

    const bundleId = uuidv7();
    const bundle = createTestBundle({
      id: bundleId,
      fileHash: "integration-hash-1",
    });

    // Standalone repository operations
    await repo.appendBundle(bundle);
    await repo.commitBundle(); // Triggers actual commit

    // Verify via handler that bundle was created
    const request = new Request(
      `${baseUrl}/hot-updater/bundles/${bundleId}`,
      {
        method: "GET",
      },
    );

    const response = await api.handler(request);
    expect(response.status).toBe(200);

    const retrieved = (await response.json()) as Bundle;
    expect(retrieved.id).toBe(bundleId);
    expect(retrieved.fileHash).toBe("integration-hash-1");
  });

  it("Real integration: getBundleById → handler GET /bundles/:id", async () => {
    // First, create a bundle directly via handler
    const bundleId = uuidv7();
    const bundle = createTestBundle({
      id: bundleId,
      fileHash: "get-hash-1",
    });

    await api.insertBundle(bundle);

    // Create standalone repository
    const repo = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
    })({ cwd: process.cwd() });

    // Use standalone repository to retrieve
    const retrieved = await repo.getBundleById(bundleId);

    expect(retrieved).toBeTruthy();
    expect(retrieved?.id).toBe(bundleId);
    expect(retrieved?.fileHash).toBe("get-hash-1");
  });

  it("Real integration: deleteBundle + commitBundle → handler DELETE /bundles/:id", async () => {
    // Create a bundle via handler
    const bundleId = uuidv7();
    const bundle = createTestBundle({
      id: bundleId,
      fileHash: "delete-hash-1",
    });

    await api.insertBundle(bundle);

    // Verify it exists
    const beforeDelete = await api.getBundleById(bundleId);
    expect(beforeDelete).toBeTruthy();

    // Create standalone repository
    const repo = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
    })({ cwd: process.cwd() });

    // Delete via standalone repository
    await repo.deleteBundle(bundle);
    await repo.commitBundle();

    // Verify it was deleted
    const afterDelete = await api.getBundleById(bundleId);
    expect(afterDelete).toBeNull();
  });

  it("Real integration: getBundles → handler GET /bundles", async () => {
    // Create multiple bundles
    await api.insertBundle(
      createTestBundle({ id: uuidv7(), channel: "production" }),
    );
    await api.insertBundle(
      createTestBundle({ id: uuidv7(), channel: "production" }),
    );
    await api.insertBundle(
      createTestBundle({ id: uuidv7(), channel: "staging" }),
    );

    // Create standalone repository
    const repo = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
    })({ cwd: process.cwd() });

    // Get all bundles
    const result = await repo.getBundles({ limit: 50, offset: 0 });

    expect(result.data).toHaveLength(3);
    expect(result.pagination.total).toBe(3);

    // Filter by channel
    const prodResult = await repo.getBundles({
      where: { channel: "production" },
      limit: 50,
      offset: 0,
    });

    expect(prodResult.data).toHaveLength(2);
  });

  it("Full E2E: create → retrieve → update → delete via standalone", async () => {
    const repo = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
    })({ cwd: process.cwd() });

    // Step 1: Create bundle via standalone
    const bundleId = uuidv7();
    const bundle = createTestBundle({
      id: bundleId,
      fileHash: "e2e-hash",
      enabled: true,
    });

    await repo.appendBundle(bundle);
    await repo.commitBundle();

    // Step 2: Retrieve via standalone
    const retrieved = await repo.getBundleById(bundleId);
    expect(retrieved).toBeTruthy();
    expect(retrieved?.enabled).toBe(true);

    // Step 3: Update via standalone
    await repo.updateBundle(bundleId, { enabled: false });
    await repo.commitBundle();

    // Verify update
    const updated = await repo.getBundleById(bundleId);
    expect(updated?.enabled).toBe(false);

    // Step 4: Delete via standalone
    await repo.deleteBundle(bundle);
    await repo.commitBundle();

    // Verify deletion
    const deleted = await repo.getBundleById(bundleId);
    expect(deleted).toBeNull();
  });

  it("Multiple bundles in single commit (standalone sends array)", async () => {
    const repo = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
    })({ cwd: process.cwd() });

    // Append multiple bundles
    const bundleId1 = uuidv7();
    const bundleId2 = uuidv7();
    const bundleId3 = uuidv7();
    await repo.appendBundle(createTestBundle({ id: bundleId1 }));
    await repo.appendBundle(createTestBundle({ id: bundleId2 }));
    await repo.appendBundle(createTestBundle({ id: bundleId3 }));

    // Commit all at once (standalone sends array in POST)
    await repo.commitBundle();

    // Verify all were created
    const bundle1 = await api.getBundleById(bundleId1);
    const bundle2 = await api.getBundleById(bundleId2);
    const bundle3 = await api.getBundleById(bundleId3);

    expect(bundle1).toBeTruthy();
    expect(bundle2).toBeTruthy();
    expect(bundle3).toBeTruthy();
  });

  it("Works with custom basePath configuration", async () => {
    // Create handler with custom basePath
    const customApi = createHotUpdater({
      database: kyselyAdapter({
        db: kysely,
        provider: "postgresql",
      }),
      basePath: "/api/v2",
    });

    // Setup MSW for custom basePath
    server.use(
      http.get(`${baseUrl}/api/v2/*`, async ({ request }) => {
        const response = await customApi.handler(request);
        return HttpResponse.json(
          (await response.json()) as Record<string, unknown>,
          {
            status: response.status,
          },
        );
      }),
      http.post(`${baseUrl}/api/v2/*`, async ({ request }) => {
        const response = await customApi.handler(request);
        return HttpResponse.json(
          (await response.json()) as Record<string, unknown>,
          {
            status: response.status,
          },
        );
      }),
    );

    // Create standalone repository with matching basePath
    const repo = standaloneRepository({
      baseUrl: `${baseUrl}/api/v2`,
    })({ cwd: process.cwd() });

    // Test create and retrieve
    const bundleId = uuidv7();
    const bundle = createTestBundle({
      id: bundleId,
      fileHash: "custom-hash",
    });

    await repo.appendBundle(bundle);
    await repo.commitBundle();

    const retrieved = await repo.getBundleById(bundleId);
    expect(retrieved).toBeTruthy();
    expect(retrieved?.fileHash).toBe("custom-hash");
  });

  it("Handler returns 404 when bundle not found (standalone handles gracefully)", async () => {
    const repo = standaloneRepository({
      baseUrl: `${baseUrl}/hot-updater`,
    })({ cwd: process.cwd() });

    // Try to get non-existent bundle
    const result = await repo.getBundleById("non-existent-bundle");

    // Standalone should return null gracefully
    expect(result).toBeNull();
  });
});
