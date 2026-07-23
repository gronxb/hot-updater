import { PGlite } from "@electric-sql/pglite";
import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  createBlobDatabasePlugin,
  createDatabaseClient,
} from "@hot-updater/plugin-core";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { uuidv7 } from "uuidv7";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { standaloneRepository } from "../../../plugins/standalone/src";
import { kyselyAdapter } from "./adapters/kysely";
import { createMigrator } from "./db";
import { supportsAnalytics } from "./db/types";
import { createHotUpdater } from "./index";

const db = new PGlite();
const kysely = new Kysely({ dialect: new PGliteDialect(db) });
const api = createHotUpdater({
  database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
  basePath: "/hot-updater",
  routes: { updateCheck: true, bundles: true, analytics: true },
});
const baseUrl = "http://localhost:3000";
const server = setupServer();
let bundleEventRequestCount = 0;

const handleRequest = async (request: Request) => {
  if (
    new URL(request.url).pathname.includes("/events") ||
    new URL(request.url).pathname.includes("/installations")
  ) {
    bundleEventRequestCount += 1;
  }
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
  bundleEventRequestCount = 0;
  await db.exec("DELETE FROM bundle_patches");
  await db.exec("DELETE FROM bundle_events");
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

const parseStoredJson = (value: string): unknown => JSON.parse(value);

const createInMemoryBlobDatabase = (store: Record<string, string>) =>
  createBlobDatabasePlugin({
    name: "blob-test",
    plugin: () => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix: string) =>
        Object.keys(store).filter((key) => key.startsWith(prefix)),
      loadObject: async (key: string) => {
        const value = store[key];
        return value ? parseStoredJson(value) : null;
      },
      uploadObject: async (key: string, data: unknown) => {
        store[key] = JSON.stringify(data);
      },
      compareAndSwapObject: async (key, expected, data) => {
        const current = store[key] ? parseStoredJson(store[key]) : null;
        if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
        store[key] = JSON.stringify(data);
        return true;
      },
      invalidatePaths: async () => {},
    }),
  });

describe("Handler <-> Standalone Repository Integration", () => {
  it("discovers a record-backed standalone remote without user config", async () => {
    // Given
    const consoleApi = createHotUpdater({
      database: standaloneRepository({
        baseUrl: `${baseUrl}/hot-updater`,
      }),
      basePath: "/console",
      routes: { updateCheck: true, bundles: true },
    });
    const probe = Reflect.get(
      consoleApi,
      Symbol.for("@hot-updater/internal/analytics-capability-probe"),
    ) as () => Promise<unknown>;

    // When / Then
    expect(supportsAnalytics(consoleApi)).toBe(true);
    await expect(probe()).resolves.toEqual({
      analytics: true,
      mode: "bounded",
      maxMatchingRows: 50_000,
      eventIngestion: false,
      analyticsQueries: true,
    });
    const version = await consoleApi.handler(
      new Request(`${baseUrl}/console/version`),
    );
    await expect(version.json()).resolves.toMatchObject({
      capabilities: { analytics: true, mode: "bounded" },
    });
    expect(bundleEventRequestCount).toBe(0);
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

  it("proxies analytics through the standalone repository", async () => {
    if (!supportsAnalytics(api)) {
      throw new Error("Expected Kysely Analytics support.");
    }
    const bundleId = uuidv7();
    const installId = "standalone-analytics-install";
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.UTC(2026, 6, 17, 12));
    await api.insertBundle(createTestBundle({ id: bundleId }));
    await api.appendBundleEvent({
      type: "UPDATE_APPLIED",
      installId,
      fromBundleId: NIL_UUID,
      toBundleId: bundleId,
      userId: "integration-user",
      username: "Integration User",
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "default",
      updateStrategy: "appVersion",
      fingerprintHash: null,
    });
    now.mockReturnValue(Date.UTC(2026, 6, 17, 12, 0, 0, 1));
    await api.appendBundleEvent({
      type: "RECOVERED",
      installId,
      fromBundleId: bundleId,
      toBundleId: NIL_UUID,
      userId: "integration-user",
      username: "Integration User",
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "default",
      updateStrategy: "appVersion",
      fingerprintHash: null,
    });
    now.mockReturnValue(Date.UTC(2026, 6, 17, 12, 0, 0, 2));
    const consoleApi = createHotUpdater({
      database: standaloneRepository({
        baseUrl: `${baseUrl}/hot-updater`,
      }),
      basePath: "/console",
      routes: { updateCheck: true, bundles: true },
    });
    if (!supportsAnalytics(consoleApi)) {
      throw new Error("Expected standalone Analytics support.");
    }

    await expect(consoleApi.getBundleEventSummary(bundleId)).resolves.toEqual({
      installed: 1,
      recovered: 1,
    });
    await expect(
      consoleApi.getBundleEventAnalytics(bundleId, "24h", 50, 0),
    ).resolves.toMatchObject({
      summary: { installed: 1, recovered: 1 },
      recentEvents: { pagination: { total: 2 } },
    });
    await expect(consoleApi.getBundleEventOverview()).resolves.toMatchObject({
      trackedInstallations: 1,
      bundles: [{ installations: 1 }],
    });
    await expect(
      consoleApi.searchInstallations("integration-user", 50, 0),
    ).resolves.toMatchObject({
      data: [
        {
          installId,
          latestStatus: "RECOVERED",
          userId: "integration-user",
        },
      ],
      pagination: { total: 1 },
    });
    await expect(
      consoleApi.getInstallationHistory(installId, 50, 0),
    ).resolves.toMatchObject({
      data: [{ type: "RECOVERED" }, { type: "UPDATE_APPLIED" }],
      pagination: { total: 2 },
    });
    now.mockRestore();
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
      createStandaloneClient().getBundleById(uuidv7()),
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
    const blobConsoleApi = createHotUpdater({
      database: standaloneRepository({
        baseUrl: `${baseUrl}/blob-hot-updater`,
      }),
    });
    const probe = Reflect.get(
      blobConsoleApi,
      Symbol.for("@hot-updater/internal/analytics-capability-probe"),
    ) as () => Promise<unknown>;
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

    await expect(probe()).resolves.toEqual({
      analytics: false,
      eventIngestion: false,
      analyticsQueries: false,
    });
    const version = await blobConsoleApi.handler(
      new Request(`${baseUrl}/api/version`),
    );
    await expect(version.json()).resolves.toMatchObject({
      capabilities: { analytics: false },
    });
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
