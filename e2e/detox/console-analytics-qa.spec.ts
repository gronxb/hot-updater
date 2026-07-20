import { describe, expect, it, vi } from "vitest";

import {
  ConsoleAnalyticsQaError,
  readObservedAnalyticsEvent,
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
  platform: "ios" as const,
  receivedAtMs: Date.now(),
  toBundleId: bundleId,
  type: "UPDATE_APPLIED" as const,
  userId: "detox-e2e",
  username: "hot-updater-e2e",
};
const observedTransition = {
  fromBundleId: event.fromBundleId,
  installId: "install-1",
  observedAtMs: event.receivedAtMs - 1,
  toBundleId: event.toBundleId,
  type: event.type,
} as const;

const createClient = (): ConsoleAnalyticsQaClient => ({
  getActiveOverview: vi.fn(async () => ({
    activeInstallations: 1,
    bundles: [{ bundleId, installations: 1 }],
  })),
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
    data: [{ installId: observedTransition.installId }],
    pagination: { limit: 50, offset: 0, total: 1 },
  })),
});

describe("console analytics E2E QA", () => {
  it("captures the app event identity used to correlate Console queries", () => {
    expect(
      readObservedAnalyticsEvent(
        {
          fromBundleId: event.fromBundleId,
          installId: observedTransition.installId,
          toBundleId: event.toBundleId,
          type: event.type,
        },
        observedTransition.observedAtMs,
      ),
    ).toEqual(observedTransition);
  });

  it("verifies the current bundle through every Console analytics query", async () => {
    // Given: the current E2E bundle has one persisted transition event.
    const client = createClient();

    // When: the Console analytics QA checkpoint runs.
    const evidence = await verifyConsoleAnalytics(client, [bundleId], {
      observedEvents: [observedTransition],
    });

    // Then: bundle, overview, active installation, search, and history agree.
    expect(evidence).toEqual({
      activeInstallations: 1,
      bundleId,
      eventId: event.id,
      installId: observedTransition.installId,
      trackedInstallations: 1,
    });
    expect(client.searchInstallations).toHaveBeenCalledWith(
      observedTransition.installId,
    );
    expect(client.getHistory).toHaveBeenCalledWith(
      observedTransition.installId,
    );
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

  it("verifies an observed UNCHANGED event through active installations", async () => {
    // Given: the app reported a current-run UNCHANGED event, which transition
    // analytics intentionally excludes.
    const client = createClient();
    vi.mocked(client.getBundleAnalytics).mockResolvedValue({
      recentEvents: {
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      },
      summary: { installed: 0, recovered: 0 },
    });
    vi.mocked(client.getActiveOverview).mockResolvedValue({
      activeInstallations: 1,
      bundles: [{ bundleId, installations: 1 }],
    });

    // When: the Console analytics QA checkpoint runs with the observed event.
    const evidence = await verifyConsoleAnalytics(client, [bundleId], {
      observedEvents: [
        {
          fromBundleId: null,
          installId: "install-unchanged",
          observedAtMs: Date.now(),
          toBundleId: bundleId,
          type: "UNCHANGED",
        },
      ],
    });

    // Then: active-installation analytics proves the app event was ingested.
    expect(evidence).toMatchObject({
      activeInstallations: 1,
      bundleId,
      installId: "install-unchanged",
      mode: "active",
    });
    expect(client.getSummary).not.toHaveBeenCalled();
    expect(client.getHistory).not.toHaveBeenCalled();
  });
});
