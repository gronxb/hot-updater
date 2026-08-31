import type {
  InsightsEventPageInput,
  InsightsEventQueries,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { createInsightsEventPages } from "./eventPages";

describe("native Insights page boundary", () => {
  it("preserves a provider continuation on short and empty pages without automatic refill", async () => {
    const page = vi
      .fn<InsightsEventQueries["page"]>()
      .mockResolvedValueOnce({
        rows: [createBundleEventRowFixture("1", 1)],
        nextCursor: "continued-1",
      })
      .mockResolvedValueOnce({ rows: [], nextCursor: "continued-2" })
      .mockResolvedValueOnce({ rows: [], nextCursor: null });
    const events = createInsightsEventPages({
      version: 1,
      scopes: ["all"],
      page,
    });
    const input = {
      scope: { kind: "all" },
      beforeReceivedAtMs: 3,
      limit: 100,
    } as const;
    const first = await events.getPage(input);
    expect(page).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenLastCalledWith(input);
    expect(first.data).toHaveLength(1);
    expect(first.pagination.hasNext).toBe(true);
    const empty = await events.getPage({
      ...input,
      cursor: first.pagination.nextCursor!,
    });
    expect(page).toHaveBeenCalledTimes(2);
    expect(empty.data).toEqual([]);
    expect(empty.pagination).toMatchObject({
      hasNext: true,
      nextCursor: "continued-2",
    });
    const last = await events.getPage({
      ...input,
      cursor: empty.pagination.nextCursor!,
    });
    expect(page).toHaveBeenCalledTimes(3);
    expect(last.pagination).toMatchObject({ hasNext: false, nextCursor: null });
  });

  it("rejects invalid public limits and scope before reaching schema or storage wrappers", async () => {
    const page = vi.fn<InsightsEventQueries["page"]>();
    const events = createInsightsEventPages({
      version: 1,
      scopes: ["all", "bundle"],
      page,
    });
    const input: InsightsEventPageInput = {
      scope: { kind: "all" },
      beforeReceivedAtMs: 3,
      limit: 1,
    };
    const invalid: readonly Partial<InsightsEventPageInput>[] = [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { sinceReceivedAtMs: -1 },
      { sinceReceivedAtMs: 4 },
      { sinceReceivedAtMs: Number.NaN },
      { scope: { kind: "installation", installId: "a" } },
      { scope: { kind: "bundle", bundleId: "" } },
      { scope: { kind: "bundle", bundleId: 1 } as never, cursor: "cursor" },
      { cursor: "x".repeat(8193) },
    ];
    for (const patch of invalid) {
      await expect(
        events.getPage({ ...input, ...patch }),
      ).rejects.toMatchObject({ name: "InsightsBadRequestError" });
    }
    expect(page).not.toHaveBeenCalled();
  });

  it("preserves an inclusive window and rejects an out-of-window provider row", async () => {
    const page = vi
      .fn<InsightsEventQueries["page"]>()
      .mockResolvedValueOnce({
        rows: [createBundleEventRowFixture("2", 20)],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        rows: [createBundleEventRowFixture("1", 19)],
        nextCursor: null,
      });
    const events = createInsightsEventPages({
      version: 1,
      scopes: ["all"],
      page,
    });
    const input = {
      scope: { kind: "all" },
      sinceReceivedAtMs: 20,
      beforeReceivedAtMs: 30,
      limit: 1,
    } as const;
    const result = await events.getPage(input);
    expect(page).toHaveBeenLastCalledWith(input);
    expect(result.data[0]?.receivedAtMs).toBe(20);
    expect(result.pagination.sinceReceivedAtMs).toBe(20);
    await expect(events.getPage(input)).rejects.toThrow(
      "bounded continuation contract",
    );
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("does not execute an incompatible native query version", async () => {
    const page = vi.fn<InsightsEventQueries["page"]>();
    const events = createInsightsEventPages({
      version: 2,
      scopes: ["all"],
      page,
    } as unknown as InsightsEventQueries);
    await expect(
      events.getPage({
        scope: { kind: "all" },
        beforeReceivedAtMs: 3,
        limit: 1,
      }),
    ).rejects.toMatchObject({ name: "InsightsBadRequestError" });
    expect(page).not.toHaveBeenCalled();
  });

  it("rejects malformed adapter results instead of publishing corrupt event identities", async () => {
    const row = createBundleEventRowFixture("1", 1);
    const page = vi.fn<InsightsEventQueries["page"]>();
    const events = createInsightsEventPages({
      version: 1,
      scopes: ["all"],
      page,
    });
    const invalid = [
      null,
      { rows: {}, nextCursor: null },
      { rows: [{ ...row, id: "" }], nextCursor: null },
      { rows: [{ ...row, type: "UNKNOWN" }], nextCursor: null },
      { rows: [null], nextCursor: null },
    ];
    for (const result of invalid) {
      page.mockResolvedValueOnce(result as never);
      await expect(
        events.getPage({
          scope: { kind: "all" },
          beforeReceivedAtMs: 3,
          limit: 1,
        }),
      ).rejects.toThrow("bounded continuation contract");
    }
  });

  it("rejects rather than silently trimming over-budget rows or accepting non-advancing state", async () => {
    const row = createBundleEventRowFixture("1", 1);
    const page = vi
      .fn<InsightsEventQueries["page"]>()
      .mockResolvedValueOnce({
        rows: [row, createBundleEventRowFixture("2", 2)],
        nextCursor: "after-unread-row",
      })
      .mockResolvedValueOnce({ rows: [], nextCursor: "unchanged" })
      .mockResolvedValueOnce({
        rows: [createBundleEventRowFixture("3", 3)],
        nextCursor: null,
      });
    const events = createInsightsEventPages({
      version: 1,
      scopes: ["all"],
      page,
    });
    const input = {
      scope: { kind: "all" },
      beforeReceivedAtMs: 3,
      limit: 1,
    } as const;
    await expect(events.getPage(input)).rejects.toThrow(
      "bounded continuation contract",
    );
    await expect(
      events.getPage({ ...input, cursor: "unchanged" }),
    ).rejects.toThrow("bounded continuation contract");
    await expect(events.getPage(input)).rejects.toThrow(
      "bounded continuation contract",
    );
  });
});
