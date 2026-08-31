import { readFile, readdir } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import {
  DatabasePluginInputError,
  type InsightsEventPageInput,
} from "@hot-updater/plugin-core";
import { createInsightsEventPageCursor } from "@hot-updater/plugin-core/internal";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createSupabaseInsightsEventPage } from "./insightsEventPage";
import { SUPABASE_V1_FUNCTION_NAMES } from "./supabaseInfrastructureNames";
import type { Database } from "./types";

const bundleId = "00000000-0000-0000-0000-000000000001";
const otherBundleId = "00000000-0000-0000-0000-000000000002";
const cutoff = 60_001;
const migrationsPath = "plugins/supabase/supabase/migrations";
const rpcName = SUPABASE_V1_FUNCTION_NAMES.insightsEventPage;
type Rpc = Database["public"]["Functions"][typeof rpcName];
const rpcSql = `SELECT public.${rpcName}($1, $2, $3, $4, $5, $6) AS page`;
const rpcValues = (args: Rpc["Args"]) => [
  args.p_scope,
  args.p_scope_id,
  args.p_before_received_at_ms,
  args.p_limit,
  args.p_cursor_received_at_ms,
  args.p_cursor_id,
];

type Plan = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  Plans?: Plan[];
};
const nodes = (plan: Plan): Plan[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(nodes),
];

