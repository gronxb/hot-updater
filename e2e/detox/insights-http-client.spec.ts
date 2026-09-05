import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "../../packages/server/src/index.ts";
import { createInMemoryDatabasePlugin } from "../../packages/test-utils/test/inMemoryDatabasePlugin.ts";
import {
  readObservedInsightsEvent,
  verifyConsoleInsights,
  type ObservedInsightsEvent,
} from "./console-insights-qa.ts";
import {
  ConsoleInsightsHttpError,
  createConsoleInsightsHttpClient,
} from "./insights-http-client.ts";

describe("Detox Insights HTTP client", () => {
  it("loads under the Node strip-types mode used by the Detox control server", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--eval",
        `import(${JSON.stringify(new URL("./insights-http-client.ts", import.meta.url).href)})`,
      ],
      { encoding: "utf8" },
    );

    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.status).toBe(0);
  });

  it("queries the deployed server when config only has a standalone admin client", async () => {
    // Given: the CLI config database is an HTTP admin carrier. It must not
    // be treated as the deployed server's component-data adapter.
    const standaloneRepositoryLike = {
      findMany: vi.fn(() => {
        throw new Error("admin database must not serve Insights");
      }),
      name: "standaloneRepository",
    };
    const serverDatabase = createInMemoryDatabasePlugin();
    const deployedServer = createHotUpdater({
      database: serverDatabase,
      clientAccess: { type: "public" },
    });
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      url.pathname = url.pathname.replace("/hot-updater/admin", "") || "/";
      return deployedServer.handlers.admin(new Request(url, request));
    });
    const client = createConsoleInsightsHttpClient({
      baseUrl: "http://127.0.0.1:3007/hot-updater/admin/",
      fetch,
      headers: { Authorization: "Bearer test-token" },
    });

    // When
    const overview = await client.getReportingOverview({
      platform: "ios",
      channel: "production",
      window: "24h",
    });

    // Then
    expect(overview.reportingInstallations.count).toBe(0);
    expect(standaloneRepositoryLike.findMany).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3007/hot-updater/admin/overview?platform=ios&channel=production&window=24h",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const request = fetch.mock.calls[0]![1];
    expect(new Headers(request?.headers).get("Authorization")).toBe(
      "Bearer test-token",
    );
  });

  it.each([404, 503])(
    "fails an Insights-required profile when the server returns HTTP %s",
    async (status) => {
      const client = createConsoleInsightsHttpClient({
        baseUrl: "http://127.0.0.1:3007/hot-updater/admin",
        fetch: vi.fn(async () => new Response(null, { status })),
      });

      await expect(client.listEvents({ limit: 1 })).rejects.toEqual(
        expect.objectContaining<Partial<ConsoleInsightsHttpError>>({ status }),
      );
    },
  );

  it("traces all three bundle outcomes while recovery moves the latest installation to its destination", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
    try {
      const sinceMs = Date.now();
      const server = createHotUpdater({
        database: createInMemoryDatabasePlugin(),
        clientAccess: { type: "public" },
      });
      const client = createConsoleInsightsHttpClient({
        baseUrl: "https://example.com",
        fetch: async (input, init) =>
          server.handlers.admin(new Request(input, init)),
      });
      const base = {
        appVersion: "1.0.0",
        channel: "production",
        cohort: "default",
        fingerprintHash: null,
        fromReleaseId: null,
        installId: "detox-install",
        platform: "ios",
        toReleaseId: null,
        updateStrategy: "appVersion",
        userId: "detox-e2e",
      };
      const observedEvents: ObservedInsightsEvent[] = [];
      for (const transition of [
        {
          type: "UPDATE_APPLIED",
          fromBundleId: "bundle-a",
          toBundleId: "bundle-b",
        },
        {
          type: "RELEASE_ADOPTED",
          fromBundleId: "bundle-b",
          toBundleId: "bundle-b",
        },
        { type: "RECOVERED", fromBundleId: "bundle-b", toBundleId: "bundle-a" },
        {
          type: "UNCHANGED",
          fromBundleId: null,
          toBundleId: "bundle-a",
          updateStrategy: null,
        },
      ]) {
        const report = { ...base, ...transition };
        const response = await server.handlers.client(
          new Request("https://example.com/events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(report),
          }),
        );
        expect(response.status).toBe(204);
        observedEvents.push(readObservedInsightsEvent(report, Date.now())!);
        vi.advanceTimersByTime(1);
      }
      for (const scope of [
        { platform: "android", channel: "production" },
        { platform: "ios", channel: "beta" },
      ]) {
        const response = await server.handlers.client(
          new Request("https://example.com/events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...base,
              ...scope,
              installId: `${scope.platform}-${scope.channel}`,
              type: "UPDATE_APPLIED",
              fromBundleId: "bundle-a",
              toBundleId: "bundle-b",
            }),
          }),
        );
        expect(response.status).toBe(204);
        vi.advanceTimersByTime(1);
      }

      const evidence = await verifyConsoleInsights(client, {
        observedEvents,
        sinceMs,
      });
      expect(evidence).toMatchObject({
        reportingInstallations: 1,
        selectedBundleInstallations: 1,
        eventType: "UNCHANGED",
        outcomes: [
          { bundleId: "bundle-b", count: 1, outcome: "recovered" },
          { bundleId: "bundle-b", count: 1, outcome: "adopted" },
          { bundleId: "bundle-b", count: 1, outcome: "applied" },
        ],
      });
      const source = await client.getReportingOverview({
        platform: "ios",
        channel: "production",
        window: "24h",
        bundleId: "bundle-b",
      });
      expect(source.bundle).toMatchObject({
        reportingInstallations: { count: 0 },
        appliedReports: { count: 1 },
        recoveredReports: { count: 1 },
        adoptedReports: { count: 1 },
      });
      const destination = await client.getReportingOverview({
        platform: "ios",
        channel: "production",
        window: "24h",
        bundleId: "bundle-a",
      });
      expect(destination.bundle).toMatchObject({
        reportingInstallations: { count: 1 },
        appliedReports: { count: 0 },
        recoveredReports: { count: 0 },
        adoptedReports: { count: 0 },
      });
      await expect(
        client.listEvents({
          beforeReceivedAtMs: destination.beforeReceivedAtMs,
          sinceMs: destination.sinceMs,
          bundle: {
            platform: "ios",
            channel: "production",
            bundleId: "bundle-a",
            outcome: "recovered",
          },
        }),
      ).resolves.toMatchObject({ data: [], nextCursor: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("encodes exact identities and cursor page parameters", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        beforeReceivedAtMs: 10,
        data: [],
        nextCursor: null,
      }),
    );
    const client = createConsoleInsightsHttpClient({
      baseUrl: "https://example.com/hot-updater/admin",
      fetch,
    });

    await client.listEvents({ cursor: "event/a b", limit: 25 });
    await client.getInstallation({ installId: "install/a b" });
    await client.pageInstallationsByCurrentUserId({
      userId: "user/a b",
      cursor: "user/a b",
      limit: 25,
    });
    await client.listInstallationEvents({
      installId: "install/a b",
      beforeReceivedAtMs: 10,
      cursor: "movement/a b",
      limit: 25,
    });
    await client.listEvents({
      beforeReceivedAtMs: 10,
      sinceMs: 1,
      bundle: {
        platform: "ios",
        channel: "beta/a b",
        bundleId: "bundle-id",
        outcome: "recovered",
      },
    });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/hot-updater/admin/events?cursor=event%2Fa+b&limit=25",
      "https://example.com/hot-updater/admin/installations/install%2Fa%20b",
      "https://example.com/hot-updater/admin/installations?userId=user%2Fa+b&cursor=user%2Fa+b&limit=25",
      "https://example.com/hot-updater/admin/installations/install%2Fa%20b/events?beforeReceivedAtMs=10&cursor=movement%2Fa+b&limit=25",
      "https://example.com/hot-updater/admin/events?beforeReceivedAtMs=10&sinceMs=1&platform=ios&channel=beta%2Fa+b&bundleId=bundle-id&outcome=recovered",
    ]);
  });
});
