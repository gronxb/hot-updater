import { describe, expect, it } from "vitest";

import { AnalyticsScanLimitExceededError } from "../../errors";
import type {
  AnalyticsPersistence,
  AnalyticsScanInput,
  BundleEventPersistenceRow,
} from "../persistence";
import { createBoundedAnalyticsProvider } from "./provider";

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
  from_bundle_id: "old",
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
): AnalyticsPersistence => {
  const rows = [...initialRows];
  return {
    async append(row) {
      rows.push(row);
    },
    async scan(input: AnalyticsScanInput) {
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

describe("createBoundedAnalyticsProvider", () => {
  it("counts distinct installations across cursor pages", async () => {
    const rows = Array.from({ length: 1_001 }, (_, index) =>
      eventRow(index.toString().padStart(4, "0"), 1_000, `install-${index}`),
    );
    const provider = createBoundedAnalyticsProvider(inMemoryPersistence(rows));

    await expect(provider.getBundleEventSummary("new")).resolves.toEqual({
      installed: 1_001,
      recovered: 0,
    });
  });

  it("continues scanning when persistence caps pages below the requested limit", async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      eventRow(index.toString().padStart(4, "0"), 1_000, `install-${index}`),
    );
    const provider = createBoundedAnalyticsProvider(
      inMemoryPersistence(rows, 17),
    );

    await expect(provider.getBundleEventSummary("new")).resolves.toEqual({
      installed: 101,
      recovered: 0,
    });
  });

  it("counts an installation whose current bundle is reported by UNCHANGED", async () => {
    const unchanged: BundleEventPersistenceRow = {
      ...eventRow("unchanged", 1, "install-unchanged"),
      type: "UNCHANGED",
      from_bundle_id: null,
      update_strategy: null,
    };
    const provider = createBoundedAnalyticsProvider(
      inMemoryPersistence([unchanged]),
    );

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
      const provider = createBoundedAnalyticsProvider({
        async append() {},
        async scan() {
          if (delivered) return [];
          delivered = true;
          return rows;
        },
      });

      await expect(provider.getBundleEventSummary("new")).rejects.toMatchObject(
        {
          name: "AnalyticsPersistenceOrderError",
        },
      );
    },
  );

  it("fails instead of returning partial analytics beyond 50,000 rows", async () => {
    const persistence: AnalyticsPersistence = {
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
    const provider = createBoundedAnalyticsProvider(persistence);

    await expect(provider.getBundleEventSummary("new")).rejects.toBeInstanceOf(
      AnalyticsScanLimitExceededError,
    );
  });
});
