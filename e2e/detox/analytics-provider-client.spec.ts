import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type { AnalyticsProvider } from "../../packages/server/src/analytics/types.ts";
import { createConsoleAnalyticsProviderClient } from "./analytics-provider-client.ts";

describe("Detox Analytics provider client", () => {
  it("loads under the Node strip-types mode used by the Detox control server", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--eval",
        `import(${JSON.stringify(new URL("./analytics-provider-client.ts", import.meta.url).href)})`,
      ],
      { encoding: "utf8" },
    );

    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.status).toBe(0);
  });

  it("maps Console Analytics queries to the official provider domain", async () => {
    const provider = {
      mode: "bounded",
      maxMatchingRows: 10_000,
      appendBundleEvent: vi.fn(),
      getActiveInstallationOverview: vi.fn(async () => ({
        activeInstallations: 0,
        bundles: [],
      })),
      getBundleEventAnalytics: vi.fn(async () => ({
        recentEvents: {
          data: [],
          pagination: { limit: 50, offset: 0, total: 0 },
        },
        summary: { installed: 0, recovered: 0 },
      })),
      getBundleEventOverview: vi.fn(async () => ({
        bundles: [],
        trackedInstallations: 0,
      })),
      getBundleEventSummary: vi.fn(async () => ({
        installed: 0,
        recovered: 0,
      })),
      getInstallationHistory: vi.fn(async () => ({
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      })),
      searchInstallations: vi.fn(async () => ({
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      })),
    } satisfies AnalyticsProvider;
    const client = createConsoleAnalyticsProviderClient(provider);

    await client.getActiveOverview();
    await client.getBundleAnalytics("bundle-id");
    await client.getHistory("install-id");
    await client.getOverview();
    await client.getSummary("bundle-id");
    await client.searchInstallations("device-alias");

    await expect(client.getCapabilities()).resolves.toEqual({
      analytics: true,
    });
    expect(provider.getActiveInstallationOverview).toHaveBeenCalledWith({
      window: "24h",
    });
    expect(provider.getBundleEventAnalytics).toHaveBeenCalledWith(
      "bundle-id",
      "30d",
      50,
      0,
    );
    expect(provider.getInstallationHistory).toHaveBeenCalledWith(
      "install-id",
      50,
      0,
    );
    expect(provider.getBundleEventOverview).toHaveBeenCalledOnce();
    expect(provider.getBundleEventSummary).toHaveBeenCalledWith("bundle-id");
    expect(provider.searchInstallations).toHaveBeenCalledWith(
      "device-alias",
      50,
      0,
    );
  });
});
