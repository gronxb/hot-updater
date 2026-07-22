import { describe, expect, it } from "vitest";

import { createHandler } from "./handler";
import { createApi, createManagementHandler } from "./handler.testFixtures";

describe("createHandler management routes", () => {
  it("mounts bundle routes when explicitly enabled", async () => {
    const api = createApi();
    api.getBundles.mockResolvedValueOnce({
      data: [],
      pagination: {
        total: 0,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 0,
      },
    });
    const handler = createManagementHandler(api);
    const response = await handler(
      new Request("http://localhost/hot-updater/api/bundles"),
    );

    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledWith(
      { cursor: undefined, limit: 50, page: undefined, where: {} },
      undefined,
    );
  });

  it("serves bundle event summaries through management routes", async () => {
    const api = createApi();
    api.getBundleEventSummary.mockResolvedValueOnce({
      installed: 3,
      recovered: 1,
    });
    const handler = createManagementHandler(api);
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles/bundle-1/events/summary",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      installed: 3,
      recovered: 1,
    });
    expect(api.getBundleEventSummary).toHaveBeenCalledWith(
      "bundle-1",
      undefined,
    );
  });

  it("mounts Analytics routes independently from bundle management", async () => {
    // Given
    const api = createApi();
    api.getBundleEventSummary.mockResolvedValueOnce({
      installed: 3,
      recovered: 1,
    });
    const handler = createManagementHandler(api, {
      analytics: true,
      bundles: false,
    });

    // When
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles/bundle-1/events/summary",
      ),
    );

    // Then
    expect(response.status).toBe(200);
  });

  it("does not mount Analytics routes when only bundles are enabled", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/hot-updater",
      routes: { updateCheck: true, bundles: true },
    });

    // When
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles/bundle-1/events/summary",
      ),
    );

    // Then
    expect(response.status).toBe(404);
    expect(api.getBundleEventSummary).not.toHaveBeenCalled();
  });

  it("forwards bounded analytics pagination and window parameters", async () => {
    const api = createApi();
    const handler = createManagementHandler(api);
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles/bundle-1/events/analytics?window=7d&limit=25&offset=10",
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getBundleEventAnalytics).toHaveBeenCalledWith(
      "bundle-1",
      "7d",
      25,
      10,
      undefined,
    );
  });

  it("serves installation search and append-only history", async () => {
    const api = createApi();
    const handler = createManagementHandler(api);
    const searchResponse = await handler(
      new Request(
        "http://localhost/hot-updater/api/installations?query=hot-updater-e2e&limit=20&offset=4",
      ),
    );
    const historyResponse = await handler(
      new Request(
        "http://localhost/hot-updater/api/installations/install-1/events?limit=30&offset=2",
      ),
    );

    expect(searchResponse.status).toBe(200);
    expect(historyResponse.status).toBe(200);
    expect(api.searchInstallations).toHaveBeenCalledWith(
      "hot-updater-e2e",
      20,
      4,
      undefined,
    );
    expect(api.getInstallationHistory).toHaveBeenCalledWith(
      "install-1",
      30,
      2,
      undefined,
    );
  });
});
