import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type { InsightsProvider } from "../../packages/server/src/insights/types.ts";
import { createConsoleInsightsProviderClient } from "./insights-provider-client.ts";

describe("Detox Insights provider client", () => {
  it("loads under the Node strip-types mode used by the Detox control server", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--eval",
        `import(${JSON.stringify(new URL("./insights-provider-client.ts", import.meta.url).href)})`,
      ],
      { encoding: "utf8" },
    );

    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.status).toBe(0);
  });

  it("maps QA reads to the lean provider contract", async () => {
    const provider = {
      appendBundleEvent: vi.fn(),
      getReportingOverview: vi.fn(async () => ({
        channel: "production",
        platform: "ios" as const,
        beforeReceivedAtMs: 1,
        sinceMs: 0,
        reportingInstallations: { count: 0, measuredAtMs: 1 },
        window: "24h" as const,
      })),
      getInstallation: vi.fn(async () => null),
      listEvents: vi.fn(async () => ({
        beforeReceivedAtMs: 10,
        data: [],
        nextCursor: null,
      })),
      listInstallationEvents: vi.fn(async () => ({
        beforeReceivedAtMs: 10,
        data: [],
        nextCursor: null,
      })),
      pageInstallationsByCurrentUserId: vi.fn(async () => ({
        data: [],
        nextCursor: null,
      })),
    } satisfies InsightsProvider;
    const client = createConsoleInsightsProviderClient(provider);

    await client.getReportingOverview({
      channel: "production",
      platform: "ios",
      window: "24h",
    });
    await client.getInstallation({ installId: "install-id" });
    await client.listEvents({ cursor: "event-cursor", limit: 25 });
    await client.listInstallationEvents({
      cursor: "movement-cursor",
      installId: "install-id",
      limit: 25,
    });
    await client.pageInstallationsByCurrentUserId({
      cursor: "user-cursor",
      limit: 25,
      userId: "user-id",
    });

    expect(provider.getReportingOverview).toHaveBeenCalledWith({
      channel: "production",
      platform: "ios",
      window: "24h",
    });
    expect(provider.getInstallation).toHaveBeenCalledWith({
      installId: "install-id",
    });
    expect(provider.listEvents).toHaveBeenCalledWith({
      cursor: "event-cursor",
      limit: 25,
    });
    expect(provider.listInstallationEvents).toHaveBeenCalledWith({
      cursor: "movement-cursor",
      installId: "install-id",
      limit: 25,
    });
    expect(provider.pageInstallationsByCurrentUserId).toHaveBeenCalledWith({
      cursor: "user-cursor",
      limit: 25,
      userId: "user-id",
    });
  });
});
