import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createPrismaInsightsSchemaProvisioner } from "../../packages/server/src/adapters/prisma.ts";
import { generateEvidencePrismaClient } from "../../packages/server/src/adapters/sqlInsights/prisma/fixtures/evidenceRuntime.ts";
import { createPrismaInsightsModel } from "../../packages/server/src/adapters/sqlInsights/prisma/model.ts";
import { createHotUpdater } from "../../packages/server/src/index.ts";
import { createInMemoryDatabasePlugin } from "../../packages/test-utils/test/inMemoryDatabasePlugin.ts";
import { verifyConsoleInsights } from "./console-insights-qa.ts";
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
    vi.spyOn(serverDatabase.models.insights, "getReport").mockResolvedValue({
      state: "ready",
      versions: {
        schemaVersion: "1",
        storageVersion: "2",
        projectionGeneration: "projection-1",
        sourceGeneration: "source-1",
      },
      data: {
        id: "019c1680-9e83-7000-8000-000000000001",
        asOfMs: 1,
        completedAtMs: 2,
        sourceGeneration: "source-1",
        accuracy: "exact",
        kind: "installationOverview",
        summary: { trackedInstallations: 0 },
      },
    });
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
    const overview = await client.getOverview();

    // Then
    expect(overview.trackedInstallations).toBe(0);
    expect(standaloneRepositoryLike.findMany).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3007/hot-updater/admin/installations/overview",
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

      await expect(client.getCapabilities()).rejects.toEqual(
        expect.objectContaining<Partial<ConsoleInsightsHttpError>>({
          status,
        }),
      );
    },
  );

  it("polls one preparation job until the endpoint is ready", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ state: "preparing", job: { id: "report-job" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ state: "preparing", job: { id: "report-job" } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          state: "ready",
          data: { summary: { trackedInstallations: 1 } },
        }),
      );
    const client = createConsoleInsightsHttpClient({
      baseUrl: "https://example.com/hot-updater/admin",
      fetch,
    });

    await expect(client.getOverview()).resolves.toEqual({
      trackedInstallations: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails immediately when a preparation job changes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ state: "preparing", job: { id: "report-job-1" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ state: "preparing", job: { id: "report-job-2" } }),
      );
    const client = createConsoleInsightsHttpClient({
      baseUrl: "https://example.com/hot-updater/admin",
      fetch,
    });

    await expect(client.getOverview()).rejects.toThrow(
      "changed preparation jobs while polling",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops after the per-job preparation request budget", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ state: "preparing", job: { id: "report-job" } }),
    );
    const client = createConsoleInsightsHttpClient({
      baseUrl: "https://example.com/hot-updater/admin",
      fetch,
    });

    await expect(client.getOverview()).rejects.toThrow(
      "did not become ready within 32 requests",
    );
    expect(fetch).toHaveBeenCalledTimes(32);
  });

  it("does not poll a malformed preparation envelope", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ state: "preparing", job: {} }),
    );
    const client = createConsoleInsightsHttpClient({
      baseUrl: "https://example.com/hot-updater/admin",
      fetch,
    });

    await expect(client.getOverview()).rejects.toThrow(
      "returned an invalid preparation job",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry a failed preparation job", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ state: "failed", error: { code: "test-failure" } }),
    );
    const client = createConsoleInsightsHttpClient({
      baseUrl: "https://example.com/hot-updater/admin",
      fetch,
    });

    await expect(client.getOverview()).rejects.toThrow(
      "Installation overview is not ready yet",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("encodes route parameters and query values", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        state: "ready",
        data: {
          data: [],
          total: { state: "exact", value: 0 },
        },
      }),
    );
    const client = createConsoleInsightsHttpClient({
      baseUrl: "https://example.com/hot-updater/admin",
      fetch,
    });

    await client.searchInstallations("alias/a b");
    await client.getHistory("install/a b");

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/hot-updater/admin/installations?kind=contains&query=alias%2Fa%20b&limit=50",
      "https://example.com/hot-updater/admin/events?installId=install%2Fa%20b&limit=50",
    ]);
  });

  it("prepares each Prisma bundle report within its own bounded request budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "detox-prisma-insights-"));
    const databasePath = join(directory, "insights.db");
    const fixtureDirectory = fileURLToPath(
      new URL(
        "../../packages/server/src/adapters/sqlInsights/prisma/fixtures/sqlite",
        import.meta.url,
      ),
    );
    const generated = await generateEvidencePrismaClient(
      join(fixtureDirectory, "schema.prisma"),
      join(directory, "generated"),
      `file:${databasePath}`,
    );
    const prisma = new generated.PrismaClient({
      datasourceUrl: `file:${databasePath}`,
    });

    try {
      await prisma.$executeRawUnsafe(`create table bundle_events (
        id text primary key, type text not null, install_id text not null,
        user_id text null, username text null, from_release_id text null,
        from_bundle_id text null, to_release_id text null,
        to_bundle_id text not null, platform text not null,
        app_version text not null, channel text not null, cohort text not null,
        update_strategy text null, fingerprint_hash text null,
        sdk_version text null, received_at_ms real not null
      )`);
      const namespace = "00000000-0000-7000-8000-00000000e002";
      const plan = await createPrismaInsightsSchemaProvisioner(
        prisma,
        "sqlite",
        namespace,
      ).plan();
      await plan.execute();
      const memory = createInMemoryDatabasePlugin();
      const server = createHotUpdater({
        database: {
          ...memory,
          name: "in-memory-with-prisma-insights",
          models: {
            ...memory.models,
            insights: createPrismaInsightsModel(prisma, "sqlite", namespace),
          },
        },
        clientAccess: { type: "public" },
      });
      const bundleIds = Array.from(
        { length: 4 },
        (_, index) =>
          `00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
      );
      const sinceMs = Date.now() - 1_000;
      const observedEvents = [];
      for (const [index, bundleId] of bundleIds.entries()) {
        const fromBundleId = `00000000-0000-7000-8001-${String(index + 1).padStart(12, "0")}`;
        const installId = `prisma-report-readiness-${index + 1}`;
        const response = await server.handlers.client(
          new Request("http://localhost/events", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              appVersion: "1.0.0",
              channel: "production",
              cohort: "default",
              fingerprintHash: null,
              fromBundleId,
              fromReleaseId: null,
              installId,
              platform: "ios",
              sdkVersion: "2.0.0",
              toBundleId: bundleId,
              toReleaseId: null,
              type: "UPDATE_APPLIED",
              updateStrategy: "appVersion",
            }),
          }),
        );
        expect(response.status).toBe(204);
        observedEvents.push({
          fromBundleId,
          installId,
          observedAtMs: Date.now(),
          toBundleId: bundleId,
          type: "UPDATE_APPLIED" as const,
        });
      }

      let activeBundleReportRequests = 0;
      let maxActiveBundleReportRequests = 0;
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const isBundleReport = url.pathname.endsWith("/events/insights");
        if (isBundleReport) {
          activeBundleReportRequests += 1;
          maxActiveBundleReportRequests = Math.max(
            maxActiveBundleReportRequests,
            activeBundleReportRequests,
          );
        }
        url.pathname = url.pathname.replace(/^\/admin/, "") || "/";
        try {
          return await server.handlers.admin(new Request(url, request));
        } finally {
          if (isBundleReport) activeBundleReportRequests -= 1;
        }
      });
      const client = createConsoleInsightsHttpClient({
        baseUrl: "http://localhost/admin",
        fetch,
      });

      const evidence = await verifyConsoleInsights(client, bundleIds, {
        observedEvents,
        sinceMs,
      });

      expect(evidence.trackedInstallations).toBe(4);
      expect(maxActiveBundleReportRequests).toBe(1);
    } finally {
      await prisma.$disconnect();
      await generated.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
