import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "../../packages/server/src/index.ts";
import { createInMemoryDatabasePlugin } from "../../packages/test-utils/test/inMemoryDatabasePlugin.ts";
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
    const active = await client.getActiveOverview();

    // Then
    expect(active.activeInstallations).toBe(0);
    expect(standaloneRepositoryLike.findMany).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3007/hot-updater/admin/installations/active?window=24h",
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

      await expect(client.pageEvents({ limit: 1 })).rejects.toEqual(
        expect.objectContaining<Partial<ConsoleInsightsHttpError>>({ status }),
      );
    },
  );

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

    await client.pageEvents({ cursor: "event/a b", limit: 25 });
    await client.getInstallation("install/a b");
    await client.pageInstallationsByCurrentUserId("user/a b", {
      cursor: "user/a b",
      limit: 25,
    });
    await client.pageInstallationEvents("install/a b", {
      beforeReceivedAtMs: 10,
      cursor: "movement/a b",
      limit: 25,
    });

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/hot-updater/admin/events?cursor=event%2Fa+b&limit=25",
      "https://example.com/hot-updater/admin/installations/install%2Fa%20b",
      "https://example.com/hot-updater/admin/installations?userId=user%2Fa+b&cursor=user%2Fa+b&limit=25",
      "https://example.com/hot-updater/admin/installations/install%2Fa%20b/events?beforeReceivedAtMs=10&cursor=movement%2Fa+b&limit=25",
    ]);
  });
});
