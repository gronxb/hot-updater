import type {
  BundleEventRow,
  InsightsInstallationRow,
  InsightsModel,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsBadRequestError } from "./errors";
import { createInsightsProvider } from "./provider";

const eventId = (index: number) =>
  `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`;

type TransitionEventRow = Extract<
  BundleEventRow,
  { readonly type: "UPDATE_APPLIED" | "RECOVERED" | "RELEASE_ADOPTED" }
>;

const eventRow = (
  id: string,
  receivedAtMs: number,
  overrides: Partial<TransitionEventRow> = {},
): TransitionEventRow => ({
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprint_hash: null,
  from_bundle_id: "bundle-before",
  from_release_id: null,
  id,
  install_id: "install-1",
  platform: "ios",
  received_at_ms: receivedAtMs,
  sdk_version: "2.0.0",
  to_bundle_id: "bundle-after",
  to_release_id: null,
  type: "UPDATE_APPLIED",
  update_strategy: "appVersion",
  user_id: "user-1",
  username: "Jane",
  ...overrides,
});

const installationRow = (
  installId: string,
  overrides: Partial<InsightsInstallationRow> = {},
): InsightsInstallationRow => ({
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  id: eventId(1),
  install_id: installId,
  platform: "ios",
  received_at_ms: 1_000,
  to_bundle_id: "bundle-1",
  type: "UNCHANGED",
  user_id: "user-1",
  username: "Jane",
  ...overrides,
});

