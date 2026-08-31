import fs from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "../../../packages/server/src/createHotUpdaterCore";
import { postgres } from "./postgres";

const bundleId = "00000000-0000-0000-0000-000000000001";
const otherBundleId = "00000000-0000-0000-0000-000000000002";

type QueryPlan = {
  readonly "Node Type": string;
  readonly "Index Name"?: string;
  readonly "Actual Rows": number;
  readonly "Rows Removed by Filter"?: number;
  readonly Plans?: readonly QueryPlan[];
};

const nodes = (plan: QueryPlan): readonly QueryPlan[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(nodes),
];

describe("PostgreSQL native Insights pages", () => {
  const client = new PGlite();
  const plugin = postgres({ dialect: new PGliteDialect(client) });
  const server = createHotUpdater({
    database: plugin,
    clientAccess: { type: "public" },
  });

  beforeAll(async () => {
    await client.exec(
      await fs.readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    await client.exec(`
      insert into bundle_events (id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      select ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
        'UNCHANGED', 'unrelated-install', null, '${otherBundleId}', 'ios','1.0.0','production','default',null,n
      from generate_series(0,50000) n;
      insert into bundle_events (id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      select ('20000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
        case when n % 2 = 0 then 'UPDATE_APPLIED' else 'RECOVERED' end,
        'install-a',
        case when n % 2 = 0 then '${otherBundleId}' else '${bundleId}' end::uuid,
        case when n % 2 = 0 then '${bundleId}' else '${otherBundleId}' end::uuid,
        'ios','1.0.0','production','default','appVersion',60000
      from generate_series(0,102) n;
      analyze bundle_events;
    `);
  });

  afterAll(async () => {
    await plugin.dispose?.();
  });

  it("serves native pages through the server wrapper without scanning history or counting totals", async () => {
    const scan = vi.spyOn(plugin.models.insights, "scan");
    const query = vi.spyOn(client, "query");
    try {
      const page = await server.insights.eventPages!.getPage({
        scope: { kind: "all" },
        beforeReceivedAtMs: 60001,
        limit: 100,
      });
      expect(page.data).toHaveLength(100);
      expect(page.pagination).toMatchObject({
        hasNext: true,
        consistency: "live",
      });
      expect(page.pagination).not.toHaveProperty("total");
      const next = await server.insights.eventPages!.getPage({
        scope: { kind: "all" },
        beforeReceivedAtMs: 60001,
        limit: 4,
        cursor: page.pagination.nextCursor!,
      });
      expect(next.data.map((row) => row.id)).toEqual([
        "20000000-0000-0000-0000-000000000002",
        "20000000-0000-0000-0000-000000000001",
        "20000000-0000-0000-0000-000000000000",
        "10000000-0000-0000-0000-000000050000",
      ]);
      expect(scan).not.toHaveBeenCalled();
      const reads = query.mock.calls.filter(([statement]) =>
        statement.includes('from "bundle_events"'),
      );
      expect(reads).toHaveLength(3);
      expect(
        query.mock.calls.every(([statement]) => !/count\s*\(/i.test(statement)),
      ).toBe(true);
      for (const [statement, parameters] of reads) {
        const explain = await client.query<{
          "QUERY PLAN": readonly { Plan: QueryPlan }[];
        }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`, parameters);
        const plan = nodes(explain.rows[0]!["QUERY PLAN"][0]!.Plan);
        expect(
          plan.some((node) => /Sort|Seq Scan/.test(node["Node Type"])),
        ).toBe(false);
        const leaves = plan.filter((node) => node.Plans === undefined);
        expect(
          leaves.every(
            (node) => node["Index Name"] === "bundle_events_received_at_idx",
          ),
        ).toBe(true);
        expect(
          leaves.reduce(
            (sum, node) =>
              sum + node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0),
            0,
          ),
        ).toBeLessThanOrEqual(101);
      }
    } finally {
      scan.mockRestore();
      query.mockRestore();
    }
  });

  it("uses the two movement indexes and bounded candidates even among unrelated activity", async () => {
    const query = vi.spyOn(client, "query");
    try {
      const first = await server.insights.eventPages!.getPage({
        scope: { kind: "bundle", bundleId },
        beforeReceivedAtMs: 60001,
        limit: 1,
      });
      const next = await server.insights.eventPages!.getPage({
        scope: { kind: "bundle", bundleId },
        beforeReceivedAtMs: 60001,
        limit: 1,
        cursor: first.pagination.nextCursor!,
      });
      expect(first.data[0]?.id).toBe("20000000-0000-0000-0000-000000000102");
      expect(next.data[0]?.id).toBe("20000000-0000-0000-0000-000000000101");
      const reads = query.mock.calls.filter(([statement]) =>
        statement.includes('from "bundle_events"'),
      );
      expect(reads.length).toBeLessThanOrEqual(8);
      let examined = 0;
      for (const [statement, parameters] of reads) {
        const explain = await client.query<{
          "QUERY PLAN": readonly { Plan: QueryPlan }[];
        }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`, parameters);
        const plan = nodes(explain.rows[0]!["QUERY PLAN"][0]!.Plan);
        expect(
          plan.some((node) => /Sort|Seq Scan/.test(node["Node Type"])),
        ).toBe(false);
        const leaves = plan.filter((node) => node.Plans === undefined);
        expect(
          leaves.every((node) =>
            [
              "bundle_events_to_bundle_idx",
              "bundle_events_from_bundle_idx",
            ].includes(node["Index Name"]!),
          ),
        ).toBe(true);
        examined += leaves.reduce(
          (sum, node) =>
            sum + node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0),
          0,
        );
      }
      expect(examined).toBeLessThanOrEqual(8);
    } finally {
      query.mockRestore();
    }
  });

  it("rejects missing and mixed-direction indexes on a warm provider and recovers after migration", async () => {
    await client.exec("drop index bundle_events_received_at_idx");
    const query = vi.spyOn(client, "query");
    const input = {
      scope: { kind: "all" },
      beforeReceivedAtMs: 60001,
      limit: 1,
    } as const;
    try {
      await expect(
        plugin.models.insights.events!.page(input),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      expect(
        query.mock.calls.some(([statement]) =>
          statement.includes('from "bundle_events"'),
        ),
      ).toBe(false);
      await client.exec(
        "create index bundle_events_mixed_idx on bundle_events(received_at_ms asc, id desc)",
      );
      await expect(
        plugin.models.insights.events!.page(input),
      ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
      expect(
        query.mock.calls.some(([statement]) =>
          statement.includes('from "bundle_events"'),
        ),
      ).toBe(false);
      await client.exec("drop index bundle_events_mixed_idx");
      await client.exec(
        "create index bundle_events_received_at_idx on bundle_events(received_at_ms, id)",
      );
      await expect(
        plugin.models.insights.events!.page(input),
      ).resolves.toMatchObject({ rows: [expect.any(Object)] });
      expect(plugin.models.insights.events!.scopes).toEqual(["all", "bundle"]);
    } finally {
      query.mockRestore();
    }
  });

  it("rejects noncanonical UUID scope and cursor input before catalog or event queries", async () => {
    const query = vi.spyOn(client, "query");
    try {
      for (const input of [
        {
          scope: { kind: "bundle" as const, bundleId: "not-a-uuid" },
          beforeReceivedAtMs: 60001,
          limit: 1,
        },
        {
          scope: { kind: "all" as const },
          beforeReceivedAtMs: 60001,
          limit: 1,
          cursor: JSON.stringify([1, '["all"]', 60001, 60000, "not-a-uuid"]),
        },
      ]) {
        await expect(
          plugin.models.insights.events!.page(input),
        ).rejects.toMatchObject({ code: "invalid-query" });
      }
      expect(query).not.toHaveBeenCalled();
      const response = await server.handlers.admin(
        new Request(
          "https://example.com/insights/v1/events?scope=bundle&bundleId=not-a-uuid",
        ),
      );
      expect(response.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });
});
