import { describe, expect, it } from "vitest";

import { AnalyticsScanLimitExceededError } from "../errors";
import { createTestProvider } from "../testing/createTestProvider";
import { createAnalyticsWireRuntime } from "./wire.testFixtures";

describe("Analytics active installation wire compatibility", () => {
  it("maps a bounded scan failure to the dedicated 503 response", async () => {
    const provider = createTestProvider();
    provider.getActiveInstallationOverview = async () => {
      throw new AnalyticsScanLimitExceededError(50_000);
    };
    const { runtime } = createAnalyticsWireRuntime(provider);

    const response = await runtime.handler(
      new Request(
        "http://localhost/hot-updater/api/installations/active?window=30d",
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ANALYTICS_SCAN_LIMIT_EXCEEDED",
        limit: 50_000,
      },
    });
  });

  it("uses 30d by default", async () => {
    const provider = createTestProvider();
    const { runtime } = createAnalyticsWireRuntime(provider);

    const response = await runtime.handler(
      new Request("http://localhost/hot-updater/api/installations/active"),
    );

    expect(response.status).toBe(200);
    expect(provider.getActiveInstallationOverview).toHaveBeenCalledWith({
      window: "30d",
    });
  });

  it("forwards an exact case-sensitive userId and valid window", async () => {
    const provider = createTestProvider();
    const { runtime } = createAnalyticsWireRuntime(provider);

    const response = await runtime.handler(
      new Request(
        "http://localhost/hot-updater/api/installations/active?window=7d&userId=Alias%2FB",
      ),
    );

    expect(response.status).toBe(200);
    expect(provider.getActiveInstallationOverview).toHaveBeenCalledWith({
      userId: "Alias/B",
      window: "7d",
    });
  });

  it.each([
    "window=all",
    "window=24h&window=7d",
    "userId=",
    "userId=a&userId=b",
    `userId=${"x".repeat(1025)}`,
  ])("rejects malformed query '%s'", async (query) => {
    const provider = createTestProvider();
    const { runtime } = createAnalyticsWireRuntime(provider);

    const response = await runtime.handler(
      new Request(
        `http://localhost/hot-updater/api/installations/active?${query}`,
      ),
    );

    expect(response.status).toBe(400);
    expect(provider.getActiveInstallationOverview).not.toHaveBeenCalled();
  });

  it("checks remote query availability before parsing input", async () => {
    const provider = {
      ...createTestProvider(),
      resolveAvailability: async () => ({
        analytics: true as const,
        analyticsQueries: false,
        eventIngestion: true,
        mode: "dedicated" as const,
      }),
    };
    const { runtime } = createAnalyticsWireRuntime(provider);

    const response = await runtime.handler(
      new Request(
        "http://localhost/hot-updater/api/installations/active?window=invalid",
      ),
    );

    expect(response.status).toBe(404);
    expect(provider.getActiveInstallationOverview).not.toHaveBeenCalled();
  });
});