const createModel = () => {
  const model = {
    record: vi.fn<InsightsModel["record"]>(async () => {}),
    listEvents: vi.fn<InsightsModel["listEvents"]>(async () => []),
    findInstallations: vi.fn<InsightsModel["findInstallations"]>(
      async () => [],
    ),
    countInstallations: vi.fn<InsightsModel["countInstallations"]>(
      async () => 0,
    ),
    countEvents: vi.fn<InsightsModel["countEvents"]>(async () => 0),
  } satisfies InsightsModel;
  return { ...model, model };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createInsightsProvider", () => {
  it("pages all events with one bounded database call and a strict stable cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fixture = createModel();
    fixture.listEvents
      .mockResolvedValueOnce([
        eventRow(eventId(3), 999),
        eventRow(eventId(2), 900),
        eventRow(eventId(1), 800),
      ])
      .mockResolvedValueOnce([eventRow(eventId(1), 800)]);
    const provider = createInsightsProvider(fixture.model);

    const first = await provider.listEvents({ limit: 2 });

    expect(first.data.map(({ id }) => id)).toEqual([eventId(3), eventId(2)]);
    expect(first.beforeReceivedAtMs).toBe(1_000);
    expect(first.nextCursor).not.toBeNull();
    expect(fixture.listEvents).toHaveBeenNthCalledWith(1, {
      beforeReceivedAtMs: 1_000,
      limit: 3,
      sinceMs: 0,
      filter: { kind: "all" },
    });

    const second = await provider.listEvents({
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });

    expect(second.beforeReceivedAtMs).toBe(1_000);
    expect(second.nextCursor).toBeNull();
    expect(fixture.listEvents).toHaveBeenNthCalledWith(2, {
      after: { id: eventId(2), receivedAtMs: 900 },
      beforeReceivedAtMs: 1_000,
      limit: 3,
      sinceMs: 0,
      filter: { kind: "all" },
    });
  });

  it("binds event cursors to their filter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fixture = createModel();
    fixture.listEvents.mockResolvedValue([
      eventRow(eventId(2), 900),
      eventRow(eventId(1), 800),
    ]);
    const provider = createInsightsProvider(fixture.model);
    const allEvents = await provider.listEvents({ limit: 1 });

    await expect(
      provider.listInstallationEvents({
        cursor: allEvents.nextCursor ?? undefined,
        installId: "install-1",
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
    expect(fixture.listEvents).toHaveBeenCalledOnce();
  });

  it("rejects installation and user IDs longer than the indexed key limit", async () => {
    const fixture = createModel();
    const provider = createInsightsProvider(fixture.model);
    const tooLong = "x".repeat(256);

    await expect(
      provider.getInstallation({ installId: tooLong }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
    await expect(
      provider.listInstallationEvents({ installId: tooLong }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
    await expect(
      provider.pageInstallationsByCurrentUserId({ userId: tooLong }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
    expect(fixture.findInstallations).not.toHaveBeenCalled();
    expect(fixture.listEvents).not.toHaveBeenCalled();
    expect(fixture.findInstallations).not.toHaveBeenCalled();
  });

  it("requests only movement events for one installation", async () => {
    const fixture = createModel();
    fixture.listEvents.mockResolvedValue([
      eventRow(eventId(1), 900, {
        install_id: "install-2",
        type: "RECOVERED",
      }),
    ]);
    const provider = createInsightsProvider(fixture.model);

    const result = await provider.listInstallationEvents({
      beforeReceivedAtMs: 1_000,
      installId: "install-2",
      limit: 10,
    });

    expect(result.data).toEqual([
      expect.objectContaining({
        id: eventId(1),
        installId: "install-2",
        type: "RECOVERED",
      }),
    ]);
    expect(fixture.listEvents).toHaveBeenCalledWith({
      beforeReceivedAtMs: 1_000,
      limit: 11,
      sinceMs: 0,
      filter: { kind: "installationMovement", installId: "install-2" },
    });
  });

  it("pages exact current user matches and binds the cursor to that user", async () => {
    const fixture = createModel();
    fixture.findInstallations.mockResolvedValue([
      installationRow("install-a"),
      installationRow("install-b"),
      installationRow("install-c"),
    ]);
    const provider = createInsightsProvider(fixture.model);

    const page = await provider.pageInstallationsByCurrentUserId({
      limit: 2,
      userId: "user-1",
    });

    expect(page.data.map(({ installId }) => installId)).toEqual([
      "install-a",
      "install-b",
    ]);
    expect(fixture.findInstallations).toHaveBeenCalledWith({
      limit: 3,
      userId: "user-1",
    });
    await expect(
      provider.pageInstallationsByCurrentUserId({
        cursor: page.nextCursor ?? undefined,
        userId: "user-2",
      }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
    expect(fixture.findInstallations).toHaveBeenCalledOnce();
  });

  it("counts one explicit scope and returns independent measurement times", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const fixture = createModel();
    fixture.countInstallations.mockResolvedValue(123);
    const provider = createInsightsProvider(fixture.model);
    const input = {
      window: "7d",
      platform: "ios",
      channel: "production",
    } as const;
    await expect(provider.getReportingOverview(input)).resolves.toEqual({
      ...input,
      sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1_000,
      beforeReceivedAtMs: Date.now(),
      reportingInstallations: { count: 123, measuredAtMs: Date.now() },
    });
    expect(fixture.countInstallations).toHaveBeenCalledWith({
      platform: "ios",
      channel: "production",
      sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1_000,
    });
    expect(fixture.countEvents).not.toHaveBeenCalled();
  });

  it("attributes recovery to the source bundle and reuses its count predicate for drill-down", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const fixture = createModel();
    fixture.countInstallations
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    fixture.countEvents
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);
    const provider = createInsightsProvider(fixture.model);
    const scope = { platform: "ios", channel: "production" } as const;
    const result = await provider.getReportingOverview({
      ...scope,
      window: "24h",
      bundleId: "B",
    });
    expect(result.reportingInstallations.count).toBe(1);
    // Independent live measurements are never clamped or turned into a share.
    expect(result.bundle?.reportingInstallations.count).toBe(2);
    expect(result.bundle?.appliedReports.count).toBe(5);
    expect(result.bundle?.recoveredReports.count).toBe(3);
    expect(result.bundle?.adoptedReports.count).toBe(1);
    expect(
      fixture.countEvents.mock.calls.map(([input]) => input.filter),
    ).toEqual([
      { ...scope, type: "UPDATE_APPLIED", toBundleId: "B" },
      { ...scope, type: "RECOVERED", fromBundleId: "B" },
      { ...scope, type: "RELEASE_ADOPTED", toBundleId: "B" },
    ]);
    await provider.listEvents({
      bundle: { ...scope, bundleId: "B", outcome: "recovered" },
      sinceMs: result.sinceMs,
      beforeReceivedAtMs: result.beforeReceivedAtMs,
    });
    const counted = fixture.countEvents.mock.calls[1]![0];
    expect(fixture.listEvents).toHaveBeenCalledWith({
      ...counted,
      filter: { kind: "bundle", ...counted.filter },
      limit: 51,
    });
  });

  it("binds bundle cursors to the outcome, scope, bundle, and both time bounds", async () => {
    const fixture = createModel();
    fixture.listEvents.mockResolvedValue([
      eventRow(eventId(2), 900),
      eventRow(eventId(1), 800),
    ]);
    const provider = createInsightsProvider(fixture.model);
    const bundle = {
      platform: "ios",
      channel: "production",
      bundleId: "bundle-after",
      outcome: "applied",
    } as const;
    const first = await provider.listEvents({
      bundle,
      sinceMs: 100,
      beforeReceivedAtMs: 1_000,
      limit: 1,
    });
    const cursor = first.nextCursor ?? undefined;
    for (const change of [
      { bundle: { ...bundle, outcome: "recovered" as const } },
      { bundle: { ...bundle, channel: "beta" } },
      { bundle: { ...bundle, bundleId: "another" } },
      { sinceMs: 101 },
      { beforeReceivedAtMs: 1_001 },
    ]) {
      await expect(
        provider.listEvents({ bundle, cursor, ...change }),
      ).rejects.toBeInstanceOf(InsightsBadRequestError);
    }
    expect(fixture.listEvents).toHaveBeenCalledOnce();
  });

  it("rejects forged event keys before they reach the database boundary", async () => {
    const fixture = createModel();
    fixture.listEvents.mockResolvedValue([
      eventRow(eventId(2), 900),
      eventRow(eventId(1), 800),
    ]);
    const provider = createInsightsProvider(fixture.model);
    const first = await provider.listEvents({
      sinceMs: 100,
      beforeReceivedAtMs: 1_000,
      limit: 1,
    });
    const payload = JSON.parse(
      Buffer.from(first.nextCursor!, "base64url").toString("utf8"),
    );
    for (const after of [
      { id: "invalid", receivedAtMs: 900 },
      { id: eventId(1), receivedAtMs: 1_000 },
      { id: eventId(1), receivedAtMs: 99 },
    ]) {
      const cursor = Buffer.from(
        JSON.stringify({ ...payload, after }),
      ).toString("base64url");
      await expect(provider.listEvents({ cursor })).rejects.toBeInstanceOf(
        InsightsBadRequestError,
      );
    }
    expect(fixture.listEvents).toHaveBeenCalledOnce();
  });

  it("propagates count failures without reporting a partial overview", async () => {
    const fixture = createModel();
    fixture.countEvents.mockRejectedValue(new Error("database unavailable"));
    const provider = createInsightsProvider(fixture.model);
    await expect(
      provider.getReportingOverview({
        platform: "ios",
        channel: "production",
        window: "24h",
        bundleId: "B",
      }),
    ).rejects.toThrow("database unavailable");
  });

  it("uses UTF-8 order when checking exact current-user pages", async () => {
    const fixture = createModel();
    fixture.findInstallations.mockResolvedValue([
      installationRow("\uE000"),
      installationRow("\u{10000}"),
    ]);
    const result = await createInsightsProvider(
      fixture.model,
    ).pageInstallationsByCurrentUserId({ userId: "user-1" });
    expect(result.data.map(({ installId }) => installId)).toEqual([
      "\uE000",
      "\u{10000}",
    ]);
  });
});
