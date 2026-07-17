import { describe, expect, it } from "vitest";

import {
  createAnalyticsHandler,
  createAnalyticsHandlerApi,
} from "./handlerAnalytics.testFixtures";

describe("GET /api/installations/active", () => {
  it("uses 30d by default and passes context unchanged", async () => {
    // Given
    const api = createAnalyticsHandlerApi();
    api.getActiveInstallationOverview.mockResolvedValueOnce({
      asOfMs: 1_752_754_600_000,
      window: "30d",
      activeInstallations: 2,
      series: [],
      bundles: [{ bundleId: "unknown-bundle", installations: 2 }],
    });
    const handler = createAnalyticsHandler(api);
    const context = { requestId: "active-default" };

    // When
    const response = await handler(
      new Request("http://localhost/hot-updater/api/installations/active"),
      context,
    );

    // Then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      window: "30d",
      activeInstallations: 2,
    });
    expect(api.getActiveInstallationOverview).toHaveBeenCalledWith(
      { window: "30d" },
      context,
    );
  });

  it("forwards an exact case-sensitive userId and valid window", async () => {
    // Given
    const api = createAnalyticsHandlerApi();
    const handler = createAnalyticsHandler(api);

    // When
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/installations/active?window=7d&userId=Alias%2FB",
      ),
    );

    // Then
    expect(response.status).toBe(200);
    expect(api.getActiveInstallationOverview).toHaveBeenCalledWith(
      { window: "7d", userId: "Alias/B" },
      undefined,
    );
  });

  it.each([
    "window=all",
    "window=24h&window=7d",
    "userId=",
    "userId=a&userId=b",
    `userId=${"x".repeat(1025)}`,
  ])("rejects malformed query '%s'", async (query) => {
    // Given
    const api = createAnalyticsHandlerApi();
    const handler = createAnalyticsHandler(api);

    // When
    const response = await handler(
      new Request(
        `http://localhost/hot-updater/api/installations/active?${query}`,
      ),
    );

    // Then
    expect(response.status).toBe(400);
    expect(api.getActiveInstallationOverview).not.toHaveBeenCalled();
  });

  it("is absent when the runtime capability is incomplete", async () => {
    // Given
    const completeApi = createAnalyticsHandlerApi();
    const {
      getActiveInstallationOverview: _getActiveInstallationOverview,
      ...incompleteApi
    } = completeApi;
    const handler = createAnalyticsHandler(incompleteApi);

    // When
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/installations/active?window=invalid",
      ),
    );

    // Then
    expect(response.status).toBe(404);
  });
});
