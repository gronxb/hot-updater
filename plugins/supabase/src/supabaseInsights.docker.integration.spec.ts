import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import type { BundleEventRow } from "@hot-updater/plugin-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findOpenPort } from "../../../packages/test-utils/src/runtimeProcess";
import { SUPABASE_V1_FUNCTION_NAMES } from "./supabaseInfrastructureNames";
import {
  createSupabaseInsights,
  createSupabaseInsightsMaintenance,
} from "./supabaseInsights";
import type { Database } from "./types";

const secret = "local-insights-test-secret-with-at-least-32-characters";
const token = (role: string) => {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
};
const docker = (args: string[], input?: string) => {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};

const waitUntil = async (ready: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await setTimeout(250);
  }
  throw new Error("Local Insights RPC fixture did not become ready.");
};

type ExplainPlan = {
  "Node Type": string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: ExplainPlan[];
};

const planNodes = (plan: ExplainPlan): ExplainPlan[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(planNodes),
];

describe("Supabase Insights scalar RPC with PostgREST max_rows=1", () => {
  const network = `hot-updater-insights-${randomUUID().slice(0, 8)}`;
  const database = `${network}-db`;
  const rest = `${network}-rest`;
  let origin: string;
  let service: SupabaseClient<Database>;
  const eventPageResponseBytes: number[] = [];
  const client = (role: string) =>
    createClient<Database>(origin, token(role), {
      auth: { persistSession: false },
      // This focused fixture runs PostgREST directly, without Supabase's gateway.
      global: {
        fetch: async (input, init) => {
          const url = String(input).replace(`${origin}/rest/v1/`, `${origin}/`);
          const response = await fetch(url, init);
          if (
            url.includes(`/rpc/${SUPABASE_V1_FUNCTION_NAMES.insightsEventPage}`)
          ) {
            eventPageResponseBytes.push(
              new TextEncoder().encode(await response.clone().text()).length,
            );
          }
          return response;
        },
      },
    });

  beforeAll(async () => {
    // Do not silently download images as part of this bounded regression test.
    docker([
      "image",
      "inspect",
      "postgres:15-alpine",
      "postgrest/postgrest:v14.6",
    ]);
    docker(["network", "create", network]);
    docker([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      database,
      "--network",
      network,
      "--shm-size=1g",
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=2g",
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "postgres:15-alpine",
    ]);
    await waitUntil(
      () =>
        spawnSync("docker", [
          "exec",
          database,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
        ]).status === 0,
    );
    const migrationDirectory = "plugins/supabase/supabase/migrations";
    const migrations = await Promise.all(
      (await readdir(migrationDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort()
        .map((file) => readFile(`${migrationDirectory}/${file}`, "utf8")),
    );
    const [baseMigration, ...insightsMigrations] = migrations;
    docker(
      [
        "exec",
        "-i",
        database,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      `
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE ROLE authenticator LOGIN NOINHERIT;
      GRANT anon, authenticated, service_role TO authenticator;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
      ${baseMigration}
      CREATE OR REPLACE FUNCTION public.hot_updater_v1_commit(p_commit jsonb)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog
      AS $old_commit$
      DECLARE
        v_change jsonb;
        v_event public.hot_updater_v1_bundle_events;
      BEGIN
        FOR v_change IN SELECT value
          FROM jsonb_array_elements(p_commit->'changes') AS change(value)
        LOOP
          IF v_change->>'model'='insights' THEN
            v_event:=jsonb_populate_record(
              null::public.hot_updater_v1_bundle_events,v_change->'row'
            );
            INSERT INTO public.hot_updater_v1_bundle_events (
              id,type,install_id,user_id,username,from_release_id,
              from_bundle_id,to_release_id,to_bundle_id,platform,app_version,
              channel,cohort,update_strategy,fingerprint_hash,sdk_version,
              received_at_ms
            ) VALUES (
              v_event.id,v_event.type,v_event.install_id,v_event.user_id,
              v_event.username,v_event.from_release_id,v_event.from_bundle_id,
              v_event.to_release_id,v_event.to_bundle_id,v_event.platform,
              v_event.app_version,v_event.channel,v_event.cohort,
              v_event.update_strategy,v_event.fingerprint_hash,
              v_event.sdk_version,v_event.received_at_ms
            );
          END IF;
        END LOOP;
        RETURN jsonb_build_object('committed',true);
      END;
      $old_commit$;
      INSERT INTO public.hot_updater_v1_bundle_events (
        id,type,install_id,user_id,username,from_bundle_id,to_bundle_id,
        platform,app_version,channel,cohort,update_strategy,received_at_ms
      ) VALUES (
        '018e0000-0000-7000-8000-000000000001','UNCHANGED','install-a',
        'İ-AΣ!','café-é',null,
        '00000000-0000-0000-0000-000000000001','ios','1.0.0','production',
        'default',null,101
      );
      ${insightsMigrations.join("\n")}
      INSERT INTO public.hot_updater_v1_bundle_events
        (id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,channel,cohort,update_strategy,received_at_ms,insights_source_seq,insights_install_key,insights_cohort_order)
      SELECT ('018f0000-0000-7000-8000-' || lpad(n::text,12,'0'))::uuid,
        'UPDATE_APPLIED', CASE WHEN n < 3 THEN 'install-a' ELSE 'install-b' END,
        '00000000-0000-0000-0000-000000000002',
        CASE WHEN n < 3 THEN '00000000-0000-0000-0000-000000000001'::uuid
          ELSE '00000000-0000-0000-0000-000000000003'::uuid END,
        'ios','1.0.0','production','default','appVersion',100,
        n + 1, sha256(convert_to(to_jsonb(
          CASE WHEN n < 3 THEN 'install-a' ELSE 'install-b' END
        )::text,'utf8')),decode('00640065006600610075006c0074','hex')
      FROM generate_series(0,4) n;
      UPDATE public.hot_updater_v1_bundle_events AS event
      SET insights_event_bytes=octet_length(
        public.hot_updater_v1_insights_canonical_json(
          public.hot_updater_v1_insights_event_json(event)
        )
      ) WHERE insights_source_seq IS NOT NULL;
      INSERT INTO public.hot_updater_v1_insights_live_installations (
        install_key,install_id,event_id,received_at_ms,source_seq,event
      )
      SELECT DISTINCT ON (insights_install_key)
        insights_install_key,install_id,id,received_at_ms,insights_source_seq,
        public.hot_updater_v1_insights_event_json(event)
      FROM public.hot_updater_v1_bundle_events event
      WHERE insights_source_seq IS NOT NULL
      ORDER BY insights_install_key,received_at_ms DESC,id DESC;
      INSERT INTO public.hot_updater_v1_insights_installation_versions (
        install_key,source_seq,event_id
      )
      SELECT install_key,source_seq,event_id
      FROM public.hot_updater_v1_insights_live_installations;
      INSERT INTO public.hot_updater_v1_insights_aliases (
        source_seq,install_key,install_id,alias_kind,alias_key,original_alias,
        normalized_alias
      )
      SELECT min(insights_source_seq),insights_install_key,min(install_id),
        'installationId',sha256(convert_to(
          to_jsonb(min(install_id))::text,'utf8'
        )),min(install_id),lower(min(install_id))
      FROM public.hot_updater_v1_bundle_events
      WHERE insights_source_seq IS NOT NULL
      GROUP BY insights_install_key;
      UPDATE public.hot_updater_v1_insights_source_state SET committed_seq=5 WHERE id=1;
    `,
    );
    const port = await findOpenPort();
    origin = `http://127.0.0.1:${port}`;
    docker([
      "run",
      "--detach",
      "--rm",
      "--pull=never",
      "--name",
      rest,
      "--network",
      network,
      "-p",
      `127.0.0.1:${port}:3000`,
      "-e",
      `PGRST_DB_URI=postgres://authenticator@${database}:5432/postgres`,
      "-e",
      "PGRST_DB_SCHEMAS=public",
      "-e",
      "PGRST_DB_ANON_ROLE=anon",
      "-e",
      "PGRST_DB_MAX_ROWS=1",
      "-e",
      `PGRST_JWT_SECRET=${secret}`,
      "postgrest/postgrest:v14.6",
    ]);
    await waitUntil(async () => {
      try {
        return (await fetch(origin)).ok;
      } catch {
        return false;
      }
    });
    service = client("service_role");
    const migration = createSupabaseInsightsMaintenance(service);
    for (let step = 0; step < 16; step += 1) {
      const result = await migration.runJobStep("supabase-v2-migration", {
        maxItems: 1000,
        maxRequests: 2,
      });
      if (result.state === "complete") break;
      if (result.state === "failed" || step === 15) {
        throw new Error("Local Insights migration did not complete");
      }
    }
  }, 60_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "--force", rest, database]);
    spawnSync("docker", ["network", "rm", network]);
  });

  it("fences the raw table but returns complete scalar pages", async () => {
    const privateObjects = [
      "hot_updater_v1_bundle_events",
      "hot_updater_v1_insights_source_state",
      "hot_updater_v1_insights_live_installations",
      "hot_updater_v1_insights_installation_versions",
      "hot_updater_v1_insights_aliases",
      "hot_updater_v1_insights_search_jobs",
      "hot_updater_v1_insights_search_members",
      "hot_updater_v1_insights_search_results",
      "hot_updater_v1_insights_publications",
      "hot_updater_v1_insights_report_jobs",
      "hot_updater_v1_insights_report_members",
      "hot_updater_v1_insights_report_counts",
      "hot_updater_v1_insights_report_section_totals",
      "hot_updater_v1_insights_report_latest",
      "hot_updater_v1_insights_report_bundle_order",
      "hot_updater_v1_insights_report_rows",
      "hot_updater_v1_insights_report_totals",
    ];
    const acl = docker([
      "exec",
      database,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-At",
      "-c",
      `SELECT bool_and(NOT has_table_privilege(
         'service_role','public.'||name,'SELECT,INSERT,UPDATE,DELETE'))
       FROM unnest(ARRAY[${privateObjects
         .map((name) => `'${name}'`)
         .join(",")}]) AS private(name);
       SELECT NOT has_sequence_privilege(
         'service_role','public.hot_updater_v1_insights_aliases_id_seq',
         'USAGE,SELECT,UPDATE');`,
    ]);
    expect(acl.trim().split("\n")).toEqual(["t", "t"]);
    const legacyWriter = docker([
      "exec",
      database,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-At",
      "-c",
      `SELECT position('insights' in pg_get_functiondef(
         'public.hot_updater_v1_commit_before_insights_v2(jsonb)'::regprocedure
       )) > 0;`,
    ]);
    expect(legacyWriter.trim()).toBe("t");
    expect(() =>
      docker([
        "exec",
        database,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `SET ROLE service_role;
         SELECT public.hot_updater_v1_commit(
           '{"changes":[{"model":"insights","operation":"insert","row":{}}]}'::jsonb
         );`,
      ]),
    ).toThrow("Insights events require the append RPC");

    const rawTable = service.from("hot_updater_v1_bundle_events");
    const forbidden = await Promise.all([
      rawTable.select("*").limit(2),
      rawTable.insert({} as never),
      rawTable
        .update({ cohort: "forbidden" })
        .eq("id", "018f0000-0000-7000-8000-000000000000"),
      rawTable.delete().eq("id", "018f0000-0000-7000-8000-000000000000"),
    ]);
    for (const result of forbidden) {
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("42501");
    }

    const insights = createSupabaseInsights(service, origin);
    const maintenance = createSupabaseInsightsMaintenance(service);
    const finishJob = async (jobId: string) => {
      for (let step = 0; step < 32; step += 1) {
        const result = await maintenance.runJobStep(jobId, {
          maxItems: 256,
          maxRequests: 1,
        });
        if (result.state === "complete") return;
        if (result.state === "failed") throw new Error("Insights job failed");
      }
      throw new Error("Insights job did not complete");
    };
    const page = insights.pageEvents;
    const input = {
      selector: { kind: "all" },
      beforeReceivedAtMs: 101,
      limit: 2,
    } as const;
    const first = await page(input);
    expect(first.state).toBe("ready");
    if (first.state !== "ready") return;
    expect(first.data.data).toHaveLength(2);
    expect(first.data.nextCursor).not.toBeNull();
    const second = await page({ ...input, cursor: first.data.nextCursor! });
    expect(second.state).toBe("ready");
    if (second.state !== "ready") return;
    expect(second.data.data).toHaveLength(2);
    const third = await page({ ...input, cursor: second.data.nextCursor! });
    expect(third.state).toBe("ready");
    if (third.state !== "ready") return;
    expect(third.data.data).toHaveLength(1);
    expect(third.data.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.data.data, ...second.data.data, ...third.data.data].map(
          (row) => row.id,
        ),
      ).size,
    ).toBe(5);
    for (const selector of [
      { kind: "installationId", installId: "install-a" },
      { kind: "bundleId", bundleId: "00000000-0000-0000-0000-000000000001" },
    ] as const) {
      const result = await page({ ...input, selector });
      expect(result.state === "ready" && result.data.data).toHaveLength(2);
    }

    const installations = await insights.pageInstallations({
      kind: "all",
      limit: 2,
    });
    expect(
      installations.state === "ready" && installations.data.data,
    ).toHaveLength(2);
    const exact = await insights.pageInstallations({
      kind: "installationId",
      installId: "install-a",
      limit: 1,
    });
    expect(exact.state === "ready" && exact.data.data).toHaveLength(1);
    const searchInput = {
      kind: "contains",
      query: "install",
      limit: 2,
    } as const;
    let search = await insights.pageInstallations(searchInput);
    if (search.state === "preparing") {
      await finishJob(search.job.id);
      search = await insights.pageInstallations(searchInput);
    }
    expect(search.state === "ready" && search.data.data).toHaveLength(2);
    const unicodeInput = {
      kind: "contains",
      query: "i\u0307-aς!",
      limit: 2,
    } as const;
    let unicode = await insights.pageInstallations(unicodeInput);
    if (unicode.state === "preparing") {
      await finishJob(unicode.job.id);
      unicode = await insights.pageInstallations(unicodeInput);
    }
    expect(unicode.state === "ready" && unicode.data.data).toHaveLength(1);
    expect(unicode.state === "ready" && unicode.data.data[0]?.install_id).toBe(
      "install-a",
    );

    const reportInput = {
      query: { kind: "installationOverview" },
    } as const;
    let report = await insights.getReport(reportInput);
    if (report.state === "preparing") {
      await finishJob(report.job.id);
      report = await insights.getReport(reportInput);
    }
    expect(report.state).toBe("ready");
    if (report.state !== "ready") return;
    expect(report.data.summary).toEqual({ trackedInstallations: 2 });
    const reportPage = await insights.pageReport({
      publicationId: report.data.id,
      section: "bundleDistribution",
      limit: 2,
    });
    expect(reportPage.state === "ready" && reportPage.data.data).toHaveLength(
      2,
    );
  });

  it("keeps long BMP identities index-safe and exponent pages byte-bounded", async () => {
    const insights = createSupabaseInsights(service, origin);
    const maintenance = createSupabaseInsightsMaintenance(service);
    const finishJob = async (jobId: string) => {
      for (let step = 0; step < 64; step += 1) {
        const result = await maintenance.runJobStep(jobId, {
          maxItems: 256,
          maxRequests: 1,
        });
        if (result.state === "complete") return;
        if (result.state === "failed") throw new Error("Insights job failed");
      }
      throw new Error("Insights job did not complete");
    };
    const installId = "界".repeat(1024);
    const userId = "語".repeat(1024);
    const username = "名".repeat(1024);
    const cohort = "群".repeat(1024);
    const receivedAtMs = Date.now() - 120_000;
    const longRow: BundleEventRow = {
      id: "01900000-0000-7000-8000-000000000001",
      type: "UPDATE_APPLIED",
      install_id: installId,
      user_id: userId,
      username,
      from_release_id: null,
      from_bundle_id: "00000000-0000-0000-0000-000000000002",
      to_release_id: null,
      to_bundle_id: "00000000-0000-0000-0000-000000000001",
      platform: "ios",
      app_version: "1.0.0",
      channel: "production",
      cohort,
      update_strategy: "appVersion",
      fingerprint_hash: null,
      sdk_version: null,
      received_at_ms: receivedAtMs,
    };
    await insights.append(longRow);
    const eventPage = await insights.pageEvents({
      selector: { kind: "installationId", installId },
      beforeReceivedAtMs: receivedAtMs + 1,
      limit: 1,
    });
    expect(eventPage.state === "ready" && eventPage.data.data[0]?.id).toBe(
      longRow.id,
    );
    const exact = await insights.pageInstallations({
      kind: "installationId",
      installId,
      limit: 1,
    });
    expect(exact.state === "ready" && exact.data.data[0]?.install_id).toBe(
      installId,
    );
    let search = await insights.pageInstallations({
      kind: "userId",
      userId,
      limit: 1,
    });
    if (search.state === "preparing") {
      await finishJob(search.job.id);
      search = await insights.pageInstallations({
        kind: "userId",
        userId,
        limit: 1,
      });
    }
    expect(search.state === "ready" && search.data.data[0]?.install_id).toBe(
      installId,
    );
    const reportInput = {
      query: {
        kind: "bundleDetail",
        bundleId: longRow.to_bundle_id!,
        window: "24h",
      },
    } as const;
    let report = await insights.getReport(reportInput);
    if (report.state === "preparing") {
      await finishJob(report.job.id);
      report = await insights.getReport(reportInput);
    }
    expect(report.state).toBe("ready");
    if (report.state !== "ready") return;
    const cohorts = await insights.pageReport({
      publicationId: report.data.id,
      section: "movementCohorts",
      metric: "installed",
      limit: 100,
    });
    expect(
      cohorts.state === "ready" &&
        cohorts.data.data.some(
          (row) => "cohort" in row && row.cohort === cohort,
        ),
    ).toBe(true);

    const unsafeIndexes = docker([
      "exec",
      database,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-At",
      "-c",
      `SELECT coalesce(string_agg(index_name||':'||column_name,','),'')
       FROM (
         SELECT index_class.relname index_name,
           pg_get_indexdef(indexes.indexrelid,position,false) column_name
         FROM pg_index indexes
         JOIN pg_class table_class ON table_class.oid=indexes.indrelid
         JOIN pg_class index_class ON index_class.oid=indexes.indexrelid
         CROSS JOIN LATERAL generate_series(1,indexes.indnkeyatts) position
         WHERE table_class.relname IN (
           'hot_updater_v1_bundle_events',
           'hot_updater_v1_insights_live_installations',
           'hot_updater_v1_insights_aliases',
           'hot_updater_v1_insights_report_members',
           'hot_updater_v1_insights_report_counts',
           'hot_updater_v1_insights_report_rows'
         )
       ) indexed
       WHERE column_name IN (
         'install_id','user_id','username','original_alias','group_key','order_key'
       );`,
    ]);
    expect(unsafeIndexes.trim()).toBe("");

    const exponentNumbers = Array(2500).fill(5e-324);
    const exponentRows = [2, 3].map(
      (suffix): BundleEventRow =>
        Object.assign(
          {
            ...longRow,
            id: `01900000-0000-7000-8000-${suffix
              .toString()
              .padStart(12, "0")}`,
            install_id: `exponent-${suffix}`,
            user_id: null,
            username: null,
            cohort: "default",
            received_at_ms: receivedAtMs + suffix,
          },
          { extension: { values: exponentNumbers } },
        ),
    );
    for (const row of exponentRows) await insights.append(row);
    eventPageResponseBytes.length = 0;
    const exponentInput = {
      selector: { kind: "all" as const },
      sinceReceivedAtMs: receivedAtMs + 2,
      beforeReceivedAtMs: receivedAtMs + 4,
      limit: 100,
    };
    const first = await insights.pageEvents(exponentInput);
    expect(first.state).toBe("ready");
    if (first.state !== "ready") return;
    expect(first.data.data).toHaveLength(1);
    expect(first.data.nextCursor).not.toBeNull();
    const second = await insights.pageEvents({
      ...exponentInput,
      cursor: first.data.nextCursor!,
    });
    expect(second.state === "ready" && second.data.data).toHaveLength(1);
    expect(Math.max(...eventPageResponseBytes)).toBeLessThanOrEqual(
      1024 * 1024,
    );
  }, 120_000);

  it("keeps all eight native reads bounded beyond 50,000 events", async () => {
    const scaleAsOfMs = Date.now();
    const targetBundle = "10000000-0000-7000-8000-000000000000";
    const [baseTracked, baseActive] = docker([
      "exec",
      database,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-At",
      "-F",
      ",",
      "-c",
      `SELECT
         (SELECT count(*) FROM public.hot_updater_v1_insights_live_installations),
         (SELECT count(DISTINCT insights_install_key)
          FROM public.hot_updater_v1_bundle_events
          WHERE received_at_ms BETWEEN ${scaleAsOfMs}-86400000 AND ${scaleAsOfMs});`,
    ])
      .trim()
      .split(",")
      .map(Number);
    docker(
      [
        "exec",
        "-i",
        database,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      `DO $$
       DECLARE v_base bigint;
       BEGIN
         SELECT committed_seq INTO v_base
         FROM public.hot_updater_v1_insights_source_state WHERE id=1;
         INSERT INTO public.hot_updater_v1_bundle_events (
           id,type,install_id,from_bundle_id,to_bundle_id,platform,app_version,
           channel,cohort,update_strategy,received_at_ms,insights_source_seq,
           insights_install_key,insights_cohort_order
         ) SELECT
           ('018f1000-0000-7000-8000-'||lpad(n::text,12,'0'))::uuid,
           CASE n%4 WHEN 0 THEN 'UPDATE_APPLIED' WHEN 1 THEN 'RECOVERED'
             ELSE 'UNCHANGED' END,
           'bulk-'||lpad(n::text,6,'0'),
           CASE n%4 WHEN 0 THEN
             '10000000-0000-7000-8000-000000000999'::uuid
             WHEN 1 THEN '${targetBundle}'::uuid ELSE null END,
           ('10000000-0000-7000-8000-'||lpad((CASE WHEN n<1000
             THEN n%128 ELSE n END)::text,12,'0'))::uuid,
           'ios','1.0.0','production','bulk',
           CASE WHEN n%4<2 THEN 'appVersion' ELSE null END,
           ${scaleAsOfMs}-CASE WHEN n<1000 THEN (n%24)*3600000
             ELSE 30::bigint*86400000+(n%24)::bigint*3600000 END,v_base+n+1,
           sha256(convert_to(to_jsonb('bulk-'||lpad(n::text,6,'0'))::text,'utf8')),
           decode('00620075006c006b','hex')
         FROM generate_series(0,50000) n;
         UPDATE public.hot_updater_v1_bundle_events AS event
         SET insights_event_bytes=octet_length(
           public.hot_updater_v1_insights_canonical_json(
             public.hot_updater_v1_insights_event_json(event)
           )
         ) WHERE insights_source_seq>v_base;
         INSERT INTO public.hot_updater_v1_insights_live_installations (
           install_key,install_id,event_id,received_at_ms,source_seq,event
         ) SELECT insights_install_key,install_id,id,received_at_ms,
           insights_source_seq,public.hot_updater_v1_insights_event_json(event)
         FROM public.hot_updater_v1_bundle_events event
         WHERE insights_source_seq>v_base;
         INSERT INTO public.hot_updater_v1_insights_installation_versions (
           install_key,source_seq,event_id
         ) SELECT insights_install_key,insights_source_seq,id
         FROM public.hot_updater_v1_bundle_events WHERE insights_source_seq>v_base;
         INSERT INTO public.hot_updater_v1_insights_aliases (
           source_seq,install_key,install_id,alias_kind,alias_key,original_alias,
           normalized_alias
         ) SELECT insights_source_seq,insights_install_key,install_id,
           'installationId',sha256(convert_to(
             to_jsonb(install_id)::text,'utf8'
           )),install_id,install_id
         FROM public.hot_updater_v1_bundle_events WHERE insights_source_seq>v_base;
         UPDATE public.hot_updater_v1_insights_source_state
         SET committed_seq=v_base+50001 WHERE id=1;
       END $$;`,
    );
    const insights = createSupabaseInsights(service, origin, () => scaleAsOfMs);
    const maintenance = createSupabaseInsightsMaintenance(service);
    const finish = async (jobId: string) => {
      for (let step = 0; step < 128; step += 1) {
        let result: Awaited<ReturnType<typeof maintenance.runJobStep>>;
        try {
          result = await maintenance.runJobStep(jobId, {
            maxItems: 4096,
            maxRequests: 1,
          });
        } catch (error) {
          throw new Error(
            `Insights job step failed: ${JSON.stringify(
              Reflect.get(error as object, "cause"),
            )}`,
            { cause: error },
          );
        }
        expect(result.usage.items).toBeLessThanOrEqual(4096);
        expect(result.usage.requests).toBe(1);
        expect(result.usage.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        if (result.state === "complete") return result.publicationId;
        if (result.state === "failed") throw new Error("Insights job failed");
      }
      throw new Error("Insights job did not finish within bounded steps");
    };

    const events = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: scaleAsOfMs + 1,
      limit: 100,
    });
    expect(events.state).toBe("ready");
    if (events.state !== "ready") return;
    expect(events.data.data.length).toBeGreaterThan(0);
    expect(events.data.data.length).toBeLessThanOrEqual(100);
    expect(events.data.nextCursor).not.toBeNull();
    const all = await insights.pageInstallations({ kind: "all", limit: 100 });
    expect(all.state === "ready" && all.data.data).toHaveLength(100);
    const exact = await insights.pageInstallations({
      kind: "installationId",
      installId: "bulk-050000",
      limit: 1,
    });
    expect(exact.state === "ready" && exact.data.data).toHaveLength(1);
    const searchInput = {
      kind: "contains",
      query: "bulk-",
      limit: 100,
    } as const;
    let search = await insights.pageInstallations(searchInput);
    expect(search.state).toBe("preparing");
    if (search.state !== "preparing") return;
    await finish(search.job.id);
    search = await insights.pageInstallations(searchInput);
    expect(search.state).toBe("ready");
    if (search.state !== "ready") return;
    expect(search.data.total).toMatchObject({ state: "exact", value: 50_001 });

    const detailInput = {
      query: {
        kind: "bundleDetail",
        bundleId: targetBundle,
        window: "24h",
      },
    } as const;
    let report = await insights.getReport(detailInput);
    expect(report.state).toBe("preparing");
    if (report.state !== "preparing") return;
    await finish(report.job.id);
    report = await insights.getReport(detailInput);
    expect(report.state).toBe("ready");
    if (report.state !== "ready") return;
    if (!("installed" in report.data.summary)) {
      throw new Error("Bundle detail returned an unexpected summary shape");
    }
    const detailSummary = report.data.summary;
    expect(detailSummary.installed).toBeGreaterThan(0);
    expect(detailSummary.recovered).toBeGreaterThan(0);
    const movement = await insights.pageReport({
      publicationId: report.data.id,
      section: "movementSeries",
      metric: "installed",
      limit: 100,
    });
    expect(
      movement.state === "ready" &&
        movement.data.data.reduce(
          (sum, row) => sum + ("value" in row ? row.value : 0),
          0,
        ),
    ).toBe(detailSummary.installed);

    const freshInsights = createSupabaseInsights(
      service,
      origin,
      () => scaleAsOfMs + 1,
    );
    const overviewInput = {
      query: { kind: "installationOverview" },
      minAsOfMs: scaleAsOfMs + 1,
    } as const;
    let overview = await freshInsights.getReport(overviewInput);
    expect(["preparing", "stale"]).toContain(overview.state);
    if (overview.state === "preparing") await finish(overview.job.id);
    else if (overview.state === "stale") await finish(overview.refresh.id);
    else return;
    overview = await freshInsights.getReport(overviewInput);
    expect(
      overview.state === "ready" &&
        "trackedInstallations" in overview.data.summary &&
        overview.data.summary.trackedInstallations,
    ).toBe(baseTracked! + 50_001);
    if (overview.state !== "ready") return;
    const distribution = await insights.pageReport({
      publicationId: overview.data.id,
      section: "bundleDistribution",
      limit: 100,
    });
    expect(distribution.state === "ready" && distribution.data.hasNext).toBe(
      true,
    );

    const activeInput = {
      query: { kind: "activeOverview", window: "24h" },
    } as const;
    let active = await freshInsights.getReport(activeInput);
    expect(active.state).toBe("preparing");
    if (active.state !== "preparing") return;
    await finish(active.job.id);
    active = await freshInsights.getReport(activeInput);
    expect(
      active.state === "ready" &&
        "activeInstallations" in active.data.summary &&
        active.data.summary.activeInstallations,
    ).toBe(baseActive! + 1_000);
    if (active.state !== "ready") return;
    const activeBundles = await insights.pageReport({
      publicationId: active.data.id,
      section: "activeBundleSeries",
      limit: 100,
    });
    expect(activeBundles.state === "ready" && activeBundles.data.hasNext).toBe(
      true,
    );

    const summariesInput = {
      query: {
        kind: "bundleSummaries",
        bundleIds: [targetBundle],
        window: "24h",
      },
    } as const;
    let summaries = await insights.getReport(summariesInput);
    expect(summaries.state).toBe("preparing");
    if (summaries.state !== "preparing") return;
    await finish(summaries.job.id);
    summaries = await insights.getReport(summariesInput);
    expect(summaries.state === "ready" && summaries.data.summary).toEqual([
      { bundleId: targetBundle, ...detailSummary },
    ]);

    const searchPublicationId = search.data.consistency.cutoff.publication.id;
    const planCases = [
      {
        name: "search-alias-source",
        bound: 4096,
        sql: `SELECT id FROM public.hot_updater_v1_insights_aliases
          WHERE id>0 AND id<=(SELECT alias_upper_id
            FROM public.hot_updater_v1_insights_search_jobs
            WHERE id='${searchPublicationId}')
          ORDER BY id LIMIT 4096`,
      },
      {
        name: "search-published-page",
        bound: 101,
        sql: `SELECT ordinal FROM public.hot_updater_v1_insights_search_results
          WHERE job_id='${searchPublicationId}' AND ordinal>-1
          ORDER BY ordinal LIMIT 101`,
      },
      {
        name: "report-source",
        bound: 4096,
        sql: `SELECT insights_source_seq
          FROM public.hot_updater_v1_bundle_events
          WHERE insights_source_seq>0 AND insights_source_seq<=(
            SELECT source_seq FROM public.hot_updater_v1_insights_report_jobs
            WHERE id='${report.data.id}')
          ORDER BY insights_source_seq LIMIT 4096`,
      },
      {
        name: "report-latest",
        bound: 4096,
        sql: `SELECT install_key,bucket_start_ms
          FROM public.hot_updater_v1_insights_report_latest
          WHERE job_id='${active.data.id}'
          ORDER BY install_key,bucket_start_ms LIMIT 4096`,
      },
      {
        name: "report-ranked-output",
        bound: 4096,
        sql: `SELECT value,bundle_id
          FROM public.hot_updater_v1_insights_report_counts
          WHERE job_id='${overview.data.id}' AND dimension='bundleDistribution'
            AND discriminator=''
          ORDER BY value DESC,bundle_id LIMIT 4096`,
      },
      {
        name: "report-filtered-page",
        bound: 101,
        sql: `SELECT ordinal
          FROM public.hot_updater_v1_insights_report_rows
          WHERE publication_id='${active.data.id}'
            AND section='activeBundleSeries' AND discriminator=''
            AND bundle_id='${targetBundle}'
          ORDER BY ordinal LIMIT 101`,
      },
    ];
    const capturedPlans: Record<string, unknown> = {};
    for (const planCase of planCases) {
      const explained = JSON.parse(
        docker([
          "exec",
          database,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-At",
          "-c",
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${planCase.sql}`,
        ]),
      ) as { Plan: ExplainPlan }[];
      capturedPlans[planCase.name] = explained[0];
      const plan = explained[0]!.Plan;
      const nodes = planNodes(plan);
      expect(plan["Actual Rows"], planCase.name).toBeGreaterThan(0);
      expect(plan["Actual Rows"], planCase.name).toBeLessThanOrEqual(
        planCase.bound,
      );
      expect(
        nodes.some((node) => node["Node Type"].includes("Index")),
        planCase.name,
      ).toBe(true);
      for (const node of nodes.filter((candidate) =>
        candidate["Node Type"].endsWith("Scan"),
      )) {
        expect(
          node["Actual Rows"] * node["Actual Loops"],
          `${planCase.name}:${node["Node Type"]}:rows`,
        ).toBeLessThanOrEqual(planCase.bound);
        expect(
          (node["Rows Removed by Filter"] ?? 0) * node["Actual Loops"],
          `${planCase.name}:${node["Node Type"]}:filtered`,
        ).toBeLessThanOrEqual(planCase.bound);
      }
      expect(
        nodes.reduce(
          (blocks, node) =>
            blocks +
            (node["Shared Hit Blocks"] ?? 0) +
            (node["Shared Read Blocks"] ?? 0),
          0,
        ),
        `${planCase.name}:buffers`,
      ).toBeGreaterThan(0);
    }
    if (process.env.HOT_UPDATER_CAPTURE_SUPABASE_INSIGHTS_EVIDENCE === "1") {
      const sql = await readFile(
        "plugins/supabase/src/insightsScale.sql",
        "utf8",
      );
      await writeFile(
        "docs/architecture/insights-scale-evidence/supabase-native-scale-plans.json",
        `${JSON.stringify(
          {
            capturedAt: "2026-09-01",
            engine: "PostgreSQL 15-alpine",
            method: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
            authoritativeSqlSha256: createHash("sha256")
              .update(sql)
              .digest("hex"),
            fixture: {
              events: 50_001,
              installations: 50_001,
              historicalUniqueBundles: 49_001,
            },
            assertions: {
              nonEmptyPlans: true,
              scanRowsAndFilteredRowsBoundedByCallerBudget: true,
              indexNodePresentInEveryPlan: true,
              sequentialScansAllowedOnlyWithinTheSameMeasuredBudget: true,
            },
            plans: capturedPlans,
          },
          null,
          2,
        )}\n`,
      );
    }
  }, 300_000);

  it("does not expose any Insights RPC to anon or authenticated JWT roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      const restricted = client(role);
      const rpc = restricted.rpc.bind(restricted);
      const results = await Promise.all([
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsPrepareRead, {
          p_max_items: 1,
        }),
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsPrepare, {
          p_max_items: 1,
          p_batch: [],
          p_batch_bytes: 2,
        }),
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsAppend, {
          p_event: {} as never,
          p_event_bytes: 0,
          p_install_key: "0".repeat(64),
          p_cohort_order: "",
          p_aliases: [],
        }),
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsEventPage, {
          p_scope: "all",
          p_scope_id: null,
          p_limit: 2,
          p_before_received_at_ms: 101,
          p_since_received_at_ms: 0,
          p_cursor_received_at_ms: null,
          p_cursor_id: null,
        }),
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsInstallationPage, {
          p_selector: { kind: "all" },
          p_limit: 1,
          p_after_key: null,
          p_after_ordinal: null,
          p_publication_id: null,
          p_min_as_of_ms: null,
          p_now_ms: Date.now(),
        }),
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsSearchStep, {
          p_job_id: "search:missing",
          p_max_items: 1,
          p_max_bytes: 1,
        }),
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsReport, {
          p_query: { kind: "installationOverview" },
          p_min_as_of_ms: null,
          p_now_ms: Date.now(),
        }),
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsReportStep, {
          p_job_id: "report:missing",
          p_max_items: 1,
          p_max_bytes: 1,
        }),
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsReportPage, {
          p_publication_id: "missing",
          p_section: { section: "bundleDistribution" },
          p_limit: 1,
          p_after: null,
        }),
        rpc(SUPABASE_V1_FUNCTION_NAMES.insightsPrune, {
          p_before_ms: Date.now(),
          p_max_items: 1,
          p_max_bytes: 1,
        }),
      ]);
      for (const result of results) {
        expect(result.data).toBeNull();
        expect(result.error?.code).toBe("42501");
      }
    }
  });
});
