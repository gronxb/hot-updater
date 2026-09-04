import type {
  BundleEventRow,
  InsightsInstallationRow,
  InsightsModel,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsBadRequestError } from "./errors";
import { createInsightsProvider } from "./provider";

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
  id: `event-${installId}`,
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
  const append = vi.fn(async () => {});
  const pageEvents = vi.fn(async () => [] as readonly BundleEventRow[]);
  const getInstallation = vi.fn(
    async () => null as InsightsInstallationRow | null,
  );
  const pageInstallationsByCurrentUserId = vi.fn(
    async () => [] as readonly InsightsInstallationRow[],
  );
  const countActiveInstallations = vi.fn(async () => 0);
  const model = {
    append,
    countActiveInstallations,
    getInstallation,
    pageEvents,
    pageInstallationsByCurrentUserId,
  } satisfies InsightsModel;
  return {
    append,
    countActiveInstallations,
    getInstallation,
    model,
    pageEvents,
    pageInstallationsByCurrentUserId,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createInsightsProvider", () => {
  it("pages all events with one bounded database call and a strict stable cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fixture = createModel();
    fixture.pageEvents
      .mockResolvedValueOnce([
        eventRow("event-3", 999),
        eventRow("event-2", 900),
        eventRow("event-1", 800),
      ])
      .mockResolvedValueOnce([eventRow("event-1", 800)]);
    const provider = createInsightsProvider(fixture.model);

    const first = await provider.pageEvents({ limit: 2 });

    expect(first.data.map(({ id }) => id)).toEqual(["event-3", "event-2"]);
    expect(first.beforeReceivedAtMs).toBe(1_000);
    expect(first.nextCursor).not.toBeNull();
    expect(fixture.pageEvents).toHaveBeenNthCalledWith(1, {
      beforeReceivedAtMs: 1_000,
      limit: 3,
      selector: { kind: "all" },
    });

    const second = await provider.pageEvents({
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });

    expect(second.beforeReceivedAtMs).toBe(1_000);
    expect(second.nextCursor).toBeNull();
    expect(fixture.pageEvents).toHaveBeenNthCalledWith(2, {
      after: { id: "event-2", receivedAtMs: 900 },
      beforeReceivedAtMs: 1_000,
      limit: 3,
      selector: { kind: "all" },
    });
  });

  it("binds event cursors to their selector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fixture = createModel();
    fixture.pageEvents.mockResolvedValue([
      eventRow("event-2", 900),
      eventRow("event-1", 800),
    ]);
    const provider = createInsightsProvider(fixture.model);
    const allEvents = await provider.pageEvents({ limit: 1 });

    await expect(
      provider.pageInstallationEvents({
        cursor: allEvents.nextCursor ?? undefined,
        installId: "install-1",
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
    expect(fixture.pageEvents).toHaveBeenCalledOnce();
  });

  it("rejects installation and user IDs longer than the indexed key limit", async () => {
    const fixture = createModel();
    const provider = createInsightsProvider(fixture.model);
    const tooLong = "x".repeat(256);

    await expect(provider.getInstallation(tooLong)).rejects.toBeInstanceOf(
      InsightsBadRequestError,
    );
    await expect(
      provider.pageInstallationEvents({ installId: tooLong }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
    await expect(
      provider.pageInstallationsByCurrentUserId({ userId: tooLong }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
    expect(fixture.getInstallation).not.toHaveBeenCalled();
    expect(fixture.pageEvents).not.toHaveBeenCalled();
    expect(fixture.pageInstallationsByCurrentUserId).not.toHaveBeenCalled();
  });

  it("requests only movement events for one installation", async () => {
    const fixture = createModel();
    fixture.pageEvents.mockResolvedValue([
      eventRow("event-1", 900, {
        install_id: "install-2",
        type: "RECOVERED",
      }),
    ]);
    const provider = createInsightsProvider(fixture.model);

    const result = await provider.pageInstallationEvents({
      beforeReceivedAtMs: 1_000,
      installId: "install-2",
      limit: 10,
    });

    expect(result.data).toEqual([
      expect.objectContaining({
        id: "event-1",
        installId: "install-2",
        type: "RECOVERED",
      }),
    ]);
    expect(fixture.pageEvents).toHaveBeenCalledWith({
      beforeReceivedAtMs: 1_000,
      limit: 11,
      selector: { kind: "installationMovement", installId: "install-2" },
    });
  });

  it("pages exact current user matches and binds the cursor to that user", async () => {
    const fixture = createModel();
    fixture.pageInstallationsByCurrentUserId.mockResolvedValue([
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
    expect(fixture.pageInstallationsByCurrentUserId).toHaveBeenCalledWith({
      limit: 3,
      userId: "user-1",
    });
    await expect(
      provider.pageInstallationsByCurrentUserId({
        cursor: page.nextCursor ?? undefined,
        userId: "user-2",
      }),
    ).rejects.toBeInstanceOf(InsightsBadRequestError);
    expect(fixture.pageInstallationsByCurrentUserId).toHaveBeenCalledOnce();
  });

  it("counts active installations with one rolling cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const fixture = createModel();
    fixture.countActiveInstallations.mockResolvedValue(123);
    const provider = createInsightsProvider(fixture.model);

    await expect(
      provider.getActiveInstallationOverview({ window: "7d" }),
    ).resolves.toEqual({
      activeInstallations: 123,
      asOfMs: Date.now(),
      window: "7d",
    });
    expect(fixture.countActiveInstallations).toHaveBeenCalledWith({
      sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1_000,
    });
  });
});
