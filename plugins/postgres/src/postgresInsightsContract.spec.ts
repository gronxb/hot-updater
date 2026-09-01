import {
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_PAGE_MAX_BYTES,
} from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  assertPostgresInsightsMaintenanceInput,
  fitPostgresInsightsPage,
} from "./postgresInsightsContract";

describe("PostgreSQL Insights transport budgets", () => {
  it("shortens the full serialized envelope and resumes after its last emitted row", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ...createBundleEventRowFixture(String(index), 100 - index),
      install_id: `install-${index}-${"\u0001".repeat(900)}`,
      user_id: `user-${index}-${"\u0001".repeat(900)}`,
      username: `name-${index}-${"\u0001".repeat(900)}`,
    }));
    const page = fitPostgresInsightsPage(rows, 100, (data, shortened) => {
      const nextCursor = shortened
        ? JSON.stringify({ after: data.at(-1)?.id })
        : null;
      return {
        state: "ready" as const,
        versions: {
          schemaVersion: "1.0.0",
          storageVersion: "postgres-insights-v1",
          projectionGeneration: null,
          sourceGeneration: "test",
        },
        data: {
          data,
          nextCursor,
          hasNext: nextCursor !== null,
          consistency: {
            kind: "live" as const,
            cutoff: {
              kind: "event-time" as const,
              beforeReceivedAtMs: 101,
            },
          },
          total: { state: "unavailable" as const },
        },
      };
    });
    expect(page.data.data.length).toBeGreaterThan(0);
    expect(page.data.data.length).toBeLessThan(rows.length);
    expect(JSON.parse(page.data.nextCursor!)).toEqual({
      after: page.data.data.at(-1)!.id,
    });
    expect(getCanonicalInsightsJsonByteLength(page)).toBeLessThanOrEqual(
      INSIGHTS_PAGE_MAX_BYTES,
    );
  });

  it("rejects a complete maintenance input over four MiB", () => {
    expect(() =>
      assertPostgresInsightsMaintenanceInput({
        maxItems: 256,
        maxRequests: 128,
        padding: "x".repeat(4 * 1024 * 1024),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-query" }));
  });
});
