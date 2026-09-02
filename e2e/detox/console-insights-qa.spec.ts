import { describe, expect, it, vi } from "vitest";

import {
  ConsoleInsightsQaError,
  readObservedInsightsEvent,
  verifyConsoleInsights,
  type ConsoleInsightsQaClient,
} from "./console-insights-qa.ts";

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

const createClient = (): ConsoleInsightsQaClient => ({
  getActiveOverview: vi.fn(async () => ({
    activeInstallations: 1,
  })),
  getBundleInsights: vi.fn(async () => ({
    recentEvents: {
      data: [event],
      pagination: { limit: 50, offset: 0, total: 1 },
    },
    summary: { installed: 1, recovered: 0 },
  })),
  getCapabilities: vi.fn(async () => ({ insights: true })),
  getHistory: vi.fn(async () => ({
    data: [event],
    pagination: { limit: 50, offset: 0, total: 1 },
  })),
  getInstallationBundle: vi.fn(async () => bundleId),
  getOverview: vi.fn(async () => ({ trackedInstallations: 1 })),
  getSummary: vi.fn(async () => ({ installed: 1, recovered: 0 })),
  searchInstallations: vi.fn(async () => ({
    data: [{ installId: observedTransition.installId }],
    pagination: { limit: 50, offset: 0, total: 1 },
  })),
});

describe("console insights E2E QA", () => {
  it("captures the app event identity used to correlate Console queries", () => {
    expect(
      readObservedInsightsEvent(
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

  it("rejects transition events without a source bundle", () => {
    expect(
      readObservedInsightsEvent(
        {
          fromBundleId: null,
          installId: observedTransition.installId,
          toBundleId: event.toBundleId,
          type: "RECOVERED",
        },
        observedTransition.observedAtMs,
      ),
    ).toBeNull();
  });

  it("verifies the current bundle through every Console insights query", async () => {
    // Given: the current E2E bundle has one persisted transition event.
    const client = createClient();

    // When: the Console insights QA checkpoint runs.
    const evidence = await verifyConsoleInsights(client, [bundleId], {
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

  it("ignores a newer event from another parallel shard", async () => {
    // Given: another shard reports a newer transition for the same bundle.
    const client = createClient();
    vi.mocked(client.getBundleInsights).mockResolvedValue({
      recentEvents: {
        data: [
          {
            ...event,
            fromBundleId: "other-shard-bundle",
            id: "other-shard-event",
            receivedAtMs: event.receivedAtMs + 1,
          },
          event,
        ],
        pagination: { limit: 50, offset: 0, total: 2 },
      },
      summary: { installed: 2, recovered: 0 },
    });

    // When: the current shard's observed transition is verified.
    const evidence = await verifyConsoleInsights(client, [bundleId], {
      observedEvents: [observedTransition],
    });

    // Then: the matching event wins even though it is not the latest row.
    expect(evidence).toMatchObject({ eventId: event.id });
  });

  it("fails when the configured profile does not expose Console insights", async () => {
    // Given: an E2E profile marked for insights returns no capability.
    const client = createClient();
    vi.mocked(client.getCapabilities).mockResolvedValue({ insights: false });

    // When / Then: the checkpoint rejects the unsupported profile.
    await expect(verifyConsoleInsights(client, [bundleId])).rejects.toEqual(
      expect.objectContaining<Partial<ConsoleInsightsQaError>>({
        code: "unsupported",
      }),
    );
  });

  it("fails when none of the current E2E bundles has a persisted event", async () => {
    // Given: Console insights is enabled but contains no current-run event.
    const client = createClient();
    vi.mocked(client.getBundleInsights).mockResolvedValue({
      recentEvents: {
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      },
      summary: { installed: 0, recovered: 0 },
    });

    // When / Then: stale insights from another run cannot satisfy the QA gate.
    await expect(verifyConsoleInsights(client, [bundleId])).rejects.toEqual(
      expect.objectContaining<Partial<ConsoleInsightsQaError>>({
        code: "event-not-found",
      }),
    );
  });

  it("verifies an observed UNCHANGED event through active installations", async () => {
    // Given: the app reported a current-run UNCHANGED event, which transition
    // insights intentionally excludes.
    const client = createClient();
    vi.mocked(client.getBundleInsights).mockResolvedValue({
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

    // When: the Console insights QA checkpoint runs with the observed event.
    const evidence = await verifyConsoleInsights(client, [bundleId], {
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

    // Then: active-installation insights proves the app event was ingested.
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
