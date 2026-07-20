import { describe, expect, it, vi } from "vitest";

import {
  ConsoleAnalyticsQaError,
  verifyConsoleAnalytics,
  type ConsoleAnalyticsQaClient,
} from "./console-analytics-qa.ts";

const bundleId = "00000000-0000-7000-8000-000000000001";
const event = {
  appVersion: "1.0",
  channel: "production",
  cohort: "782",
  fromBundleId: "00000000-0000-0000-0000-000000000000",
  id: "event-1",
  installId: "install-1",
  platform: "ios" as const,
  receivedAtMs: Date.now(),
  toBundleId: bundleId,
  type: "UPDATE_APPLIED" as const,
  userId: "detox-e2e",
  username: "hot-updater-e2e",
};

const createClient = (): ConsoleAnalyticsQaClient => ({
  getActiveOverview: vi.fn(async () => ({ activeInstallations: 1 })),
  getBundleAnalytics: vi.fn(async () => ({
    recentEvents: {
      data: [event],
      pagination: { limit: 50, offset: 0, total: 1 },
    },
    summary: { installed: 1, recovered: 0 },
  })),
  getCapabilities: vi.fn(async () => ({ analytics: true })),
  getHistory: vi.fn(async () => ({
    data: [event],
    pagination: { limit: 50, offset: 0, total: 1 },
  })),
  getOverview: vi.fn(async () => ({ trackedInstallations: 1 })),
  getSummary: vi.fn(async () => ({ installed: 1, recovered: 0 })),
  searchInstallations: vi.fn(async () => ({
    data: [{ installId: event.installId }],
    pagination: { limit: 50, offset: 0, total: 1 },
  })),
});

describe("console analytics E2E QA", () => {
  it("verifies the current bundle through every Console analytics query", async () => {
    // Given: the current E2E bundle has one persisted transition event.
    const client = createClient();

    // When: the Console analytics QA checkpoint runs.
    const evidence = await verifyConsoleAnalytics(client, [bundleId]);

    // Then: bundle, overview, active installation, search, and history agree.
    expect(evidence).toEqual({
      activeInstallations: 1,
      bundleId,
      eventId: event.id,
      installId: event.installId,
      trackedInstallations: 1,
    });
    expect(client.searchInstallations).toHaveBeenCalledWith(event.installId);
    expect(client.getHistory).toHaveBeenCalledWith(event.installId);
  });

  it("fails when the configured profile does not expose Console analytics", async () => {
    // Given: an E2E profile marked for analytics returns no capability.
    const client = createClient();
    vi.mocked(client.getCapabilities).mockResolvedValue({ analytics: false });

    // When / Then: the checkpoint rejects the unsupported profile.
    await expect(verifyConsoleAnalytics(client, [bundleId])).rejects.toEqual(
      expect.objectContaining<Partial<ConsoleAnalyticsQaError>>({
        code: "unsupported",
      }),
    );
  });

  it("fails when none of the current E2E bundles has a persisted event", async () => {
    // Given: Console analytics is enabled but contains no current-run event.
    const client = createClient();
    vi.mocked(client.getBundleAnalytics).mockResolvedValue({
      recentEvents: {
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      },
      summary: { installed: 0, recovered: 0 },
    });

    // When / Then: stale analytics from another run cannot satisfy the QA gate.
    await expect(verifyConsoleAnalytics(client, [bundleId])).rejects.toEqual(
      expect.objectContaining<Partial<ConsoleAnalyticsQaError>>({
        code: "event-not-found",
      }),
    );
  });
});
