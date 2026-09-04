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
      getActiveInstallationOverview: vi.fn(async () => ({
        activeInstallations: 0,
        asOfMs: 1,
        window: "24h" as const,
      })),
      getInstallation: vi.fn(async () => null),
      pageEvents: vi.fn(async () => ({
        beforeReceivedAtMs: 10,
        data: [],
        nextCursor: null,
      })),
      pageInstallationEvents: vi.fn(async () => ({
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

    await client.getActiveOverview();
    await client.getInstallation("install-id");
    await client.pageEvents({ cursor: "event-cursor", limit: 25 });
    await client.pageInstallationEvents("install-id", {
      cursor: "movement-cursor",
      limit: 25,
    });
    await client.pageInstallationsByCurrentUserId("user-id", {
      cursor: "user-cursor",
      limit: 25,
    });

    expect(provider.getActiveInstallationOverview).toHaveBeenCalledWith({
      window: "24h",
    });
    expect(provider.getInstallation).toHaveBeenCalledWith("install-id");
    expect(provider.pageEvents).toHaveBeenCalledWith({
      cursor: "event-cursor",
      limit: 25,
    });
    expect(provider.pageInstallationEvents).toHaveBeenCalledWith({
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
