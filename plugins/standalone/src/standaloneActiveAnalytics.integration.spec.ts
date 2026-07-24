import { type IncomingHttpHeaders, type Server, createServer } from "node:http";

import {
  attachCapabilityContribution,
  type DatabasePlugin,
} from "@hot-updater/plugin-core";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { createHotUpdater } from "@hot-updater/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { analytics } from "../../../packages/analytics/src/analytics";
import {
  analyticsProviderToken,
  withAnalyticsProvider,
} from "../../../packages/analytics/src/provider";
import { createInMemoryDatabasePlugin } from "../../../packages/test-utils/test/inMemoryDatabasePlugin";
import { standaloneRepository } from "./index";

const AS_OF_MS = Date.UTC(2026, 6, 18, 12);
const sourceManifest = analytics({
  missingCapability: "error",
  queryAccess: "public",
});
const source = createHotUpdater({
  basePath: "/hot-updater",
  coreRoutes: { bundles: false, updateCheck: false },
  database: withAnalyticsProvider(createInMemoryDatabasePlugin()),
  plugins: [sourceManifest],
});
let baseUrl = "";
let httpServer: Server | undefined;
let activeRequests = 0;
let forwardedHeader: string | null = null;

const toHeaders = (input: IncomingHttpHeaders): Headers => {
  const headers = new Headers();
  Object.entries(input).forEach(([name, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  });
  return headers;
};

beforeAll(async () => {
  httpServer = createServer(async (incoming, outgoing) => {
    const request = new Request(`${baseUrl}${incoming.url ?? "/"}`, {
      headers: toHeaders(incoming.headers),
      method: incoming.method,
    });
    const url = new URL(request.url);
    if (url.pathname.endsWith("/api/installations/active")) {
      activeRequests += 1;
      forwardedHeader = request.headers.get("x-analytics-context");
    }
    const response = await source.handler(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => {
      outgoing.setHeader(name, value);
    });
    outgoing.end(await response.text());
  });
  await new Promise<void>((resolve, reject) => {
    httpServer?.once("error", reject);
    httpServer?.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP test server.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => {
    if (httpServer === undefined) {
      resolve();
      return;
    }
    httpServer.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
});

const createBundle = (id: string) => ({
  channel: "production",
  enabled: true,
  fileHash: "standalone-active-hash",
  fingerprintHash: null,
  gitCommitHash: null,
  id,
  message: null,
  platform: "ios" as const,
  shouldForceUpdate: false,
  storageUri: "test://standalone-active",
  targetAppVersion: "*",
});

const unchangedEvent = (installId: string, bundleId: string) => ({
  appVersion: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprintHash: null,
  fromBundleId: null,
  installId,
  platform: "ios" as const,
  toBundleId: bundleId,
  type: "UNCHANGED" as const,
  updateStrategy: null,
  userId: "shared-alias",
  username: "Shared Alias",
});

const useWorkspaceAnalyticsToken = (
  repository: DatabasePlugin,
): DatabasePlugin => {
  const [contribution] = getCapabilityContributions(repository);
  if (contribution === undefined) {
    throw new Error("Expected standalone Analytics capability.");
  }
  return attachCapabilityContribution(
    { ...repository },
    {
      create: contribution.create,
      token: analyticsProviderToken,
    },
  );
};

describe("standalone active installation Analytics integration", () => {
  it("delegates two installs sharing one exact alias", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(AS_OF_MS - 1_000);
    const bundleId = "standalone-active-bundle";
    await source.insertBundle(createBundle(bundleId));
    await source.features.analytics.appendBundleEvent(
      unchangedEvent("standalone-active-a", bundleId),
    );
    await source.features.analytics.appendBundleEvent(
      unchangedEvent("standalone-active-b", bundleId),
    );
    now.mockReturnValue(AS_OF_MS);
    const consoleManifest = analytics({
      missingCapability: "error",
      queryAccess: "public",
    });
    const consoleRuntime = createHotUpdater({
      basePath: "/console",
      coreRoutes: { bundles: false, updateCheck: false },
      database: useWorkspaceAnalyticsToken(
        standaloneRepository({
          baseUrl: `${baseUrl}/hot-updater`,
          routes: {
            activeInstallationOverview: () => ({
              headers: {
                "X-Analytics-Context": "console-request",
              },
              path: "/api/installations/active",
            }),
          },
        }),
      ),
      plugins: [consoleManifest],
    });

    await expect(
      consoleRuntime.features.analytics.getActiveInstallationOverview({
        userId: "shared-alias",
        window: "24h",
      }),
    ).resolves.toMatchObject({
      activeInstallations: 2,
      asOfMs: AS_OF_MS,
      bundles: [{ bundleId, installations: 2 }],
      window: "24h",
    });
    expect(activeRequests).toBe(1);
    expect(forwardedHeader).toBe("console-request");
  });
});
