import type { InsightsReads } from "@hot-updater/server/plugins";
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { InsightsEventRow } from "../insights-view";
import { listFailureReports } from "./failureReports";

const DAY = 86_400_000;
const input = {
  platform: "ios" as const,
  channel: "production",
  window: "7d" as const,
  beforeReceivedAtMs: 20 * DAY,
};
const event: InsightsEventRow = {
  id: "event",
  type: "UPDATE_FAILED",
  installId: "device",
  platform: "ios",
  channel: "production",
  appVersion: "1.6.0",
  cohort: "1",
  userId: null,
  fromBundleId: "old",
  toBundleId: "new",
  toReleaseId: "release",
  receivedAtMs: 19 * DAY,
  failure: { stage: "download", reason: "unknown", errorMessage: "disk full" },
};
const getRetention = async () => ({ rawDays: 90, dailyDays: 400 });

describe("failure report investigation", () => {
  it("keeps scope and release attribution consistent with failure metrics", async () => {
    const listEvents = vi.fn<InsightsReads["listEvents"]>(async () => ({
      beforeReceivedAtMs: input.beforeReceivedAtMs,
      nextCursor: null,
      data: [
        event,
        { ...event, type: "UPDATE_APPLIED" as const },
        { ...event, platform: "android" as const },
        { ...event, channel: "beta" },
        { ...event, toReleaseId: "another-release" },
        {
          ...event,
          failure: { stage: "check" as const, reason: "unknown" as const },
        },
      ],
    }));
    const reads = { listEvents, getRetention };
    expect(
      (await listFailureReports(reads, { ...input, releaseId: "release" }))
        .data,
    ).toEqual([event]);
    expect((await listFailureReports(reads, input)).data).toHaveLength(3);
    expect(listEvents).toHaveBeenCalledWith({
      sinceMs: 13 * DAY,
      beforeReceivedAtMs: 20 * DAY,
      limit: 100,
    });
  });

  it("bounds scans through successful events and preserves continuation through an empty result", async () => {
    let calls = 0;
    const listEvents = vi.fn<InsightsReads["listEvents"]>(async () => ({
      beforeReceivedAtMs: input.beforeReceivedAtMs,
      nextCursor: `cursor-${++calls}`,
      data: Array.from({ length: 100 }, () => ({
        ...event,
        type: "UPDATE_APPLIED" as const,
      })),
    }));
    const page = await listFailureReports({ listEvents, getRetention }, input);
    expect(page).toMatchObject({
      data: [],
      scanned: 500,
      nextCursor: "cursor-5",
    });
    expect(listEvents).toHaveBeenCalledTimes(5);
    listEvents.mockImplementationOnce(async () => ({
      beforeReceivedAtMs: input.beforeReceivedAtMs,
      nextCursor: null,
      data: [event],
    }));
    const next = await listFailureReports(
      { listEvents, getRetention },
      { ...input, cursor: page.nextCursor! },
    );
    expect(listEvents).toHaveBeenNthCalledWith(6, {
      sinceMs: 13 * DAY,
      beforeReceivedAtMs: 20 * DAY,
      limit: 100,
      cursor: "cursor-5",
    });
    expect(next.data).toEqual([event]);
  });

  it("limits raw history to retention even when aggregate history covers longer", async () => {
    const listEvents = vi.fn<InsightsReads["listEvents"]>(async () => ({
      beforeReceivedAtMs: 20 * DAY,
      nextCursor: null,
      data: [],
    }));
    const page = await listFailureReports(
      {
        listEvents,
        getRetention: async () => ({ rawDays: 2, dailyDays: 400 }),
      },
      input,
    );
    expect(page.sinceMs).toBe(18 * DAY);
    expect(listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ sinceMs: 18 * DAY }),
    );
  });
});
