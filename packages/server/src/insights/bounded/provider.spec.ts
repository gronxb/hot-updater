import { describe, expect, it, vi } from "vitest";

import { InsightsScanLimitExceededError } from "../errors";
import type {
  InsightsPersistence,
  InsightsScanInput,
  BundleEventPersistenceRow,
} from "../persistence";
import { createInsightsProvider } from "./provider";
import { getWindowRange } from "./scan";

const eventRow = (
  id: string,
  receivedAtMs: number,
  installId = `install-${id}`,
): BundleEventPersistenceRow => ({
  id,
  type: "UPDATE_APPLIED",
  install_id: installId,
  user_id: null,
  username: null,
  from_release_id: null,
  from_bundle_id: "old",
  to_release_id: null,
  to_bundle_id: "new",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "fingerprint",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

const compareRows = (
  left: BundleEventPersistenceRow,
  right: BundleEventPersistenceRow,
): number =>
  left.received_at_ms - right.received_at_ms || left.id.localeCompare(right.id);

const inMemoryPersistence = (
  initialRows: readonly BundleEventPersistenceRow[],
  maximumPageSize = Number.MAX_SAFE_INTEGER,
): InsightsPersistence => {
  const rows = [...initialRows];
  return {
    async append(row) {
      rows.push(row);
    },
    async scan(input: InsightsScanInput) {
      return rows
        .filter((row) => row.received_at_ms < input.beforeReceivedAtMs)
        .filter(
          (row) =>
            input.after === undefined ||
            row.received_at_ms > input.after.receivedAtMs ||
            (row.received_at_ms === input.after.receivedAtMs &&
              row.id > input.after.id),
        )
        .toSorted(compareRows)
        .slice(0, Math.min(input.limit, maximumPageSize));
    },
  };
};

describe("createInsightsProvider", () => {
  it("paginates every event type across installations and all time, newest first", async () => {
    const rows: BundleEventPersistenceRow[] = [
      eventRow("old-applied", 1, "install-old"),
      {
        ...eventRow("recovered", 2),
        type: "RECOVERED",
        from_bundle_id: "new",
        update_strategy: "fingerprint",
        platform: "android",
        channel: "beta",
      },
      {
        ...eventRow("adopted", 3),
        type: "RELEASE_ADOPTED",
        from_bundle_id: "old",
        update_strategy: "fingerprint",
      },
      {
        ...eventRow("unchanged", 3),
        type: "UNCHANGED",
        from_bundle_id: null,
        update_strategy: null,
      },
    ];
    const provider = createInsightsProvider(inMemoryPersistence(rows, 2));
    const first = await provider.getEventHistory(2, 0);
    const second = await provider.getEventHistory(2, 2);

    expect(first.pagination).toEqual({ total: 4, limit: 2, offset: 0 });
    expect(second.pagination).toEqual({ total: 4, limit: 2, offset: 2 });
    expect(
      [...first.data, ...second.data].map(({ id, type, installId }) => ({
        id,
        type,
        installId,
      })),
    ).toEqual([
      { id: "unchanged", type: "UNCHANGED", installId: "install-unchanged" },
      { id: "adopted", type: "RELEASE_ADOPTED", installId: "install-adopted" },
      { id: "recovered", type: "RECOVERED", installId: "install-recovered" },
      { id: "old-applied", type: "UPDATE_APPLIED", installId: "install-old" },
    ]);
    expect(first.data[0]?.fromBundleId).toBeNull();
    expect(second.data[0]).toMatchObject({
      platform: "android",
      channel: "beta",
    });
  });

  it("starts windowed insights scans at the storage lower boundary", async () => {
    // Given
    const now = Date.UTC(2026, 1, 2, 12);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const scan = vi.fn<InsightsPersistence["scan"]>().mockResolvedValue([]);
    const provider = createInsightsProvider({
      async append() {},
      scan,
    });

    // When
    await provider.getBundleEventInsights("new", "24h", 20, 0);

    // Then
    expect(scan).toHaveBeenCalledWith(
      expect.objectContaining({
        after: {
          id: "00000000-0000-0000-0000-000000000000",
          receivedAtMs: getWindowRange("24h", now).rangeStart,
        },
      }),
    );
    vi.restoreAllMocks();
  });
  it("counts distinct installations across cursor pages", async () => {
    const rows = Array.from({ length: 1_001 }, (_, index) =>
      eventRow(index.toString().padStart(4, "0"), 1_000, `install-${index}`),
    );
    const provider = createInsightsProvider(inMemoryPersistence(rows));

    await expect(provider.getBundleEventSummary("new")).resolves.toEqual({
      installed: 1_001,
      recovered: 0,
    });
  });

  it("continues scanning when persistence caps pages below the requested limit", async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      eventRow(index.toString().padStart(4, "0"), 1_000, `install-${index}`),
    );
    const provider = createInsightsProvider(inMemoryPersistence(rows, 17));

    await expect(provider.getBundleEventSummary("new")).resolves.toEqual({
      installed: 101,
      recovered: 0,
    });
  });

  it("collects distinct 30-day movement for multiple Bundles in one scan", async () => {
    const now = Date.UTC(2026, 7, 18, 12);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const applied = eventRow("applied", now - 1_000, "install-applied");
    const duplicateApplied = eventRow(
      "applied-again",
      now - 900,
      "install-applied",
    );
    const recovered = {
      ...eventRow("recovered", now - 800, "install-recovered"),
      type: "RECOVERED" as const,
      from_bundle_id: "new",
      to_bundle_id: "fallback",
      update_strategy: "fingerprint" as const,
    } satisfies BundleEventPersistenceRow;
    const other = {
      ...eventRow("other", now - 700, "install-other"),
      to_bundle_id: "other",
    };
    const outsideWindow = eventRow(
      "outside-window",
      now - 31 * 24 * 60 * 60 * 1_000,
      "install-old",
    );
    const persistence = inMemoryPersistence([
      outsideWindow,
      applied,
      duplicateApplied,
      recovered,
      other,
    ]);
    const scan = vi.spyOn(persistence, "scan");
    const provider = createInsightsProvider(persistence);

    await expect(
      provider.getBundleEventSummaries(["new", "other", "missing"], "30d"),
    ).resolves.toEqual([
      { bundleId: "new", installed: 1, recovered: 1 },
      { bundleId: "other", installed: 1, recovered: 0 },
      { bundleId: "missing", installed: 0, recovered: 0 },
    ]);
    expect(scan).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("counts an installation whose current bundle is reported by UNCHANGED", async () => {
    const unchanged: BundleEventPersistenceRow = {
      ...eventRow("unchanged", 1, "install-unchanged"),
      type: "UNCHANGED",
      from_bundle_id: null,
      update_strategy: null,
    };
    const provider = createInsightsProvider(inMemoryPersistence([unchanged]));

    await expect(provider.getBundleEventOverview()).resolves.toEqual({
      trackedInstallations: 1,
      bundles: [{ bundleId: "new", installations: 1 }],
    });
  });

  it.each([
    [eventRow("same", 1), eventRow("same", 2)],
    [eventRow("later", 2), eventRow("earlier", 1)],
  ])(
    "rejects duplicate ids and rows outside strict cursor order",
    async (...rows) => {
      let delivered = false;
      const provider = createInsightsProvider({
        async append() {},
        async scan() {
          if (delivered) return [];
          delivered = true;
          return rows;
        },
      });

      await expect(provider.getBundleEventSummary("new")).rejects.toMatchObject(
        {
          name: "InsightsPersistenceOrderError",
        },
      );
    },
  );

  it("fails instead of returning partial insights beyond 50,000 rows", async () => {
    const persistence: InsightsPersistence = {
      async append() {},
      async scan(input) {
        const start =
          input.after === undefined ? 0 : Number(input.after.id) + 1;
        return Array.from({ length: input.limit }, (_, index) => {
          const id = start + index;
          return eventRow(String(id), id);
        });
      },
    };
    const provider = createInsightsProvider(persistence);

    await expect(provider.getBundleEventSummary("new")).rejects.toBeInstanceOf(
      InsightsScanLimitExceededError,
    );
    await expect(provider.getEventHistory(50, 0)).rejects.toBeInstanceOf(
      InsightsScanLimitExceededError,
    );
  });
});