describe("Supabase native Insights event RPC", () => {
  const db = new PGlite();
  const rpc = vi.fn(async (_name: string, args: Rpc["Args"]) => {
    try {
      const result = await db.query<{ page: Rpc["Returns"] }>(
        rpcSql,
        rpcValues(args),
      );
      return { data: result.rows[0]!.page, error: null };
    } catch (error) {
      return {
        data: null,
        error: {
          code: Reflect.get(error as object, "code"),
          message: (error as Error).message,
          details: "",
          hint: "",
        },
      };
    }
  });
  const page = createSupabaseInsightsEventPage({
    rpc: rpc as unknown as SupabaseClient<Database>["rpc"],
  });

  beforeAll(async () => {
    await db.exec(
      "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
    );
    for (const file of (await readdir(migrationsPath))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      await db.exec(await readFile(`${migrationsPath}/${file}`, "utf8"));
    }
    await db.exec(`
      INSERT INTO public.hot_updater_v1_bundle_events
        (id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      SELECT ('10000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
        'UNCHANGED', 'install-a', null, '${bundleId}', 'ios','1.0.0','production','default',null,n
      FROM generate_series(0,50000) n;
      INSERT INTO public.hot_updater_v1_bundle_events
        (id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      SELECT ('20000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid,
        CASE WHEN n % 2 = 0 THEN 'UPDATE_APPLIED' ELSE 'RECOVERED' END,
        'install-a',
        CASE WHEN n % 2 = 0 THEN '${otherBundleId}' ELSE '${bundleId}' END::uuid,
        CASE WHEN n % 2 = 0 THEN '${bundleId}' ELSE '${otherBundleId}' END::uuid,
        'ios','1.0.0','production','default','appVersion',60000
      FROM generate_series(0,102) n;
      INSERT INTO public.hot_updater_v1_bundle_events
        (id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms)
      VALUES ('21000000-0000-0000-0000-000000000001', 'UPDATE_APPLIED', 'install-b',
        '${otherBundleId}', '${bundleId}', 'ios','1.0.0','production','default','appVersion',60000),
        ('30000000-0000-0000-0000-000000000001', 'RELEASE_ADOPTED', 'install-a',
        '${otherBundleId}', '${bundleId}', 'ios','1.0.0','production','default','appVersion',60001);
      ANALYZE public.hot_updater_v1_bundle_events;
    `);
  });
  afterAll(() => db.close());

  it("enumerates more than 50,000 events without losing same-time or lookahead rows", async () => {
    const ids = new Set<string>();
    let cursor: string | undefined;
    let requests = 0;
    do {
      const result = await page({
        scope: { kind: "all" },
        beforeReceivedAtMs: cutoff,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result.rows.length).toBeLessThanOrEqual(100);
      for (const row of result.rows) {
        expect(ids.has(row.id)).toBe(false);
        ids.add(row.id);
      }
      cursor = result.nextCursor ?? undefined;
      expect(++requests).toBeLessThanOrEqual(502);
    } while (cursor !== undefined);
    expect(ids.size).toBe(50_105);
    expect(requests).toBe(502);
    expect(ids.has("10000000-0000-0000-0000-000000000000")).toBe(true);
    expect(ids.has("30000000-0000-0000-0000-000000000001")).toBe(false);
  });

  it.each([
    [{ kind: "installation", installId: "install-a" }, 103],
    [{ kind: "bundle", bundleId }, 104],
  ] as const)(
    "merges one-row %j pages without skipping unreturned candidates",
    async (scope, expected) => {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await page({
          scope,
          beforeReceivedAtMs: cutoff,
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(result.rows).toHaveLength(1);
        ids.push(result.rows[0]!.id);
        expect(ids.length).toBeLessThanOrEqual(expected);
        cursor = result.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(new Set(ids).size).toBe(expected);
      expect(ids).toEqual([...ids].sort().reverse());
    },
  );

  it("rejects malformed and cross-scope cursors before sending any RPC", async () => {
    const input: InsightsEventPageInput = {
      scope: { kind: "all" },
      beforeReceivedAtMs: cutoff,
      limit: 10,
    };
    const cursor = createInsightsEventPageCursor(input, {
      receivedAtMs: 60_000,
      id: "20000000-0000-0000-0000-000000000100",
    });
    rpc.mockClear();
    for (const invalid of [
      { ...input, limit: 101 },
      { ...input, limit: 0 },
      { ...input, cursor: "invalid" },
      { ...input, cursor, beforeReceivedAtMs: cutoff + 1 },
      {
        ...input,
        cursor,
        scope: { kind: "installation", installId: "install-a" },
      },
      { ...input, scope: { kind: "bundle", bundleId: "not-a-uuid" } },
    ]) {
      await expect(
        page(invalid as InsightsEventPageInput),
      ).rejects.toBeInstanceOf(DatabasePluginInputError);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reports undeployed RPCs as not ready without hiding permission or unrelated SQL failures", async () => {
    for (const { code, message, expected } of [
      {
        code: "PGRST202",
        message: "Could not find the function in the schema cache",
        expected: "InsightsQueryNotReadyError",
      },
      {
        code: "42883",
        message: `function public.${rpcName}(text, text, double precision, integer, double precision, uuid) does not exist`,
        expected: "InsightsQueryNotReadyError",
      },
      {
        code: "42501",
        message: "permission denied for function",
        expected: "SupabaseDatabaseError",
      },
      {
        code: "42883",
        message: "function unrelated_dependency does not exist",
        expected: "SupabaseDatabaseError",
      },
      {
        code: "42883",
        message: `function public.${rpcName}_dependency() does not exist`,
        expected: "SupabaseDatabaseError",
      },
    ]) {
      const call = vi.fn().mockResolvedValue({
        data: null,
        error: { code, message, details: "", hint: "" },
      });
      const query = createSupabaseInsightsEventPage({ rpc: call });
      await expect(
        query({ scope: { kind: "all" }, beforeReceivedAtMs: cutoff, limit: 1 }),
      ).rejects.toMatchObject({ name: expected });
      expect(call).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ["all", null, ["hot_updater_v1_bundle_events_received_at_idx"]],
    [
      "installation",
      "install-a",
      ["hot_updater_v1_bundle_events_install_type_idx"],
    ],
    [
      "bundle",
      bundleId,
      [
        "hot_updater_v1_bundle_events_to_bundle_idx",
        "hot_updater_v1_bundle_events_from_bundle_idx",
      ],
    ],
  ] as const)(
    "uses bounded index scans for the actual %s SQL body",
    async (scope, scopeId, indexes) => {
      const source = await readFile(
        "plugins/supabase/src/insightsEventPage.sql",
        "utf8",
      );
      const body = source
        .split("-- Insights.pageQuery.start")[1]!
        .split("-- Insights.pageQuery.end")[0]!;
      const bindings: Record<string, string> = {
        p_scope: "$1::text",
        p_scope_id: "$2::text",
        v_boundary_ms: "$3::double precision",
        v_boundary_id: "$4::uuid",
        p_limit: "$5::integer",
        v_bundle_id: "$6::uuid",
      };
      const statement = body.replace(
        /\b(p_scope|p_scope_id|v_boundary_ms|v_boundary_id|p_limit|v_bundle_id)\b/g,
        (name) => bindings[name]!,
      );
      for (const boundary of [
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
        "20000000-0000-0000-0000-000000000002",
      ]) {
        const result = await db.query<{ "QUERY PLAN": { Plan: Plan }[] }>(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
          [
            scope,
            scopeId,
            60000,
            boundary,
            1,
            scope === "bundle" ? bundleId : null,
          ],
        );
        const plan = nodes(result.rows[0]!["QUERY PLAN"][0]!.Plan);
        const reads = plan.filter(
          (node) =>
            node["Relation Name"] === "hot_updater_v1_bundle_events" &&
            node["Actual Loops"] > 0,
        );
        expect(reads.length).toBe(scope === "all" ? 1 : 2);
        expect(
          reads.every(
            (node) =>
              /Index.*Scan/.test(node["Node Type"]) &&
              indexes.includes(node["Index Name"] as never),
          ),
        ).toBe(true);
        expect(
          reads.reduce(
            (sum, node) =>
              sum +
              node["Actual Loops"] *
                (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)),
            0,
          ),
        ).toBeLessThanOrEqual(scope === "all" ? 2 : 4);
      }
    },
  );

  it("rejects missing and mixed-direction indexes on a warm RPC without fallback", async () => {
    const input = {
      scope: { kind: "installation" },
      beforeReceivedAtMs: cutoff,
      limit: 1,
    };
    const query = {
      ...input,
      scope: { kind: "installation", installId: "install-a" },
    } as const;
    await expect(page(query)).resolves.toHaveProperty("rows");
    await db.exec(
      "DROP INDEX public.hot_updater_v1_bundle_events_install_type_idx;",
    );
    try {
      await expect(page(query)).rejects.toMatchObject({
        name: "InsightsQueryNotReadyError",
      });
      await db.exec(`CREATE INDEX hot_updater_v1_bundle_events_install_mixed_idx
        ON public.hot_updater_v1_bundle_events(install_id, type, received_at_ms ASC, id DESC);`);
      await expect(page(query)).rejects.toMatchObject({
        name: "InsightsQueryNotReadyError",
      });
      await db.exec(`DROP INDEX public.hot_updater_v1_bundle_events_install_mixed_idx;
        CREATE INDEX hot_updater_v1_bundle_events_install_mixed_idx
          ON public.hot_updater_v1_bundle_events(id, received_at_ms, type, install_id);`);
      await expect(page(query)).rejects.toMatchObject({
        name: "InsightsQueryNotReadyError",
      });
    } finally {
      await db.exec(`DROP INDEX IF EXISTS public.hot_updater_v1_bundle_events_install_mixed_idx;
        CREATE INDEX hot_updater_v1_bundle_events_install_type_idx
          ON public.hot_updater_v1_bundle_events(install_id, type, received_at_ms, id);`);
    }
    await expect(page(query)).resolves.toHaveProperty("rows");
  });

  it("allows service_role only and validates the SQL boundary independently", async () => {
    const args: Rpc["Args"] = {
      p_scope: "all",
      p_scope_id: null,
      p_before_received_at_ms: cutoff,
      p_limit: 2,
      p_cursor_received_at_ms: null,
      p_cursor_id: null,
    };
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      try {
        await expect(db.query(rpcSql, rpcValues(args))).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    }
    await db.exec("SET ROLE service_role");
    try {
      const result = await db.query<{ page: Rpc["Returns"] }>(
        rpcSql,
        rpcValues(args),
      );
      expect(result.rows[0]!.page.rows).toHaveLength(2);
      await expect(
        db.query(rpcSql, rpcValues({ ...args, p_limit: 101 })),
      ).rejects.toMatchObject({ code: "22023" });
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
