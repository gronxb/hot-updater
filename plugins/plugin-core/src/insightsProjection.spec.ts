import { describe, expect, it, vi } from "vitest";

import {
  prepareInsightsEvent,
  recordProjectedInsightsEvent,
  type InsightsProjectionBackend,
  type PreparedInsightsEvent,
} from "./insightsProjection";
import type { BundleEventRow } from "./types/internal";

const RELEASE_1 = "00000000-0000-7000-8000-000000000101";
const RELEASE_2 = "00000000-0000-7000-8000-000000000102";
const BUNDLE_1 = "00000000-0000-7000-8000-000000000201";
const BUNDLE_2 = "00000000-0000-7000-8000-000000000202";

const fixtureId = (suffix: string): string =>
  `00000000-0000-7000-8000-${suffix.padStart(12, "0")}`;

const createBundleEventRowFixture = (
  suffix: string,
  receivedAtMs: number,
): BundleEventRow => ({
  id: fixtureId(suffix),
  type: "UPDATE_APPLIED",
  install_id: `install-${suffix}`,
  user_id: null,
  from_release_id: null,
  from_bundle_id: BUNDLE_1,
  to_release_id: RELEASE_1,
  to_bundle_id: BUNDLE_1,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  metadata: {
    username: null,
    cohort: "0",
    update_strategy: "appVersion",
    fingerprint_hash: null,
    sdk_version: null,
  },
  received_at_ms: receivedAtMs,
});

const event = (
  sequence: string,
  receivedAtMs: number,
  patch: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    ...createBundleEventRowFixture(sequence, receivedAtMs),
    type: "UPDATE_APPLIED",
    from_bundle_id: BUNDLE_1,
    to_bundle_id: BUNDLE_1,
    to_release_id: RELEASE_1,
    ...patch,
  }) as BundleEventRow;

describe("Insights release projection", () => {
  it("keeps an explicit release through a newer null UNCHANGED report", () => {
    const applied = prepareInsightsEvent(
      { event: event("1", 1) },
      { revision: "0", state: null, lifetimeExists: false },
    );
    const unchanged = prepareInsightsEvent(
      {
        event: event("2", 2, {
          type: "UNCHANGED",
          from_bundle_id: null,
          to_release_id: null,
        }),
      },
      { revision: "1", state: applied.nextState, lifetimeExists: false },
    );
    expect(unchanged.currentDeltas).toEqual([]);
  });

  it("lets a delayed barrier invalidate an inherited release", () => {
    const applied = prepareInsightsEvent(
      { event: event("10", 10) },
      { revision: "0", state: null, lifetimeExists: false },
    );
    const unchanged = prepareInsightsEvent(
      {
        event: event("30", 30, {
          type: "UNCHANGED",
          from_bundle_id: null,
          to_release_id: null,
        }),
      },
      { revision: "1", state: applied.nextState, lifetimeExists: false },
    );
    const barrier = prepareInsightsEvent(
      {
        event: event("20", 20, {
          type: "UPDATE_APPLIED",
          from_bundle_id: BUNDLE_2,
          to_bundle_id: BUNDLE_2,
          to_release_id: RELEASE_2,
        }),
      },
      { revision: "2", state: unchanged.nextState, lifetimeExists: false },
    );
    expect(barrier.currentDeltas).toEqual([
      {
        release: {
          releaseId: RELEASE_1,
          platform: "ios",
          channel: "production",
        },
        metric: "active",
        delta: -1,
      },
    ]);
  });

  it("moves active state for an explicit same-bundle release selection", () => {
    const first = prepareInsightsEvent(
      { event: event("1", 1) },
      { revision: "0", state: null, lifetimeExists: false },
    );
    const selected = prepareInsightsEvent(
      {
        event: event("2", 2, {
          type: "UNCHANGED",
          from_bundle_id: null,
          to_release_id: RELEASE_2,
        }),
      },
      { revision: "1", state: first.nextState, lifetimeExists: false },
    );
    expect(
      selected.currentDeltas.map(({ release, delta }) => [
        release.releaseId,
        delta,
      ]),
    ).toEqual([
      [RELEASE_1, -1],
      [RELEASE_2, 1],
    ]);
    expect(selected.hourly).toBeNull();
  });

  it("deduplicates lifetime markers but counts every accepted report hour", () => {
    const downloaded = event("1", 3_600_001, {
      type: "UPDATE_DOWNLOADED",
      from_bundle_id: BUNDLE_1,
      to_bundle_id: BUNDLE_2,
      from_release_id: RELEASE_1,
      to_release_id: RELEASE_2,
    });
    const first = prepareInsightsEvent(
      { event: downloaded },
      { revision: "0", state: null, lifetimeExists: false },
    );
    const repeated = prepareInsightsEvent(
      { event: { ...downloaded, id: event("2", 3_600_002).id } },
      { revision: "1", state: first.nextState, lifetimeExists: true },
    );
    expect(first.firstLifetime?.metric).toBe("downloaded");
    expect(repeated.firstLifetime).toBeNull();
    expect(repeated.hourly).toMatchObject({
      metric: "downloaded",
      hourStartMs: 3_600_000,
    });
  });

  it("retries conflicts with the same event and exits on duplicate", async () => {
    const commits: PreparedInsightsEvent[] = [];
    let revision = 0;
    const storage: InsightsProjectionBackend = {
      readRecordContext: async () => ({
        revision: String(revision),
        state: null,
        lifetimeExists: false,
      }),
      commitPreparedEvent: async (input) => {
        commits.push(input);
        revision += 1;
        return commits.length === 1
          ? { status: "conflict" }
          : { status: "duplicate" };
      },
      getReleaseActivity: async () => ({
        coverage: { kind: "complete", sinceMs: 0 },
        data: [],
      }),
    };
    await recordProjectedInsightsEvent(storage, { event: event("1", 1) });
    expect(commits).toHaveLength(2);
    expect(commits[0]!.event.id).toBe(commits[1]!.event.id);
    expect(commits[0]!.expectedRevision).toBe("0");
    expect(commits[1]!.expectedRevision).toBe("1");
  });

  it("accepts a burst of sixteen writers competing for one installation", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let revision = 0;
    let state: string | null = null;
    const accepted = new Set<string>();
    const storage: InsightsProjectionBackend = {
      readRecordContext: async () => ({
        revision: String(revision),
        state,
        lifetimeExists: false,
      }),
      commitPreparedEvent: async (prepared) => {
        if (prepared.expectedRevision !== String(revision)) {
          return { status: "conflict" };
        }
        accepted.add(prepared.event.id);
        revision += 1;
        state = prepared.nextState;
        return { status: "committed" };
      },
      getReleaseActivity: async () => ({
        coverage: { kind: "complete", sinceMs: 0 },
        data: [],
      }),
    };
    try {
      const writes = Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          recordProjectedInsightsEvent(storage, {
            event: { ...event(String(index + 1), index), install_id: "burst" },
          }),
        ),
      );
      const completed = expect(writes).resolves.toHaveLength(16);
      await vi.runAllTimersAsync();
      await completed;
      expect(accepted.size).toBe(16);
      expect(revision).toBe(16);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});
