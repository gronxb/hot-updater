import { describe, expect, it, vi } from "vitest";

import {
  ConsoleInsightsQaError,
  readObservedInsightsEvent,
  verifyConsoleInsights,
  type ConsoleInsightsQaClient,
} from "./console-insights-qa.ts";

const bundleId = "00000000-0000-7000-8000-000000000001";
const event = {
  channel: "production",
  fromBundleId: "00000000-0000-0000-0000-000000000000",
  id: "event-1",
  installId: "install-1",
  platform: "ios" as const,
  receivedAtMs: Date.now(),
  toBundleId: bundleId,
  type: "UPDATE_APPLIED" as const,
};
const observedTransition = {
  channel: event.channel,
  fromBundleId: event.fromBundleId,
  installId: event.installId,
  observedAtMs: event.receivedAtMs + 1,
  platform: event.platform,
  toBundleId: event.toBundleId,
  type: event.type,
  userId: "detox-e2e",
} as const;

const emptyEventPage = {
  beforeReceivedAtMs: event.receivedAtMs + 1,
  data: [],
  nextCursor: null,
};

const createClient = (): ConsoleInsightsQaClient => ({
  getReportingOverview: vi.fn(async (input) => ({
    ...input,
    beforeReceivedAtMs: event.receivedAtMs + 1,
    sinceMs: event.receivedAtMs - 86_400_000,
    reportingInstallations: { count: 1, measuredAtMs: event.receivedAtMs + 1 },
    bundle: {
      bundleId: input.bundleId!,
      reportingInstallations: {
        count: 1,
        measuredAtMs: event.receivedAtMs + 1,
      },
      appliedReports: { count: 1, measuredAtMs: event.receivedAtMs + 1 },
      recoveredReports: { count: 0, measuredAtMs: event.receivedAtMs + 1 },
      adoptedReports: { count: 0, measuredAtMs: event.receivedAtMs + 1 },
    },
  })),
  getInstallation: vi.fn(async () => ({
    channel: event.channel,
    installId: observedTransition.installId,
    lastKnownBundleId: event.toBundleId,
    platform: event.platform,
    userId: observedTransition.userId,
  })),
  listEvents: vi.fn(async () => ({
    beforeReceivedAtMs: event.receivedAtMs + 1,
    data: [event],
    nextCursor: null,
  })),
  listInstallationEvents: vi.fn(async () => ({
    beforeReceivedAtMs: event.receivedAtMs + 1,
    data: [event],
    nextCursor: null,
  })),
  pageInstallationsByCurrentUserId: vi.fn(async () => ({
    data: [
      {
        channel: event.channel,
        installId: observedTransition.installId,
        lastKnownBundleId: event.toBundleId,
        platform: event.platform,
        userId: observedTransition.userId,
      },
    ],
    nextCursor: null,
  })),
});

