import { compareInsightsText } from "@hot-updater/plugin-core";
import { afterEach, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { supabaseDatabase } from "./supabaseDatabase";

const events = Array.from({ length: 150 }, (_, index) => ({
  ...createBundleEventRowFixture(String(index + 1), 100),
  user_id: "current-user",
})).reverse();
const installations = [...events].sort((left, right) =>
  compareInsightsText(left.install_id, right.install_id),
);

afterEach(() => vi.unstubAllGlobals());

it.each(["events", "installations"] as const)(
  "fills the %s lookahead through the real PostgREST builder when max_rows is 100",
  async (model) => {
    const stored = model === "events" ? events : installations;
    const requests: {
      offset: number;
      limit: number;
      after: string | null;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit"));
        const canonicalLookup =
          model === "installations" &&
          url.pathname.endsWith("/hot_updater_v1_bundle_events");
        const key = canonicalLookup ? "id" : "install_id";
        const filters = url.searchParams.getAll(key);
        const after =
          filters.find((filter) => filter.startsWith("gt."))?.slice(3) ?? null;
        if (!canonicalLookup) requests.push({ offset, limit, after });
        expect(new Headers(init?.headers).get("Prefer") ?? "").not.toContain(
          "count=",
        );
        const source = (
          canonicalLookup
            ? stored
                .filter(({ id }) =>
                  filters.some(
                    (filter) => filter.startsWith("in.") && filter.includes(id),
                  ),
                )
                .toSorted((left, right) =>
                  compareInsightsText(left.id, right.id),
                )
            : stored
        ).filter(
          (row) => after === null || compareInsightsText(row[key], after) > 0,
        );
        const rows = source.slice(offset, offset + Math.min(limit, 100));
        if (model === "installations" && !canonicalLookup) {
          expect(url.pathname).toBe(
            "/rest/v1/hot_updater_v1_bundle_event_heads",
          );
          expect(url.searchParams.get("select")).toBe("id,install_id");
        }
        return new Response(JSON.stringify(rows), {
          headers: {
            "Content-Type": "application/json",
            "Content-Range":
              rows.length === 0
                ? "*/*"
                : `${offset}-${offset + rows.length - 1}/*`,
          },
        });
      }),
    );
    const plugin = supabaseDatabase({
      supabaseUrl: "http://localhost:54321",
      supabaseServiceRoleKey: "test-service-role",
    });
    const rows =
      model === "events"
        ? await plugin.models.insights.listEvents({
            filter: { kind: "all" },
            beforeReceivedAtMs: 200,
            limit: 101,
          })
        : await plugin.models.insights.findLatestEvents({
            userId: "current-user",
            limit: 101,
          });
    expect(rows).toEqual(stored.slice(0, 101));
    expect(requests).toEqual(
      model === "events"
        ? [
            { offset: 0, limit: 101, after: null },
            { offset: 100, limit: 1, after: null },
          ]
        : [
            { offset: 0, limit: 101, after: null },
            { offset: 0, limit: 1, after: stored[99]!.install_id },
          ],
    );
  },
);

it("rejects a continuation failure instead of returning the first 100 events", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (Number(url.searchParams.get("offset") ?? 0) > 0) {
        return new Response(
          JSON.stringify({
            code: "42501",
            message: "permission denied",
            details: null,
            hint: null,
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify(events.slice(0, 100)), {
        headers: {
          "Content-Type": "application/json",
          "Content-Range": "0-99/*",
        },
      });
    }),
  );
  const plugin = supabaseDatabase({
    supabaseUrl: "http://localhost:54321",
    supabaseServiceRoleKey: "test-service-role",
  });
  await expect(
    plugin.models.insights.listEvents({
      filter: { kind: "all" },
      beforeReceivedAtMs: 200,
      limit: 101,
    }),
  ).rejects.toThrow(
    "Supabase database operation failed: findMany bundle_events",
  );
});
