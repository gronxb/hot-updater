import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "../../packages/server/src/index.ts";
import { createInMemoryDatabasePlugin } from "../../packages/test-utils/test/inMemoryDatabasePlugin.ts";
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

  it("queries the deployed server when config only has a standalone admin client", async () => {
    // Given: the CLI config database is an HTTP admin carrier. It must not
    // be treated as the deployed server's component-data adapter.
    const standaloneRepositoryLike = {
      findMany: vi.fn(() => {
        throw new Error("admin database must not serve Analytics");
      }),
      name: "standaloneRepository",
    };
    const serverDatabase = createInMemoryDatabasePlugin();
    const deployedServer = createHotUpdater({
      features: { analytics: true },
      clientBasePath: "/hot-updater",
      database: serverDatabase,
    });
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      url.pathname = url.pathname.replace("/hot-updater/admin", "") || "/";
      return deployedServer.handlers.admin(new Request(url, request));
    });
    const client = createConsoleAnalyticsHttpClient({
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
    "fails an Analytics-required profile when the server returns HTTP %s",
    async (status) => {
      const client = createConsoleAnalyticsHttpClient({
        baseUrl: "http://127.0.0.1:3007/hot-updater/admin",
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
      baseUrl: "https://example.com/hot-updater/admin",
      fetch,
    });

    await client.searchInstallations("alias/a b");
    await client.getHistory("install/a b");

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/hot-updater/admin/installations?query=alias%2Fa%20b&limit=50&offset=0",
      "https://example.com/hot-updater/admin/installations/install%2Fa%20b/events?limit=50&offset=0",
    ]);
  });
});
