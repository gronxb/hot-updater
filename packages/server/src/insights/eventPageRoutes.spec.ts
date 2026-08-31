import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type InsightsEventQueries,
} from "@hot-updater/plugin-core";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { API_KEY_HEADER_NAME } from "../apiKeys";
import { createHotUpdater } from "../createHotUpdaterCore";
import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";

const setup = (native = true) => {
  const database = createInMemoryDatabasePlugin();
  const page = vi
    .fn<InsightsEventQueries["page"]>()
    .mockResolvedValue({ rows: [], nextCursor: null });
  const scan = vi.spyOn(database.models.insights, "scan");
  const server = createHotUpdater({
    clientAccess: { type: "api-key" },
    database: {
      ...database,
      models: {
        ...database.models,
        insights: {
          ...database.models.insights,
          ...(native
            ? {
                events: { version: 1 as const, scopes: ["all" as const], page },
              }
            : {}),
        },
      },
    },
  });
  return { server, page, scan };
};

const request = (query = "") =>
  new Request(
    `https://example.com/insights/v1/events${query ? `?${query}` : ""}`,
  );

afterEach(() => vi.useRealTimers());

describe("versioned admin event pages", () => {
  it("requires the host admin credential even when the caller holds a valid client API key", async () => {
    const { server, page } = setup();
    const { apiKey } = await server.apiKeys.create({ name: "Test client" });
    const app = new Hono();
    app.use("/hot-updater/admin/*", bearerAuth({ token: "test-admin-token" }));
    app.mount("/hot-updater/admin", server.handlers.admin);
    app.mount("/hot-updater", server.handlers.client);
    const path = "/hot-updater/admin/insights/v1/events";
    expect((await app.request(path)).status).toBe(401);
    expect(
      (await app.request(path, { headers: { [API_KEY_HEADER_NAME]: apiKey } }))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request("/hot-updater/insights/v1/events", {
          headers: { [API_KEY_HEADER_NAME]: apiKey },
        })
      ).status,
    ).toBe(404);
    expect(page).not.toHaveBeenCalled();
    const response = await app.request(path, {
      headers: { Authorization: "Bearer test-admin-token" },
    });
    expect(response.status).toBe(200);
    expect(page).toHaveBeenCalledOnce();
  });
  it("stays off the client surface and preserves the first cutoff across explicit empty-page continuation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { server, page, scan } = setup();
    expect((await server.handlers.client(request())).status).toBe(404);
    expect(page).not.toHaveBeenCalled();
    page.mockResolvedValueOnce({ rows: [], nextCursor: "continue" });
    const first = await server.handlers.admin(request());
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.json()).toEqual({
      data: [],
      pagination: {
        limit: 50,
        beforeReceivedAtMs: 1_000,
        nextCursor: "continue",
        hasNext: true,
        consistency: "live",
      },
    });
    expect(page).toHaveBeenCalledOnce();
    vi.setSystemTime(2_000);
    const second = await server.handlers.admin(
      request("cursor=continue&beforeReceivedAtMs=1000"),
    );
    expect(second.status).toBe(200);
    expect(page).toHaveBeenLastCalledWith({
      scope: { kind: "all" },
      limit: 50,
      beforeReceivedAtMs: 1_000,
      cursor: "continue",
    });
    expect(page).toHaveBeenCalledTimes(2);
    expect(scan).not.toHaveBeenCalled();
  });

  it("rejects ambiguous, oversized and offset requests before any storage reads", async () => {
    const { server, page, scan } = setup();
    for (const query of [
      "limit=1&limit=2",
      "limit=101",
      "limit=0",
      "limit=1.5",
      "limit=1e2",
      "beforeReceivedAtMs=-1",
      "beforeReceivedAtMs=9007199254740992",
      "scope=all&bundleId=b",
      "scope=bundle",
      "scope=bundle&bundleId=b&installId=i",
      "scope=unknown",
      "offset=1000000",
      "futureFilter=x",
      "cursor=continue",
      "cursor=&beforeReceivedAtMs=1000",
      `cursor=${"x".repeat(8193)}&beforeReceivedAtMs=1000`,
    ]) {
      const response = await server.handlers.admin(request(query));
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "INSIGHTS_INVALID_EVENT_PAGE" },
      });
    }
    expect(page).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it("does not silently fall back to bounded history for unsupported providers or scopes", async () => {
    for (const native of [false, true]) {
      const { server, page, scan } = setup(native);
      const response = await server.handlers.admin(
        request(native ? "scope=installation&installId=i" : ""),
      );
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        error: { code: "INSIGHTS_EVENT_PAGES_UNSUPPORTED" },
      });
      expect(page).not.toHaveBeenCalled();
      expect(scan).not.toHaveBeenCalled();
    }
  });

  it("reports invalid bookmarks and preparation separately from sanitized adapter failures", async () => {
    const { server, page, scan } = setup();
    const cases = [
      [
        new DatabasePluginInputError("invalid-query"),
        400,
        "INSIGHTS_INVALID_EVENT_PAGE",
      ],
      [new InsightsQueryNotReadyError(), 503, "INSIGHTS_QUERY_NOT_READY"],
      [
        new HotUpdaterSchemaMigrationRequiredError("postgres", undefined),
        503,
        "INSIGHTS_SCHEMA_MIGRATION_REQUIRED",
      ],
      [
        new DatabasePluginInputError("invalid-result"),
        500,
        "INSIGHTS_EVENT_PAGE_FAILED",
      ],
      [
        new Error("private database credentials"),
        500,
        "INSIGHTS_EVENT_PAGE_FAILED",
      ],
    ] as const;
    for (const [error, status, code] of cases) {
      page.mockRejectedValueOnce(error);
      const response = await server.handlers.admin(request());
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code } });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(page).toHaveBeenCalledTimes(cases.length);
    expect(scan).not.toHaveBeenCalled();
  });
});