describe("console insights E2E QA", () => {
  it("captures the app event identity used to correlate Console queries", () => {
    expect(
      readObservedInsightsEvent(
        {
          channel: event.channel,
          fromBundleId: event.fromBundleId,
          installId: observedTransition.installId,
          platform: event.platform,
          toBundleId: event.toBundleId,
          type: event.type,
          userId: observedTransition.userId,
        },
        observedTransition.observedAtMs,
      ),
    ).toEqual(observedTransition);
  });

  it("rejects events without the current user identity", () => {
    expect(
      readObservedInsightsEvent(
        {
          channel: event.channel,
          fromBundleId: event.fromBundleId,
          installId: observedTransition.installId,
          platform: event.platform,
          toBundleId: event.toBundleId,
          type: event.type,
        },
        observedTransition.observedAtMs,
      ),
    ).toBeNull();
  });

  it("verifies ingestion and the lean Console queries with cursors", async () => {
    // Given: another shard fills the first event, user, and movement pages.
    const client = createClient();
    vi.mocked(client.listEvents)
      .mockResolvedValueOnce({ ...emptyEventPage, nextCursor: "event-cursor" })
      .mockResolvedValueOnce({
        ...emptyEventPage,
        data: [event],
      });
    vi.mocked(client.pageInstallationsByCurrentUserId)
      .mockResolvedValueOnce({ data: [], nextCursor: "user-cursor" })
      .mockResolvedValueOnce({
        data: [
          {
            channel: event.channel,
            installId: observedTransition.installId,
            lastKnownBundleId: event.toBundleId,
            platform: event.platform,
            userId: observedTransition.userId,
          },
        ],
        nextCursor: null,
      });
    vi.mocked(client.listInstallationEvents)
      .mockResolvedValueOnce({
        ...emptyEventPage,
        nextCursor: "movement-cursor",
      })
      .mockResolvedValueOnce({
        ...emptyEventPage,
        data: [event],
      });

    // When: the current app report is checked against Console Insights.
    const evidence = await verifyConsoleInsights(client, {
      observedEvents: [observedTransition],
      sinceMs: event.receivedAtMs - 1,
    });

    // Then: filter-free history, exact installation/current user, movement,
    // and scoped counts agree; the selected outcome is traceable to its report.
    expect(evidence).toEqual({
      reportingInstallations: 1,
      selectedBundleInstallations: 1,
      outcomes: [{ bundleId, count: 1, eventId: event.id, outcome: "applied" }],
      eventId: event.id,
      eventType: event.type,
      installId: observedTransition.installId,
      userId: observedTransition.userId,
    });
    expect(client.listEvents).toHaveBeenNthCalledWith(2, {
      cursor: "event-cursor",
      limit: 50,
    });
    expect(client.getInstallation).toHaveBeenCalledWith({
      installId: observedTransition.installId,
    });
    expect(client.pageInstallationsByCurrentUserId).toHaveBeenNthCalledWith(2, {
      cursor: "user-cursor",
      limit: 50,
      userId: observedTransition.userId,
    });
    expect(client.listInstallationEvents).toHaveBeenNthCalledWith(2, {
      cursor: "movement-cursor",
      installId: observedTransition.installId,
      limit: 50,
    });
    expect(client.listEvents).toHaveBeenLastCalledWith({
      beforeReceivedAtMs: event.receivedAtMs + 1,
      bundle: {
        bundleId,
        channel: event.channel,
        outcome: "applied",
        platform: event.platform,
      },
      cursor: undefined,
      limit: 50,
      sinceMs: event.receivedAtMs - 86_400_000,
    });
  });

  it("verifies an unchanged report without inventing a movement", async () => {
    // Given: the app reports activity without changing its bundle.
    const client = createClient();
    const unchanged = {
      ...observedTransition,
      fromBundleId: null,
      type: "UNCHANGED" as const,
    };
    vi.mocked(client.listEvents).mockResolvedValue({
      ...emptyEventPage,
      data: [{ ...event, fromBundleId: null, type: "UNCHANGED" }],
    });

    // When / Then: ingestion and current state are checked, while the
    // transition-only movement endpoint is intentionally not queried.
    await expect(
      verifyConsoleInsights(client, { observedEvents: [unchanged] }),
    ).resolves.toMatchObject({ eventType: "UNCHANGED" });
    expect(client.listInstallationEvents).not.toHaveBeenCalled();
  });

  it("fails when the filter-free history has no current app event", async () => {
    const client = createClient();
    vi.mocked(client.listEvents).mockResolvedValue(emptyEventPage);

    await expect(
      verifyConsoleInsights(client, { observedEvents: [observedTransition] }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConsoleInsightsQaError>>({
        code: "event-not-found",
      }),
    );
  });

  it("verifies Release adoption without requiring a bundle movement", async () => {
    const client = createClient();
    const adopted = {
      ...observedTransition,
      fromBundleId: bundleId,
      type: "RELEASE_ADOPTED" as const,
    };
    vi.mocked(client.listEvents).mockResolvedValue({
      ...emptyEventPage,
      data: [{ ...event, fromBundleId: bundleId, type: "RELEASE_ADOPTED" }],
    });
    const overview = await client.getReportingOverview({
      bundleId,
      channel: event.channel,
      platform: event.platform,
      window: "24h",
    });
    vi.mocked(client.getReportingOverview).mockResolvedValue({
      ...overview,
      bundle: {
        ...overview.bundle!,
        appliedReports: { count: 0, measuredAtMs: event.receivedAtMs + 1 },
        adoptedReports: { count: 1, measuredAtMs: event.receivedAtMs + 1 },
      },
    });

    await expect(
      verifyConsoleInsights(client, { observedEvents: [adopted] }),
    ).resolves.toMatchObject({
      eventType: "RELEASE_ADOPTED",
      outcomes: [{ bundleId, count: 1, outcome: "adopted" }],
    });
    expect(client.listInstallationEvents).not.toHaveBeenCalled();
  });

  it("fails when the outcome count or its drill-down omits an accepted report", async () => {
    const client = createClient();
    const overview = await client.getReportingOverview({
      bundleId,
      channel: event.channel,
      platform: event.platform,
      window: "24h",
    });
    vi.mocked(client.getReportingOverview).mockResolvedValue({
      ...overview,
      bundle: {
        ...overview.bundle!,
        appliedReports: { count: 0, measuredAtMs: event.receivedAtMs + 1 },
      },
    });
    await expect(
      verifyConsoleInsights(client, { observedEvents: [observedTransition] }),
    ).rejects.toMatchObject({ code: "inconsistent-data" });

    vi.mocked(client.getReportingOverview).mockResolvedValue(overview);
    vi.mocked(client.listEvents).mockImplementation(async (input) => ({
      ...emptyEventPage,
      data: input?.bundle ? [] : [event],
    }));
    await expect(
      verifyConsoleInsights(client, { observedEvents: [observedTransition] }),
    ).rejects.toMatchObject({ code: "inconsistent-data" });
  });

  it("rejects an older matching event as evidence for the current scenario", async () => {
    const client = createClient();
    vi.mocked(client.listEvents).mockResolvedValue({
      ...emptyEventPage,
      data: [{ ...event, receivedAtMs: event.receivedAtMs - 10_000 }],
    });
    await expect(
      verifyConsoleInsights(client, {
        observedEvents: [observedTransition],
        sinceMs: event.receivedAtMs - 1,
      }),
    ).rejects.toMatchObject({ code: "event-not-found" });
  });
});
