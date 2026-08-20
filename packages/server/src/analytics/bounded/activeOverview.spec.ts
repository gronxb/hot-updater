import { describe, expect, it } from "vitest";

import type { BundleEventPersistenceRow } from "../persistence";
import { collectActiveInstallationOverview } from "./activeOverview";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

type EventRowOptions = {
  readonly id: string;
  readonly receivedAtMs: number;
  readonly installId?: string;
  readonly userId?: string | null;
  readonly bundleId?: string;
};

type SeriesWindow = {
  readonly startMs: number;
  readonly bucketCount: number;
  readonly bucketSizeMs: number;
};

function eventRow(options: EventRowOptions): BundleEventPersistenceRow {
  return {
    id: options.id,
    type: "UPDATE_APPLIED",
    install_id: options.installId ?? `install-${options.id}`,
    user_id: options.userId ?? null,
    username: null,
    from_release_id: null,
    from_bundle_id: "old",
    to_release_id: null,
    to_bundle_id: options.bundleId ?? "new",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "default",
    update_strategy: "fingerprint",
    fingerprint_hash: null,
    sdk_version: null,
    received_at_ms: options.receivedAtMs,
  };
}

function expectedSeries(
  window: SeriesWindow,
  values: Readonly<Record<number, number>>,
): { readonly bucketStartMs: number; readonly value: number }[] {
  return Array.from({ length: window.bucketCount }, (_, index) => ({
    bucketStartMs: window.startMs + index * window.bucketSizeMs,
    value: values[index] ?? 0,
  }));
}

describe("collectActiveInstallationOverview", () => {
  it("uses the strict window and latest installation rows for a user", () => {
    const asOfMs = 100 * HOUR_MS;
    const windowStartMs = asOfMs - 24 * HOUR_MS;
    const window = {
      startMs: windowStartMs,
      bucketCount: 24,
      bucketSizeMs: HOUR_MS,
    } as const;
    const rows = [
      eventRow({
        id: "a-start",
        receivedAtMs: windowStartMs,
        installId: "install-a",
        userId: "user-a",
        bundleId: "bundle-b",
      }),
      eventRow({
        id: "a-latest",
        receivedAtMs: asOfMs - 1,
        installId: "install-a",
        userId: "user-a",
        bundleId: "bundle-a",
      }),
      eventRow({
        id: "before-window",
        receivedAtMs: windowStartMs - 1,
        userId: "user-a",
      }),
      eventRow({
        id: "at-cutoff",
        receivedAtMs: asOfMs,
        userId: "user-a",
      }),
      eventRow({
        id: "tie-a",
        receivedAtMs: asOfMs - HOUR_MS,
        installId: "install-tie",
        userId: "user-a",
        bundleId: "bundle-b",
      }),
      eventRow({
        id: "tie-z",
        receivedAtMs: asOfMs - HOUR_MS,
        installId: "install-tie",
        userId: "user-a",
        bundleId: "bundle-c",
      }),
      eventRow({
        id: "changed-user-old",
        receivedAtMs: windowStartMs,
        installId: "install-changed-user",
        userId: "user-a",
      }),
      eventRow({
        id: "changed-user-new",
        receivedAtMs: asOfMs - 1,
        installId: "install-changed-user",
        userId: "user-b",
      }),
    ];

    expect(
      collectActiveInstallationOverview({
        rows,
        asOfMs,
        window: "24h",
        userId: "user-a",
      }),
    ).toEqual({
      asOfMs,
      window: "24h",
      activeInstallations: 2,
      series: expectedSeries(window, { 0: 1, 23: 2 }),
      bundleSeries: [
        {
          bundleId: "bundle-a",
          series: expectedSeries(window, { 23: 1 }),
        },
        {
          bundleId: "bundle-b",
          series: expectedSeries(window, { 0: 1 }),
        },
        {
          bundleId: "bundle-c",
          series: expectedSeries(window, { 23: 1 }),
        },
      ],
      bundles: [
        { bundleId: "bundle-a", installations: 1 },
        { bundleId: "bundle-c", installations: 1 },
      ],
    });
  });

  it("includes installations with any user when the filter is omitted", () => {
    const asOfMs = 10 * DAY_MS;
    const windowStartMs = asOfMs - 7 * DAY_MS;
    const window = {
      startMs: windowStartMs,
      bucketCount: 7,
      bucketSizeMs: DAY_MS,
    } as const;
    const rows = [
      eventRow({
        id: "user-a",
        receivedAtMs: windowStartMs,
        userId: "user-a",
        bundleId: "bundle-b",
      }),
      eventRow({
        id: "anonymous",
        receivedAtMs: asOfMs - 1,
        bundleId: "bundle-a",
      }),
    ];

    const result = collectActiveInstallationOverview({
      rows,
      asOfMs,
      window: "7d",
    });

    expect(result.activeInstallations).toBe(2);
    expect(result.series).toEqual(expectedSeries(window, { 0: 1, 6: 1 }));
    expect(result.bundles).toEqual([
      { bundleId: "bundle-a", installations: 1 },
      { bundleId: "bundle-b", installations: 1 },
    ]);
    expect(result.bundleSeries.map(({ bundleId }) => bundleId)).toEqual([
      "bundle-a",
      "bundle-b",
    ]);
  });
});
