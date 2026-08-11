import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { analytics } from "../../packages/analytics/src/index.ts";
import { createHotUpdater } from "../../packages/server/src/index.ts";
import {
  attachUniversalComponentDataAdapter,
  createDatabasePlugin,
} from "../../plugins/plugin-core/src/index.ts";
import {
  ConsoleAnalyticsHttpError,
  createConsoleAnalyticsHttpClient,
} from "./analytics-http-client.ts";

describe("Detox Analytics HTTP client", () => {
  it("loads under the Node strip-types mode used by the Detox control server", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--eval",
        `import(${JSON.stringify(new URL("./analytics-http-client.ts", import.meta.url).href)})`,
      ],
      { encoding: "utf8" },
    );

    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.status).toBe(0);
  });

  it("queries the deployed server when config only has a standalone management client", async () => {
    // Given: the CLI config database is an HTTP management carrier. It must not
    // be treated as the deployed server's component-data adapter.
    const standaloneRepositoryLike = {
      findMany: vi.fn(() => {
        throw new Error("management database must not serve Analytics");
      }),
      name: "standaloneRepository",
    };
    const serverDatabase = attachUniversalComponentDataAdapter(
      createDatabasePlugin({
        name: "deployed-server-database",
        plugin: () => ({
          count: vi.fn(async () => 0),
          create: vi.fn(async ({ data }) => data),
          delete: vi.fn(async () => undefined),
          findMany: vi.fn(async () => []),
          findOne: vi.fn(async () => null),
          update: vi.fn(async () => null),
        }),
      }),
      () => ({
        bind(schema) {
          return {
            schema,
            append: vi.fn(async () => undefined),
            assertReady: vi.fn(async () => undefined),
            create: vi.fn(async () => "created" as const),
            get: vi.fn(async () => null),
            orderedScan: vi.fn(async () => []),
          };
        },
      }),
    );
    const deployedServer = createHotUpdater({
      basePath: "/hot-updater",
      database: serverDatabase,
      plugins: [analytics({ queryAccess: "public" })],
    });
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) =>
      deployedServer.handler(new Request(input, init)),
    );
    const client = createConsoleAnalyticsHttpClient({
      baseUrl: "http://127.0.0.1:3007/hot-updater/",
      fetch,
      headers: { Authorization: "Bearer test-token" },
    });

    // When
    const overview = await client.getOverview();

    // Then
    expect(overview.trackedInstallations).toBe(0);
    expect(standaloneRepositoryLike.findMany).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3007/hot-updater/api/installations/overview",
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
    "fails an Analytics-required profile when the server returns HTTP %s",
    async (status) => {
      const client = createConsoleAnalyticsHttpClient({
        baseUrl: "http://127.0.0.1:3007/hot-updater",
        fetch: vi.fn(async () => new Response(null, { status })),
      });

      await expect(client.getCapabilities()).rejects.toEqual(
        expect.objectContaining<Partial<ConsoleAnalyticsHttpError>>({
          status,
        }),
      );
    },
  );

  it("encodes route parameters and query values", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      }),
    );
    const client = createConsoleAnalyticsHttpClient({
      baseUrl: "https://example.com/hot-updater",
      fetch,
    });

    await client.searchInstallations("alias/a b");
    await client.getHistory("install/a b");

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/hot-updater/api/installations?query=alias%2Fa%20b&limit=50&offset=0",
      "https://example.com/hot-updater/api/installations/install%2Fa%20b/events?limit=50&offset=0",
    ]);
  });
});
