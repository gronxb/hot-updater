import { PGlite } from "@electric-sql/pglite";
import type { Bundle } from "@hot-updater/core";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { standaloneRepository } from "../../../plugins/standalone/src";
import { kyselyAdapter } from "./adapters/kysely";
import { createMigrator } from "./db";
import { supportsAnalytics } from "./db/types";
import { createHotUpdater } from "./index";

const BASE_URL = "http://localhost:3105";
const AS_OF_MS = Date.UTC(2026, 6, 18, 12);
const database = new PGlite();
const kysely = new Kysely({ dialect: new PGliteDialect(database) });
const sourceApi = createHotUpdater({
  database: kyselyAdapter({ db: kysely, provider: "postgresql" }),
  basePath: "/hot-updater",
  routes: { updateCheck: true, bundles: true },
});
const server = setupServer();
let activeRequests = 0;
let forwardedHeader: string | null = null;

beforeAll(async () => {
  const migration = await createMigrator(sourceApi).migrateToLatest({
    mode: "from-schema",
    updateSettings: true,
  });
  await migration.execute();
  server.listen({ onUnhandledRequest: "error" });
  server.use(
    http.all(`${BASE_URL}/hot-updater/*`, async ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/api/installations/active")) {
        activeRequests += 1;
        forwardedHeader = request.headers.get("x-analytics-context");
      }
      const response = await sourceApi.handler(request);
      return new HttpResponse(await response.text(), {
        status: response.status,
        headers: response.headers,
      });
    }),
  );
});

afterAll(async () => {
  vi.restoreAllMocks();
  server.close();
  await kysely.destroy();
  await database.close();
});

const createBundle = (id: string): Bundle => ({
  id,
  platform: "ios",
  channel: "production",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "standalone-active-hash",
  gitCommitHash: null,
  message: null,
  targetAppVersion: "*",
  storageUri: "test://standalone-active",
  fingerprintHash: null,
});

const unchangedEvent = (installId: string, bundleId: string) => ({
  type: "UNCHANGED" as const,
  installId,
  fromBundleId: null,
  toBundleId: bundleId,
  userId: "shared-alias",
  username: "Shared Alias",
  platform: "ios" as const,
  appVersion: "1.0.0",
  channel: "production",
  cohort: "default",
  updateStrategy: null,
  fingerprintHash: null,
});

describe("standalone active installation handler integration", () => {
  it("delegates two installs sharing one exact alias", async () => {
    if (!supportsAnalytics(sourceApi)) {
      throw new Error("Expected source Analytics support.");
    }
    const now = vi.spyOn(Date, "now").mockReturnValue(AS_OF_MS - 1_000);
    const bundleId = uuidv7();
    await sourceApi.insertBundle(createBundle(bundleId));
    await sourceApi.appendBundleEvent(
      unchangedEvent("standalone-active-a", bundleId),
    );
    await sourceApi.appendBundleEvent(
      unchangedEvent("standalone-active-b", bundleId),
    );
    now.mockReturnValue(AS_OF_MS);
    const consoleApi = createHotUpdater({
      database: standaloneRepository({
        baseUrl: `${BASE_URL}/hot-updater`,
        routes: {
          activeInstallationOverview: () => ({
            path: "/api/installations/active",
            headers: {
              "X-Analytics-Context": "console-request",
            },
          }),
        },
        supportsAnalytics: true,
      }),
      basePath: "/console",
      routes: { updateCheck: true, bundles: true },
    });

    expect(supportsAnalytics(consoleApi)).toBe(true);
    if (!supportsAnalytics(consoleApi)) {
      throw new Error("Expected standalone Analytics support.");
    }
    await expect(
      consoleApi.getActiveInstallationOverview({
        window: "24h",
        userId: "shared-alias",
      }),
    ).resolves.toMatchObject({
      asOfMs: AS_OF_MS,
      window: "24h",
      activeInstallations: 2,
      bundles: [{ bundleId, installations: 2 }],
    });
    expect(activeRequests).toBe(1);
    expect(forwardedHeader).toBe("console-request");
  });
});
