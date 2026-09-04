import { describe, expect, it, vi } from "vitest";

import {
  ConsoleInsightsQaError,
  readObservedInsightsEvent,
  verifyConsoleInsights,
  type ConsoleInsightsQaClient,
} from "./console-insights-qa.ts";

const bundleId = "00000000-0000-7000-8000-000000000001";
const event = {
  fromBundleId: "00000000-0000-0000-0000-000000000000",
  id: "event-1",
  installId: "install-1",
  receivedAtMs: Date.now(),
  toBundleId: bundleId,
  type: "UPDATE_APPLIED" as const,
};
const observedTransition = {
  fromBundleId: event.fromBundleId,
  installId: event.installId,
  observedAtMs: event.receivedAtMs + 1,
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
  getActiveOverview: vi.fn(async () => ({ activeInstallations: 1 })),
  getInstallation: vi.fn(async () => ({
    installId: observedTransition.installId,
    userId: observedTransition.userId,
  })),
  pageEvents: vi.fn(async () => ({
    beforeReceivedAtMs: event.receivedAtMs + 1,
    data: [event],
    nextCursor: null,
  })),
  pageInstallationEvents: vi.fn(async () => ({
    beforeReceivedAtMs: event.receivedAtMs + 1,
    data: [event],
    nextCursor: null,
  })),
  pageInstallationsByCurrentUserId: vi.fn(async () => ({
    data: [
      {
        installId: observedTransition.installId,
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
          fromBundleId: event.fromBundleId,
          installId: observedTransition.installId,
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
          fromBundleId: event.fromBundleId,
          installId: observedTransition.installId,
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
    vi.mocked(client.pageEvents)
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
            installId: observedTransition.installId,
            userId: observedTransition.userId,
          },
        ],
        nextCursor: null,
      });
    vi.mocked(client.pageInstallationEvents)
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
    // and the active count all agree without offset or total-count queries.
    expect(evidence).toEqual({
      activeInstallations: 1,
      eventId: event.id,
      eventType: event.type,
      installId: observedTransition.installId,
      userId: observedTransition.userId,
    });
    expect(client.pageEvents).toHaveBeenNthCalledWith(2, {
      cursor: "event-cursor",
      limit: 50,
    });
    expect(client.getInstallation).toHaveBeenCalledWith(
      observedTransition.installId,
    );
    expect(client.pageInstallationsByCurrentUserId).toHaveBeenNthCalledWith(
      2,
      observedTransition.userId,
      { cursor: "user-cursor", limit: 50 },
    );
    expect(client.pageInstallationEvents).toHaveBeenNthCalledWith(
      2,
      observedTransition.installId,
      { cursor: "movement-cursor", limit: 50 },
    );
  });

  it("verifies an unchanged report without inventing a movement", async () => {
    // Given: the app reports activity without changing its bundle.
    const client = createClient();
    const unchanged = {
      ...observedTransition,
      fromBundleId: null,
      type: "UNCHANGED" as const,
    };
    vi.mocked(client.pageEvents).mockResolvedValue({
      ...emptyEventPage,
      data: [{ ...event, fromBundleId: null, type: "UNCHANGED" }],
    });

    // When / Then: ingestion and current state are checked, while the
    // transition-only movement endpoint is intentionally not queried.
    await expect(
      verifyConsoleInsights(client, { observedEvents: [unchanged] }),
    ).resolves.toMatchObject({ eventType: "UNCHANGED" });
    expect(client.pageInstallationEvents).not.toHaveBeenCalled();
  });

  it("fails when the filter-free history has no current app event", async () => {
    const client = createClient();
    vi.mocked(client.pageEvents).mockResolvedValue(emptyEventPage);

    await expect(
      verifyConsoleInsights(client, { observedEvents: [observedTransition] }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConsoleInsightsQaError>>({
        code: "event-not-found",
      }),
    );
  });
});
