import { DatabasePluginInputError } from "@hot-updater/plugin-core";
import {
  INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS,
  INSIGHTS_PAGE_MAX_BYTES,
  getCanonicalInsightsJsonByteLength,
} from "@hot-updater/plugin-core/internal";
import { describe, expect, it } from "vitest";

import {
  createPrismaInsightsEventCursor,
  prismaInsightsInstallKey,
  readPrismaInsightsEventCursor,
  takePrismaInsightsPageRows,
} from "./codec";

const eventInput = {
  selector: { kind: "all" as const },
  sinceReceivedAtMs: 0,
  beforeReceivedAtMs: 1_000,
  limit: 50,
};
const sourceId = "01976b55-5d00-4000-8000-000000000000";

describe("Prisma Insights contract codec", () => {
  it("uses the provider-independent installation order vectors", () => {
    for (const vector of INSIGHTS_INSTALLATION_ORDER_TEST_VECTORS) {
      expect(prismaInsightsInstallKey(vector.installId).toString("hex")).toBe(
        vector.sha256Hex,
      );
    }
  });

  it("binds an event cursor to its selector and cutoff", () => {
    const cursor = createPrismaInsightsEventCursor(eventInput, sourceId, {
      id: "01976b55-5d00-7000-8000-000000000001",
      received_at_ms: 500,
    });

    expect(readPrismaInsightsEventCursor({ ...eventInput, cursor })).toEqual({
      id: "01976b55-5d00-7000-8000-000000000001",
      receivedAtMs: 500,
      sourceId,
    });
    expect(() =>
      readPrismaInsightsEventCursor({
        ...eventInput,
        selector: { kind: "bundleId", bundleId: "bundle" },
        cursor,
      }),
    ).toThrow(DatabasePluginInputError);
  });

  it("returns a byte-short page after the last emitted row", () => {
    const payload = "x".repeat(Math.floor(INSIGHTS_PAGE_MAX_BYTES / 2));
    const rows = [1, 2, 3].map((id) => ({ id, payload }));
    const page = takePrismaInsightsPageRows(
      rows,
      3,
      (data, nextCursor) => ({ data, nextCursor }),
      ({ id }) => String(id),
    );

    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBe("1");
    expect(
      getCanonicalInsightsJsonByteLength({
        data: page.rows,
        nextCursor: page.nextCursor,
      }),
    ).toBeLessThanOrEqual(INSIGHTS_PAGE_MAX_BYTES);
  });
});
