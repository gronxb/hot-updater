import { readFile, readdir } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import type { BundleEventRow } from "@hot-updater/plugin-core";
import { getCanonicalInsightsJsonByteLength } from "@hot-updater/plugin-core/internal";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SUPABASE_V1_FUNCTION_NAMES } from "./supabaseInfrastructureNames";
import {
  createSupabaseInsights,
  createSupabaseInsightsMaintenance,
} from "./supabaseInsights";
import type { Database } from "./types";

const migrationsPath = "plugins/supabase/supabase/migrations";
const insightsMigrationPath = `${migrationsPath}/20260901030000_hot-updater_insights-scale.sql`;
const databaseNamespace = "00000000-0000-4000-8000-000000000001";
const bundleA = "00000000-0000-0000-0000-000000000001";
const bundleB = "00000000-0000-0000-0000-000000000002";
const eventId = (suffix: number) =>
  `018f0000-0000-7000-8000-${suffix.toString().padStart(12, "0")}`;

const event = (
  suffix: number,
  input: Partial<BundleEventRow> &
    Pick<BundleEventRow, "type" | "install_id" | "received_at_ms">,
): BundleEventRow =>
  ({
    id: eventId(suffix),
    user_id: null,
    username: null,
    from_release_id: null,
    from_bundle_id: input.type === "UNCHANGED" ? null : bundleB,
    to_release_id: null,
    to_bundle_id: bundleA,
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    cohort: "default",
    update_strategy: input.type === "UNCHANGED" ? null : "appVersion",
    fingerprint_hash: null,
    sdk_version: null,
    ...input,
  }) as BundleEventRow;

const prepareLegacy = async (database: PGlite, maxItems: number) => {
  const read = (
    await database.query<{ result: Record<string, unknown> }>(
      "select public.hot_updater_v1_insights_prepare_read($1,$2) result",
      [databaseNamespace, maxItems],
    )
  ).rows[0]!.result;
  if (read.state !== "preparing") return read;
  const batch = (read.batch as Record<string, unknown>[]).map((row) => ({
    id: row.id,
    ...(row.oversized === true
      ? { invalid: true }
      : {
          eventBytes: getCanonicalInsightsJsonByteLength(row.event),
        }),
    aliases:
      row.oversized === true
        ? []
        : [
            {
              kind: "installationId",
              original: row.installId,
              normalized: String(row.installId).toLowerCase(),
            },
            ...(row.userId === null
              ? []
              : [
                  {
                    kind: "userId",
                    original: row.userId,
                    normalized: String(row.userId).toLowerCase(),
                  },
                ]),
            ...(row.username === null
              ? []
              : [
                  {
                    kind: "username",
                    original: row.username,
                    normalized: String(row.username).toLowerCase(),
                  },
                ]),
          ],
  }));
  return (
    await database.query<{ result: Record<string, unknown> }>(
      "select public.hot_updater_v1_insights_prepare($1,$2,$3::jsonb,$4) result",
      [
        databaseNamespace,
        maxItems,
        JSON.stringify(batch),
        getCanonicalInsightsJsonByteLength(batch),
      ],
    )
  ).rows[0]!.result;
};

const pgliteRpc =
  (database: PGlite) => async (name: string, args: Record<string, unknown>) => {
    try {
      switch (name) {
        case SUPABASE_V1_FUNCTION_NAMES.insightsPrepareRead:
          return {
            data: (
              await database.query<{ result: Record<string, unknown> }>(
                `select public.${name}($1,$2) result`,
                [args.p_database_namespace, args.p_max_items],
              )
            ).rows[0]!.result,
            error: null,
          };
        case SUPABASE_V1_FUNCTION_NAMES.insightsPrepare:
          return {
            data: (
              await database.query<{ result: Record<string, unknown> }>(
                `select public.${name}($1,$2,$3::jsonb,$4) result`,
                [
                  args.p_database_namespace,
                  args.p_max_items,
                  JSON.stringify(args.p_batch),
                  args.p_batch_bytes,
                ],
              )
            ).rows[0]!.result,
            error: null,
          };
        case SUPABASE_V1_FUNCTION_NAMES.insightsAppend:
          await database.query(
            `select public.${name}($1,$2::jsonb,$3,$4,$5,$6::jsonb)`,
            [
              args.p_database_namespace,
              JSON.stringify(args.p_event),
              args.p_event_bytes,
              args.p_install_key,
              args.p_cohort_order,
              JSON.stringify(args.p_aliases),
            ],
          );
          return { data: null, error: null };
        case SUPABASE_V1_FUNCTION_NAMES.insightsEventPage:
          return {
            data: (
              await database.query<{ result: Record<string, unknown> }>(
                `select public.${name}($1,$2,$3,$4,$5,$6,$7,$8) result`,
                [
                  args.p_database_namespace,
                  args.p_scope,
                  args.p_scope_id,
                  args.p_before_received_at_ms,
                  args.p_since_received_at_ms,
                  args.p_limit,
                  args.p_cursor_received_at_ms,
                  args.p_cursor_id,
                ],
              )
            ).rows[0]!.result,
            error: null,
          };
        case SUPABASE_V1_FUNCTION_NAMES.insightsInstallationPage:
          return {
            data: (
              await database.query<{ result: Record<string, unknown> }>(
                `select public.${name}($1,$2::jsonb,$3,$4,$5,$6,$7,$8) result`,
                [
                  args.p_database_namespace,
                  JSON.stringify(args.p_selector),
                  args.p_limit,
                  args.p_after_key,
                  args.p_after_ordinal,
                  args.p_publication_id,
                  args.p_min_as_of_ms,
                  args.p_now_ms,
                ],
              )
            ).rows[0]!.result,
            error: null,
          };
        case SUPABASE_V1_FUNCTION_NAMES.insightsSearchStep:
          return {
            data: (
              await database.query<{ result: Record<string, unknown> }>(
                `select public.${name}($1,$2,$3,$4) result`,
                [
                  args.p_database_namespace,
                  args.p_job_id,
                  args.p_max_items,
                  args.p_max_bytes,
                ],
              )
            ).rows[0]!.result,
            error: null,
          };
        case SUPABASE_V1_FUNCTION_NAMES.insightsReport:
          return {
            data: (
              await database.query<{ result: Record<string, unknown> }>(
                `select public.${name}($1,$2::jsonb,$3,$4) result`,
                [
                  args.p_database_namespace,
                  JSON.stringify(args.p_query),
                  args.p_min_as_of_ms,
                  args.p_now_ms,
                ],
              )
            ).rows[0]!.result,
            error: null,
          };
        case SUPABASE_V1_FUNCTION_NAMES.insightsReportStep:
          return {
            data: (
              await database.query<{ result: Record<string, unknown> }>(
                `select public.${name}($1,$2,$3,$4) result`,
                [
                  args.p_database_namespace,
                  args.p_job_id,
                  args.p_max_items,
                  args.p_max_bytes,
                ],
              )
            ).rows[0]!.result,
            error: null,
          };
        case SUPABASE_V1_FUNCTION_NAMES.insightsReportPage:
          return {
            data: (
              await database.query<{ result: Record<string, unknown> }>(
                `select public.${name}($1,$2,$3::jsonb,$4,$5::jsonb) result`,
                [
                  args.p_database_namespace,
                  args.p_publication_id,
                  JSON.stringify(args.p_section),
                  args.p_limit,
                  args.p_after === null ? null : JSON.stringify(args.p_after),
                ],
              )
            ).rows[0]!.result,
            error: null,
          };
        case SUPABASE_V1_FUNCTION_NAMES.insightsPrune:
          return {
            data: (
              await database.query<{ result: Record<string, unknown> }>(
                `select public.${name}($1,$2,$3,$4) result`,
                [
                  args.p_database_namespace,
                  args.p_before_ms,
                  args.p_max_items,
                  args.p_max_bytes,
                ],
              )
            ).rows[0]!.result,
            error: null,
          };
        default:
          throw new Error(`Unexpected RPC ${name}`);
      }
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
  };

describe("Supabase required Insights model", () => {
  let db: PGlite;
  let insights: ReturnType<typeof createSupabaseInsights>;
  let maintenance: ReturnType<typeof createSupabaseInsightsMaintenance>;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(
      "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
    );
    for (const file of (await readdir(migrationsPath))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      await db.exec(await readFile(`${migrationsPath}/${file}`, "utf8"));
    }
    const rpc = pgliteRpc(db);
    const client = { rpc: rpc as unknown as SupabaseClient<Database>["rpc"] };
    insights = createSupabaseInsights(client, databaseNamespace);
    maintenance = createSupabaseInsightsMaintenance(client, databaseNamespace);
  });

  afterEach(() => db.close());

  const finishSearch = async (jobId: string, maxItems = 4096) => {
    for (let step = 0; step < 256; step += 1) {
      const result = await maintenance.runJobStep(jobId, {
        maxItems,
        maxRequests: 1,
      });
      if (result.state === "complete") return result.publicationId;
      if (result.state === "failed") throw new Error("search job failed");
    }
    throw new Error("search job did not complete");
  };

  const finishReport = async (jobId: string, maxItems = 4096) => {
    for (let step = 0; step < 64; step += 1) {
      const result = await maintenance.runJobStep(jobId, {
        maxItems,
        maxRequests: 1,
      });
      if (result.state === "complete") return result.publicationId;
      if (result.state === "failed") throw new Error("report job failed");
    }
    throw new Error("report job did not complete");
  };

  it("smokes append, native pages, and stepped report RPCs after migration", async () => {
    const row = Object.assign(
      event(1, {
        type: "UPDATE_APPLIED",
        install_id: "smoke-install",
        from_bundle_id: bundleB,
        to_bundle_id: bundleA,
        received_at_ms: Date.now(),
      }),
      {
        extension: {
          trace: "preserved",
          small: 1e-7,
          large: 1e21,
          numericBoundary: {
            a: Array(700).fill(1e-7),
            b: Array(700).fill(1e-7),
            c: Array(700).fill(1e-7),
          },
        },
      },
    );
    await insights.append(row);

    const events = await insights.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: row.received_at_ms + 1,
      limit: 1,
    });
    expect(events.state === "ready" && events.data.data).toEqual([row]);

    const installations = await insights.pageInstallations({
      kind: "installationId",
      installId: row.install_id,
      limit: 1,
    });
    expect(
      installations.state === "ready" && installations.data.data[0]?.id,
    ).toBe(row.id);

    let search = await insights.pageInstallations({
      kind: "contains",
      query: "smoke",
      limit: 1,
    });
    expect(search.state).toBe("preparing");
    if (search.state !== "preparing") return;
    await finishSearch(search.job.id);
    search = await insights.pageInstallations({
      kind: "contains",
      query: "smoke",
      limit: 1,
    });
    expect(search.state).toBe("ready");

    const input = {
      query: { kind: "bundleDetail", bundleId: bundleA, window: "24h" },
    } as const;
    let report = await insights.getReport(input);
    expect(report.state).toBe("preparing");
    if (report.state !== "preparing") return;
    const higherReport = await insights.getReport({
      ...input,
      minAsOfMs: Date.now() + 60_000,
    });
    expect(higherReport).toMatchObject({
      state: "preparing",
      job: { id: report.job.id },
    });
    await finishReport(report.job.id);
    report = await insights.getReport(input);
    expect(report.state).toBe("ready");
    if (report.state !== "ready") return;
    const section = await insights.pageReport({
      publicationId: report.data.id,
      section: "movementSeries",
      metric: "installed",
      limit: 1,
    });
    expect(section.state).toBe("ready");
  });

  it("rejects alias and report digest collisions instead of silently merging", async () => {
    const first = event(20, {
      type: "UPDATE_APPLIED",
      install_id: "digest-collision-install",
      from_bundle_id: bundleB,
      to_bundle_id: bundleA,
      received_at_ms: Date.now(),
    });
    await insights.append(first);
    await db.exec(`
      UPDATE public.hot_updater_v1_insights_aliases
      SET original_alias='different-full-alias'
      WHERE alias_kind='installationId';
    `);
    let appendFailure: unknown;
    try {
      await insights.append(
        event(21, {
          ...first,
          id: eventId(21),
          received_at_ms: first.received_at_ms + 1,
        }),
      );
    } catch (error) {
      appendFailure = error;
    }
    expect(
      Reflect.get(Reflect.get(appendFailure as object, "cause"), "message"),
    ).toContain("INSIGHTS_STORAGE_CORRUPTION");

    await db.exec(`
      UPDATE public.hot_updater_v1_insights_aliases
      SET original_alias='digest-collision-install'
      WHERE alias_kind='installationId';
    `);
    const preparing = await insights.getReport({
      query: { kind: "bundleDetail", bundleId: bundleA, window: "all" },
    });
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    await maintenance.runJobStep(preparing.job.id, {
      maxItems: 1,
      maxRequests: 1,
    });
    await db.query(
      `DELETE FROM public.hot_updater_v1_insights_report_counts AS counter
       USING public.hot_updater_v1_insights_report_members AS member
       WHERE member.job_id=$1 AND counter.job_id=member.job_id
         AND counter.dimension=member.dimension
         AND counter.discriminator=member.discriminator
         AND counter.group_digest=member.group_digest`,
      [preparing.job.id],
    );
    await expect(
      db.query(
        `SELECT public.hot_updater_v1_insights_report_add_member(
           member.job_id,member.dimension,member.discriminator,
           member.group_key,null,null,null,null,member.install_key
         )
         FROM public.hot_updater_v1_insights_report_members AS member
         WHERE member.job_id=$1 LIMIT 1`,
        [preparing.job.id],
      ),
    ).rejects.toThrow("INSIGHTS_STORAGE_CORRUPTION");
  });

  it("binds writer fencing and retained event integrity to operation readiness", async () => {
    const row = event(22, {
      type: "UPDATE_APPLIED",
      install_id: "retained-integrity",
      from_bundle_id: bundleB,
      to_bundle_id: bundleA,
      received_at_ms: Date.now(),
    });
    await insights.append(row);
    await db.query(
      `UPDATE public.hot_updater_v1_bundle_events
       SET insights_event=jsonb_set(insights_event,'{install_id}',
         '"different-install"'::jsonb)
       WHERE id=$1`,
      [row.id],
    );
    await expect(
      insights.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: row.received_at_ms + 1,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });

    await db.exec(`
      ALTER TABLE public.hot_updater_v1_bundle_events
        DISABLE TRIGGER hot_updater_v1_insights_fence_unsequenced_insert;
    `);
    const readiness = await db.query<{
      append: boolean;
      event: boolean;
      report: boolean;
    }>(`
      SELECT public.hot_updater_v1_insights_layout_ready('append') append,
        public.hot_updater_v1_insights_layout_ready('event') event,
        public.hot_updater_v1_insights_layout_ready('report') report
    `);
    expect(readiness.rows[0]).toEqual({
      append: false,
      event: false,
      report: false,
    });
    await expect(
      db.query(
        `SELECT public.hot_updater_v1_commit(
          '{"changes":[{"model":"insights","operation":"insert","row":{}}]}'::jsonb
        )`,
      ),
    ).rejects.toThrow("Insights events require the append RPC");
  });

  it("rejects reflected and malformed installation cursors before storage I/O", async () => {
    const namespace = databaseNamespace;
    let requests = 0;
    const model = createSupabaseInsights(
      {
        rpc: (async () => {
          requests += 1;
          throw new Error("storage I/O was reached");
        }) as unknown as SupabaseClient<Database>["rpc"],
      },
      namespace,
    );
    const cursor = (
      selector: Record<string, unknown>,
      publicationId: string | null,
      afterKey: string,
    ) =>
      JSON.stringify([
        1,
        namespace,
        "installations",
        "sha256-json-string-v1",
        selector,
        publicationId,
        afterKey,
      ]);

    await expect(
      Reflect.apply(model.pageInstallations, model, [
        {
          kind: "installationId",
          installId: "cursor-install",
          limit: 1,
          cursor: cursor(
            { kind: "installationId", installId: "cursor-install" },
            null,
            "0".repeat(64),
          ),
        },
      ]),
    ).rejects.toThrow();
    await expect(
      model.pageInstallations({
        kind: "all",
        limit: 1,
        cursor: cursor({ kind: "all" }, "unexpected-publication", "x"),
      }),
    ).rejects.toThrow();
    await expect(
      model.pageInstallations({
        kind: "contains",
        query: "cursor",
        limit: 1,
        cursor: cursor(
          { kind: "contains", query: "cursor" },
          "p".repeat(129),
          "0".repeat(64),
        ),
      }),
    ).rejects.toThrow();
    expect(requests).toBe(0);
  });

  it("prunes an expired publication through bounded maintenance", async () => {
    await insights.append(
      event(5, {
        type: "UNCHANGED",
        install_id: "retention-install",
        received_at_ms: 5,
      }),
    );
    const input = {
      kind: "contains" as const,
      query: "retention",
      limit: 1,
    };
    const preparing = await insights.pageInstallations(input);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    const publicationId = await finishSearch(preparing.job.id, 1);
    const retentionJob = `supabase-v2-retention:${Date.now() + 10_000}`;
    const first = await maintenance.runJobStep(retentionJob, {
      maxItems: 1,
      maxRequests: 1,
    });
    expect(first).toMatchObject({
      state: "running",
      usage: { requests: 1 },
    });
    await expect(
      insights.pageInstallations({ ...input, publicationId }),
    ).resolves.toEqual({ state: "expired", publicationId });
    expect(
      (
        await db.query<{ remaining: number }>(
          `
          select (
            (select count(*) from public.hot_updater_v1_insights_search_members
             where job_id=$1) +
            (select count(*) from public.hot_updater_v1_insights_search_results
             where job_id=$1)
          )::integer remaining
        `,
          [publicationId],
        )
      ).rows[0]!.remaining,
    ).toBeGreaterThan(0);
    let completed = false;
    for (let step = 0; step < 16; step += 1) {
      const result = await maintenance.runJobStep(retentionJob, {
        maxItems: 1,
        maxRequests: 1,
      });
      expect(result.usage.items).toBeLessThanOrEqual(1);
      expect(result.usage.requests).toBe(1);
      if (result.state === "complete") {
        completed = true;
        break;
      }
      expect(result.state).toBe("running");
    }
    expect(completed).toBe(true);
    await expect(
      insights.pageInstallations({ ...input, publicationId }),
    ).resolves.toEqual({ state: "expired", publicationId });
  });

  it("fails operation readiness after a retained layout column changes", async () => {
    for (const [operation, mutation] of [
      [
        "installation",
        "drop index public.hot_updater_v1_insights_search_jobs_state_lookup_idx",
      ],
      [
        "report",
        "drop index public.hot_updater_v1_insights_report_counts_rank_idx",
      ],
      [
        "report",
        `alter table public.hot_updater_v1_insights_report_bundle_order
         drop constraint hot_updater_v1_insights_report_bundle_order_bundle_key`,
      ],
    ] as const) {
      await db.exec("begin");
      await db.exec(mutation);
      expect(
        (
          await db.query<{ ready: boolean }>(
            `select coalesce(
               public.hot_updater_v1_insights_layout_ready($1),false
             ) ready`,
            [operation],
          )
        ).rows[0]!.ready,
      ).toBe(false);
      await db.exec("rollback");
    }
    await db.exec(
      `alter table public.hot_updater_v1_insights_search_jobs
       drop column error`,
    );
    await expect(
      insights.pageInstallations({
        kind: "contains",
        query: "layout",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-not-ready" },
    });
  });

  it("rejects missing rows and totals in immutable publications", async () => {
    const now = Date.now();
    await insights.append(
      event(6, {
        type: "UPDATE_APPLIED",
        install_id: "publication-integrity",
        from_bundle_id: bundleB,
        to_bundle_id: bundleA,
        received_at_ms: now - 1,
      }),
    );
    const searchInput = {
      kind: "contains" as const,
      query: "publication-integrity",
      limit: 1,
    };
    const searchPreparing = await insights.pageInstallations(searchInput);
    expect(searchPreparing.state).toBe("preparing");
    if (searchPreparing.state !== "preparing") return;
    const searchPublication = await finishSearch(searchPreparing.job.id);
    const mutatedSearch = await db.query(
      `update public.hot_updater_v1_insights_search_results
       set install_id='publication-integrity-mutated'
       where job_id=$1 and ordinal=0 returning ordinal`,
      [searchPublication],
    );
    expect(mutatedSearch.rows).toHaveLength(1);
    await expect(
      insights.pageInstallations({
        ...searchInput,
        publicationId: searchPublication,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });

    const detailInput = {
      query: {
        kind: "bundleDetail" as const,
        bundleId: bundleA,
        window: "all" as const,
      },
    };
    const detailPreparing = await insights.getReport(detailInput);
    expect(detailPreparing.state).toBe("preparing");
    if (detailPreparing.state !== "preparing") return;
    const detailPublication = await finishReport(detailPreparing.job.id);
    const deletedInstalled = await db.query<{ ordinal: number }>(
      `delete from public.hot_updater_v1_insights_report_rows
       where ctid in (
         select ctid from public.hot_updater_v1_insights_report_rows
         where publication_id=$1 and section='movementSeries'
           and discriminator='installed'
         order by ordinal limit 1
       ) returning ordinal`,
      [detailPublication],
    );
    expect(deletedInstalled.rows).toHaveLength(1);
    const deletedRecoveredTotal = await db.query(
      `delete from public.hot_updater_v1_insights_report_totals
       where publication_id=$1 and section='movementSeries'
         and discriminator='recovered' returning total`,
      [detailPublication],
    );
    expect(deletedRecoveredTotal.rows).toHaveLength(1);
    for (const metric of ["installed", "recovered"] as const) {
      await expect(
        insights.pageReport({
          publicationId: detailPublication,
          section: "movementSeries",
          metric,
          limit: 10,
        }),
      ).resolves.toMatchObject({
        state: "failed",
        error: { code: "storage-corruption" },
      });
    }

    const activeInput = {
      query: { kind: "activeOverview" as const, window: "24h" as const },
    };
    const activePreparing = await insights.getReport(activeInput);
    expect(activePreparing.state).toBe("preparing");
    if (activePreparing.state !== "preparing") return;
    const activePublication = await finishReport(activePreparing.job.id);
    const firstActive = await insights.pageReport({
      publicationId: activePublication,
      section: "activeSeries",
      limit: 1,
    });
    expect(firstActive.state).toBe("ready");
    if (firstActive.state !== "ready" || firstActive.data.nextCursor === null)
      return;
    const forgedActiveCursor = JSON.parse(firstActive.data.nextCursor);
    forgedActiveCursor[2] = "999";
    await expect(
      insights.pageReport({
        publicationId: activePublication,
        section: "activeSeries",
        limit: 1,
        cursor: JSON.stringify(forgedActiveCursor),
      }),
    ).rejects.toThrow("invalid-query");
    const activeCursorOrdinal = JSON.parse(firstActive.data.nextCursor)[2];
    await db.query(
      `delete from public.hot_updater_v1_insights_report_rows
       where publication_id=$1 and section='activeSeries'
         and ordinal=$2::bigint`,
      [activePublication, activeCursorOrdinal],
    );
    await expect(
      insights.pageReport({
        publicationId: activePublication,
        section: "activeSeries",
        limit: 1,
        cursor: firstActive.data.nextCursor,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    const absent = await insights.pageReport({
      publicationId: activePublication,
      section: "activeBundleSeries",
      bundleId: "00000000-0000-0000-0000-000000000099",
      limit: 10,
    });
    expect(absent).toMatchObject({
      state: "ready",
      data: { data: [], hasNext: false, total: { state: "exact", value: 0 } },
    });
    await db.query(
      `update public.hot_updater_v1_insights_report_totals
       set total=0
       where publication_id=$1 and section='activeSeries'`,
      [activePublication],
    );
    await expect(
      insights.pageReport({
        publicationId: activePublication,
        section: "activeSeries",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
    await db.query(
      `delete from public.hot_updater_v1_insights_report_bundle_order
       where job_id=$1 and bundle_id=$2`,
      [activePublication, bundleA],
    );
    await expect(
      insights.pageReport({
        publicationId: activePublication,
        section: "activeBundleSeries",
        bundleId: bundleA,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
  });

  it("distinguishes manipulated and deleted search bookmarks", async () => {
    for (const [suffix, installId] of [
      [61, "bookmark-search-a"],
      [62, "bookmark-search-b"],
    ] as const) {
      await insights.append(
        event(suffix, {
          type: "UNCHANGED",
          install_id: installId,
          received_at_ms: suffix,
        }),
      );
    }
    const input = {
      kind: "contains" as const,
      query: "bookmark-search",
      limit: 1,
    };
    const preparing = await insights.pageInstallations(input);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    const publicationId = await finishSearch(preparing.job.id);
    const first = await insights.pageInstallations({ ...input, publicationId });
    expect(first.state).toBe("ready");
    if (first.state !== "ready" || first.data.nextCursor === null) return;
    const original = JSON.parse(first.data.nextCursor);
    const forgedDigest = [...original];
    forgedDigest[6] = "0".repeat(64);
    await expect(
      insights.pageInstallations({
        ...input,
        publicationId,
        cursor: JSON.stringify(forgedDigest),
      }),
    ).rejects.toThrow("invalid-query");
    const forgedOrdinal = [...original];
    forgedOrdinal[7] = "999";
    await expect(
      insights.pageInstallations({
        ...input,
        publicationId,
        cursor: JSON.stringify(forgedOrdinal),
      }),
    ).rejects.toThrow("invalid-query");
    await db.query(
      `delete from public.hot_updater_v1_insights_search_results
       where job_id=$1 and ordinal=$2::bigint`,
      [publicationId, original[7]],
    );
    await expect(
      insights.pageInstallations({
        ...input,
        publicationId,
        cursor: first.data.nextCursor,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
  });

  it("drains a stale search publication while a fresher job prepares", async () => {
    for (const [suffix, installId] of [
      [71, "stale-search-a"],
      [72, "stale-search-b"],
    ] as const) {
      await insights.append(
        event(suffix, {
          type: "UNCHANGED",
          install_id: installId,
          received_at_ms: suffix,
        }),
      );
    }
    const rpc = pgliteRpc(db) as unknown as SupabaseClient<Database>["rpc"];
    const oldModel = createSupabaseInsights(
      { rpc },
      databaseNamespace,
      () => 1_000,
    );
    const base = {
      kind: "contains" as const,
      query: "stale-search",
      limit: 1,
    };
    const preparing = await oldModel.pageInstallations(base);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    const publicationId = await finishSearch(preparing.job.id);
    const freshModel = createSupabaseInsights(
      { rpc },
      databaseNamespace,
      () => 2_000,
    );
    const first = await freshModel.pageInstallations({
      ...base,
      minAsOfMs: 1_500,
    });
    expect(first.state).toBe("stale");
    if (first.state !== "stale" || first.data.nextCursor === null) return;
    expect(first.data.consistency.cutoff.publication.id).toBe(publicationId);
    const second = await freshModel.pageInstallations({
      ...base,
      minAsOfMs: 1_500,
      cursor: first.data.nextCursor,
    });
    expect(second.state).toBe("ready");
    if (second.state !== "ready") return;
    expect(second.data.consistency.cutoff.publication.id).toBe(publicationId);
    expect(
      [
        ...first.data.data.map((row) => row.install_id),
        ...second.data.data.map((row) => row.install_id),
      ].sort(),
    ).toEqual(["stale-search-a", "stale-search-b"]);
    await expect(
      freshModel.pageInstallations({
        ...base,
        minAsOfMs: 1_500,
        publicationId,
      }),
    ).resolves.toEqual({ state: "expired", publicationId });
  });

  it("surfaces an exact-install identity mismatch as typed storage corruption", async () => {
    const row = event(2, {
      type: "UNCHANGED",
      install_id: "collision-request",
      received_at_ms: 2,
    });
    await insights.append(row);
    await db.query(
      `update public.hot_updater_v1_insights_live_installations
       set install_id='collision-other',
         event=jsonb_set(event,'{install_id}',to_jsonb('collision-other'::text))
       where install_key=sha256(convert_to(to_jsonb($1::text)::text,'utf8'))`,
      [row.install_id],
    );
    await expect(
      insights.pageInstallations({
        kind: "installationId",
        installId: row.install_id,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "storage-corruption" },
    });
  });

  it("preserves JavaScript lowercase expansion for a valid maximum alias", async () => {
    const installId = "İ".repeat(1024);
    await insights.append(
      event(3, {
        type: "UNCHANGED",
        install_id: installId,
        received_at_ms: 3,
      }),
    );
    const input = {
      kind: "contains" as const,
      query: installId,
      limit: 1,
    };
    let result = await insights.pageInstallations(input);
    expect(result.state).toBe("preparing");
    if (result.state !== "preparing") return;
    await finishSearch(result.job.id);
    result = await insights.pageInstallations(input);
    expect(result.state === "ready" && result.data.data[0]?.install_id).toBe(
      installId,
    );
  });

  it("durably fails a report when retained event JSON disagrees with its raw tuple", async () => {
    const fixed = createSupabaseInsights(
      {
        rpc: pgliteRpc(db) as unknown as SupabaseClient<Database>["rpc"],
      },
      databaseNamespace,
      () => 1_000,
    );
    await insights.append(
      event(3, {
        type: "UPDATE_APPLIED",
        install_id: "partial-report-before-corruption",
        from_bundle_id: bundleA,
        to_bundle_id: bundleB,
        received_at_ms: 3,
      }),
    );
    const row = event(4, {
      type: "UPDATE_APPLIED",
      install_id: "corrupt-report",
      from_bundle_id: bundleA,
      to_bundle_id: bundleB,
      received_at_ms: 4,
    });
    await insights.append(row);
    const input = {
      query: {
        kind: "bundleDetail" as const,
        bundleId: bundleB,
        window: "all" as const,
      },
    };
    const preparing = await fixed.getReport(input);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    await expect(
      maintenance.runJobStep(preparing.job.id, {
        maxItems: 1,
        maxRequests: 1,
      }),
    ).resolves.toMatchObject({ state: "running", usage: { items: 1 } });
    await db.query(
      `update public.hot_updater_v1_bundle_events
       set insights_event=jsonb_set(insights_event,'{received_at_ms}','5'::jsonb)
       where id=$1`,
      [row.id],
    );
    await expect(
      maintenance.runJobStep(preparing.job.id, {
        maxItems: 4096,
        maxRequests: 1,
      }),
    ).resolves.toMatchObject({ state: "failed", jobId: preparing.job.id });
    await expect(fixed.getReport(input)).resolves.toMatchObject({
      state: "failed",
      error: { code: "migration-poison", jobId: preparing.job.id },
    });
    await expect(
      maintenance.runJobStep(`supabase-v2-retention:${Date.now() + 10_000}`, {
        maxItems: 1,
        maxRequests: 1,
      }),
    ).resolves.toMatchObject({ state: "running" });
    expect(
      (
        await db.query<{ count: number }>(
          `select count(*)::integer count
           from public.hot_updater_v1_insights_publications where id=$1`,
          [preparing.job.id],
        )
      ).rows[0]!.count,
    ).toBe(1);
    const replacement = await fixed.getReport(input);
    expect(replacement).toMatchObject({ state: "preparing" });
    expect(replacement.state === "preparing" && replacement.job.id).not.toBe(
      preparing.job.id,
    );
  });

  it("does not reuse a failed search after retention tombstones it", async () => {
    const fixed = createSupabaseInsights(
      {
        rpc: pgliteRpc(db) as unknown as SupabaseClient<Database>["rpc"],
      },
      databaseNamespace,
      () => 1_000,
    );
    await insights.append(
      event(45, {
        type: "UNCHANGED",
        install_id: "failed-search-retention",
        received_at_ms: 45,
      }),
    );
    const input = {
      kind: "contains" as const,
      query: "failed-search-retention",
      limit: 1,
    };
    const preparing = await fixed.pageInstallations(input);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    expect(
      (
        await maintenance.runJobStep(preparing.job.id, {
          maxItems: 4096,
          maxRequests: 1,
        })
      ).state,
    ).toBe("running");
    await db.query(
      `delete from public.hot_updater_v1_insights_installation_versions
       where install_key=(
         select install_key
         from public.hot_updater_v1_insights_search_members
         where job_id=$1 order by install_key limit 1
       )`,
      [preparing.job.id],
    );
    await expect(
      maintenance.runJobStep(preparing.job.id, {
        maxItems: 4096,
        maxRequests: 1,
      }),
    ).resolves.toMatchObject({ state: "failed" });
    await expect(
      maintenance.runJobStep(`supabase-v2-retention:${Date.now() + 10_000}`, {
        maxItems: 1,
        maxRequests: 1,
      }),
    ).resolves.toMatchObject({ state: "running" });
    const replacement = await fixed.pageInstallations(input);
    expect(replacement).toMatchObject({ state: "preparing" });
    expect(replacement.state === "preparing" && replacement.job.id).not.toBe(
      preparing.job.id,
    );
  });

  it("bounds search-result maintenance input before publication", async () => {
    await db.exec(`
      INSERT INTO public.hot_updater_v1_bundle_events (
        id,type,install_id,user_id,username,to_bundle_id,platform,app_version,
        channel,cohort,sdk_version,received_at_ms,insights_source_seq,
        insights_install_key,insights_cohort_order
      )
      SELECT ('018f0003-0000-7000-8000-' || lpad(n::text,12,'0'))::uuid,
        'UNCHANGED','bounded-' || lpad(n::text,4,'0'),repeat('u',1000),
        repeat('n',1000),'${bundleA}','ios',repeat('a',1000),repeat('c',1000),
        repeat('x',1000),repeat('s',1000),n,n,
        sha256(convert_to(to_jsonb(
          'bounded-' || lpad(n::text,4,'0')
        )::text,'utf8')),decode(repeat('0078',1000),'hex')
      FROM generate_series(1,800) n;
      UPDATE public.hot_updater_v1_bundle_events AS event
      SET insights_event_bytes=octet_length(
        public.hot_updater_v1_insights_canonical_json(
          public.hot_updater_v1_insights_event_json(event)
        )
      );
      INSERT INTO public.hot_updater_v1_insights_live_installations (
        install_key,install_id,event_id,received_at_ms,source_seq,event
      )
      SELECT insights_install_key,install_id,id,received_at_ms,
        insights_source_seq,to_jsonb(event) - 'insights_event' -
          'insights_event_bytes' - 'insights_source_seq' -
          'insights_install_key' - 'insights_cohort_order'
      FROM public.hot_updater_v1_bundle_events event;
      INSERT INTO public.hot_updater_v1_insights_installation_versions (
        install_key,source_seq,event_id
      )
      SELECT install_key,source_seq,event_id
      FROM public.hot_updater_v1_insights_live_installations;
      INSERT INTO public.hot_updater_v1_insights_aliases (
        source_seq,install_key,install_id,alias_kind,alias_key,original_alias,
        normalized_alias
      )
      SELECT insights_source_seq,insights_install_key,install_id,
        'installationId',sha256(convert_to(to_jsonb(install_id)::text,'utf8')),
        install_id,install_id
      FROM public.hot_updater_v1_bundle_events;
      UPDATE public.hot_updater_v1_insights_source_state
      SET committed_seq=800 WHERE id=1;
    `);

    const input = { kind: "contains" as const, query: "bounded", limit: 1 };
    const preparing = await insights.pageInstallations(input);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    await maintenance.runJobStep(preparing.job.id, {
      maxItems: 800,
      maxRequests: 1,
    });
    const partial = await maintenance.runJobStep(preparing.job.id, {
      maxItems: 800,
      maxRequests: 1,
    });
    expect(partial.state).toBe("running");
    const staged = (
      await db.query<{ rows: number; bytes: number }>(`
        select count(*)::integer rows,
          sum(octet_length(public.hot_updater_v1_insights_canonical_json(
            public.hot_updater_v1_insights_installation_row(event)
          )) + 160)::integer bytes
        from public.hot_updater_v1_insights_search_results
      `)
    ).rows[0]!;
    expect(staged.rows).toBeGreaterThan(0);
    expect(staged.rows).toBeLessThan(800);
    expect(staged.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    await finishSearch(preparing.job.id, 800);
    const ready = await insights.pageInstallations(input);
    expect(ready.state).toBe("ready");
    if (ready.state !== "ready") return;
    expect(ready.data.total).toEqual(
      expect.objectContaining({ state: "exact", value: 800 }),
    );
  }, 120_000);

  it("freezes search input, fences leases, and rolls back failed publication", async () => {
    await db.exec(`
      INSERT INTO public.hot_updater_v1_bundle_events (
        id,type,install_id,to_bundle_id,platform,app_version,channel,cohort,
        received_at_ms,insights_source_seq,insights_install_key,
        insights_cohort_order
      ) SELECT ('018f0002-0000-7000-8000-' || lpad(n::text,12,'0'))::uuid,
        'UNCHANGED','search-' || lpad(n::text,6,'0'),'${bundleA}',
        'ios','1.0.0','production','default',n,n,
        sha256(convert_to(to_jsonb('search-' || lpad(n::text,6,'0'))::text,'utf8')),
        decode('00640065006600610075006c0074','hex')
      FROM generate_series(1,32) n;
      UPDATE public.hot_updater_v1_bundle_events AS event
      SET insights_event_bytes=octet_length(
        public.hot_updater_v1_insights_canonical_json(
          public.hot_updater_v1_insights_event_json(event)
        )
      );
      INSERT INTO public.hot_updater_v1_insights_live_installations (
        install_key,install_id,event_id,received_at_ms,source_seq,event
      ) SELECT insights_install_key,install_id,id,received_at_ms,
        insights_source_seq,public.hot_updater_v1_insights_event_json(event)
      FROM public.hot_updater_v1_bundle_events event;
      INSERT INTO public.hot_updater_v1_insights_installation_versions (
        install_key,source_seq,event_id
      ) SELECT install_key,source_seq,event_id
      FROM public.hot_updater_v1_insights_live_installations;
      INSERT INTO public.hot_updater_v1_insights_aliases (
        source_seq,install_key,install_id,alias_kind,alias_key,original_alias,
        normalized_alias
      ) SELECT insights_source_seq,insights_install_key,install_id,
        'installationId',sha256(convert_to(to_jsonb(
          'Target-' || install_id
        )::text,'utf8')),'Target-' || install_id,'target-' || install_id
      FROM public.hot_updater_v1_bundle_events;
      UPDATE public.hot_updater_v1_insights_source_state
      SET committed_seq=32 WHERE id=1;
    `);

    const query = { kind: "contains" as const, query: "target", limit: 1 };
    const preparing = await insights.pageInstallations(query);
    expect(preparing.state).toBe("preparing");
    if (preparing.state !== "preparing") return;
    const higher = await insights.pageInstallations({
      ...query,
      minAsOfMs: Date.now() + 60_000,
    });
    expect(higher).toMatchObject({
      state: "preparing",
      job: { id: preparing.job.id },
    });
    expect(
      (
        await db.query<{ count: number }>(
          `select count(*)::integer count
           from public.hot_updater_v1_insights_search_jobs
           where state='preparing'`,
        )
      ).rows[0]!.count,
    ).toBe(1);
    await insights.append(
      event(9500, {
        type: "UNCHANGED",
        install_id: "Target-new-after-capture",
        received_at_ms: 100,
      }),
    );
    expect(
      (
        await db.query<{
          source_seq: number;
          alias_upper_id: number;
          latest_alias_id: number;
        }>(
          `select job.source_seq,job.alias_upper_id,
             max(alias.id)::integer latest_alias_id
           from public.hot_updater_v1_insights_search_jobs job
           cross join public.hot_updater_v1_insights_aliases alias
           where job.id=$1 group by job.source_seq,job.alias_upper_id`,
          [preparing.job.id],
        )
      ).rows[0],
    ).toEqual({ source_seq: 32, alias_upper_id: 32, latest_alias_id: 33 });

    const owner = "00000000-0000-4000-8000-000000000099";
    await db.query(
      `update public.hot_updater_v1_insights_search_jobs
       set lease_owner=$2::uuid,lease_epoch=7,
         lease_expires_at_ms=extract(epoch from statement_timestamp())*1000+60000
       where id=$1`,
      [preparing.job.id, owner],
    );
    const leaseCurrent = async (epoch: number) =>
      (
        await db.query<{ current: boolean }>(
          `select public.hot_updater_v1_insights_search_lease_current(
             $1,$2::uuid,$3
           ) current`,
          [preparing.job.id, owner, epoch],
        )
      ).rows[0]!.current;
    expect(await leaseCurrent(7)).toBe(true);
    await db.query(
      `update public.hot_updater_v1_insights_search_jobs
       set lease_epoch=8,lease_expires_at_ms=0 where id=$1`,
      [preparing.job.id],
    );
    expect(await leaseCurrent(7)).toBe(false);

    await db.exec(`
      CREATE FUNCTION public.fail_search_publication() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE TRIGGER fail_search_publication
      BEFORE INSERT ON public.hot_updater_v1_insights_search_results
      FOR EACH ROW EXECUTE FUNCTION public.fail_search_publication();
    `);
    const aliasStep = await maintenance.runJobStep(preparing.job.id, {
      maxItems: 4096,
      maxRequests: 1,
    });
    expect(aliasStep.state).toBe("running");
    await expect(
      maintenance.runJobStep(preparing.job.id, {
        maxItems: 4096,
        maxRequests: 1,
      }),
    ).rejects.toThrow();
    expect(
      (
        await db.query<{ results: number; state: string }>(
          `select count(result.*)::integer results,max(job.state) state
           from public.hot_updater_v1_insights_search_jobs job
           left join public.hot_updater_v1_insights_search_results result
             on result.job_id=job.id where job.id=$1`,
          [preparing.job.id],
        )
      ).rows[0],
    ).toEqual({ results: 0, state: "preparing" });
    await db.exec(`
      DROP TRIGGER fail_search_publication
        ON public.hot_updater_v1_insights_search_results;
      DROP FUNCTION public.fail_search_publication();
    `);
    await finishSearch(preparing.job.id);
    const ready = await insights.pageInstallations(query);
    expect(ready.state === "ready" && ready.data.total).toMatchObject({
      state: "exact",
      value: 32,
    });

    const brokenInput = {
      kind: "contains" as const,
      query: "search-",
      limit: 1,
    };
    const broken = await insights.pageInstallations(brokenInput);
    expect(broken.state).toBe("preparing");
    if (broken.state !== "preparing") return;
    expect(
      (
        await maintenance.runJobStep(broken.job.id, {
          maxItems: 4096,
          maxRequests: 1,
        })
      ).state,
    ).toBe("running");
    await db.exec(`
      DELETE FROM public.hot_updater_v1_insights_installation_versions
      WHERE install_key=(
        SELECT install_key
        FROM public.hot_updater_v1_insights_search_members
        WHERE job_id='${broken.job.id}' ORDER BY install_key LIMIT 1
      )
    `);
    await expect(
      maintenance.runJobStep(broken.job.id, {
        maxItems: 4096,
        maxRequests: 1,
      }),
    ).resolves.toMatchObject({ state: "failed", jobId: broken.job.id });
    await expect(
      insights.pageInstallations(brokenInput),
    ).resolves.toMatchObject({
      state: "failed",
      error: { code: "migration-poison", jobId: broken.job.id },
    });
  });
});

describe("Supabase populated Insights migration", () => {
  it("poisons invalid extensions and resumes with canonical numeric extensions", async () => {
    const db = new PGlite();
    try {
      await db.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
      );
      await db.exec(
        await readFile(
          `${migrationsPath}/20260818000000_hot-updater_1.0.0.sql`,
          "utf8",
        ),
      );
      const legacy = event(970, {
        type: "UNCHANGED",
        install_id: "legacy-extension",
        received_at_ms: 1,
      });
      await db.query(
        `insert into public.hot_updater_v1_bundle_events
         select * from jsonb_populate_record(
           null::public.hot_updater_v1_bundle_events,$1::jsonb
         )`,
        [JSON.stringify(legacy)],
      );
      await db.exec(await readFile(insightsMigrationPath, "utf8"));
      await db.query(
        `update public.hot_updater_v1_bundle_events as event
         set insights_event=(
           to_jsonb(event) - 'insights_event' - 'insights_event_bytes' -
             'insights_source_seq' - 'insights_install_key' -
             'insights_cohort_order'
         ) || jsonb_build_object(
           'extension',jsonb_build_object('nested',repeat('x',1025))
         )
         where id=$1`,
        [legacy.id],
      );
      const rpc = pgliteRpc(db);
      const client = {
        rpc: rpc as unknown as SupabaseClient<Database>["rpc"],
      };
      const worker = createSupabaseInsightsMaintenance(
        client,
        databaseNamespace,
      );
      await expect(
        worker.runJobStep("supabase-v2-migration", {
          maxItems: 1,
          maxRequests: 2,
        }),
      ).resolves.toMatchObject({ state: "failed" });
      expect(
        (
          await db.query<{ poison: string; source_seq: number | null }>(
            `select source.poison,event.insights_source_seq::integer source_seq
             from public.hot_updater_v1_insights_source_state source
             cross join public.hot_updater_v1_bundle_events event
             where source.id=1 and event.id=$1`,
            [legacy.id],
          )
        ).rows[0],
      ).toEqual({ poison: `event:${legacy.id}`, source_seq: null });

      const extension = { nested: "valid", small: 1e-7, large: 1e21 };
      await db.query(
        `update public.hot_updater_v1_bundle_events
         set insights_event=jsonb_set(
           insights_event,'{extension}',$2::jsonb,false
         ) where id=$1`,
        [legacy.id, JSON.stringify(extension)],
      );
      await expect(
        createSupabaseInsightsMaintenance(client, databaseNamespace).runJobStep(
          "supabase-v2-migration",
          { maxItems: 1, maxRequests: 2 },
        ),
      ).resolves.toMatchObject({ state: "complete" });
      const model = createSupabaseInsights(client, databaseNamespace);
      const page = await model.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 2,
        limit: 1,
      });
      expect(page.state === "ready" && page.data.data[0]).toMatchObject({
        ...legacy,
        extension,
      });
    } finally {
      await db.close();
    }
  });

  it("preserves JS lowercase expansion, final sigma, and normalization forms for historical aliases", async () => {
    const db = new PGlite();
    try {
      await db.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
      );
      await db.exec(
        await readFile(
          `${migrationsPath}/20260818000000_hot-updater_1.0.0.sql`,
          "utf8",
        ),
      );
      const expanded = "İ".repeat(1024);
      const aliases = ["legacy-İ", "AΣ!", "café", "cafe\u0301", expanded];
      for (const [index, installId] of aliases.entries()) {
        await db.query(
          `insert into public.hot_updater_v1_bundle_events
           select * from jsonb_populate_record(
             null::public.hot_updater_v1_bundle_events,$1::jsonb
           )`,
          [
            JSON.stringify(
              event(930 + index, {
                type: "UNCHANGED",
                install_id: installId,
                received_at_ms: index + 1,
              }),
            ),
          ],
        );
      }
      await db.exec(await readFile(insightsMigrationPath, "utf8"));
      const rpc = pgliteRpc(db);
      const client = {
        rpc: rpc as unknown as SupabaseClient<Database>["rpc"],
      };
      const model = createSupabaseInsights(client, databaseNamespace);
      const worker = createSupabaseInsightsMaintenance(
        client,
        databaseNamespace,
      );
      await expect(
        worker.runJobStep("supabase-v2-migration", {
          maxItems: 1000,
          maxRequests: 2,
        }),
      ).resolves.toMatchObject({ state: "complete" });
      const search = async (query: string) => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const result = await model.pageInstallations({
            kind: "contains",
            query,
            limit: 10,
          });
          if (result.state === "ready") {
            return result.data.data.map(({ install_id }) => install_id);
          }
          expect(result.state).toBe("preparing");
          if (result.state !== "preparing") return [];
          for (let step = 0; step < 8; step += 1) {
            const progress = await worker.runJobStep(result.job.id, {
              maxItems: 4096,
              maxRequests: 1,
            });
            if (progress.state === "complete") break;
          }
        }
        throw new Error("Historical alias search did not become ready");
      };

      await expect(search("legacy-i\u0307")).resolves.toEqual(["legacy-İ"]);
      await expect(search("ς")).resolves.toEqual(["AΣ!"]);
      await expect(search("é")).resolves.toEqual(["café"]);
      await expect(search("e\u0301")).resolves.toEqual(["cafe\u0301"]);
      await expect(search("i\u0307".repeat(512))).resolves.toEqual([expanded]);
      expect(
        (
          await db.query<{ original_alias: string; normalized_alias: string }>(`
            select original_alias, normalized_alias
            from public.hot_updater_v1_insights_aliases
            where alias_kind = 'installationId'
            order by original_alias collate "C"
          `)
        ).rows,
      ).toEqual(
        [...aliases].sort().map((original_alias) => ({
          original_alias,
          normalized_alias: original_alias.toLowerCase(),
        })),
      );
    } finally {
      await db.close();
    }
  });

  it("persists poison readiness without changing the raw event", async () => {
    const db = new PGlite();
    try {
      await db.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
      );
      for (const file of ["20260818000000_hot-updater_1.0.0.sql"]) {
        await db.exec(await readFile(`${migrationsPath}/${file}`, "utf8"));
      }
      await db.exec(`
        INSERT INTO public.hot_updater_v1_bundle_events (
          id,type,install_id,user_id,username,from_release_id,from_bundle_id,
          to_release_id,to_bundle_id,platform,app_version,channel,cohort,
          update_strategy,fingerprint_hash,sdk_version,received_at_ms
        ) VALUES
        (
          '00000000-0000-7000-8000-000000000001','UNCHANGED','valid-before-poison',
          null,null,null,null,null,'${bundleA}','ios','1.0.0','production',
          'default',null,null,null,1
        ),
        (
          'ffffffff-ffff-7000-8000-000000000001','UNCHANGED','poison',null,null,
          null,null,null,'${bundleA}','ios','1.0.0','production','default',null,null,
          '${"x".repeat(1025)}',2
        )
      `);
      await db.exec(await readFile(insightsMigrationPath, "utf8"));
      expect(await prepareLegacy(db, 1000)).toMatchObject({
        state: "failed",
        jobId: "supabase-v2-migration",
      });
      expect(
        (
          await db.query<{
            id: string;
            install_id: string;
            insights_source_seq: number | null;
          }>(
            `select id,install_id,insights_source_seq
             from public.hot_updater_v1_bundle_events order by id`,
          )
        ).rows,
      ).toEqual([
        {
          id: "00000000-0000-7000-8000-000000000001",
          install_id: "valid-before-poison",
          insights_source_seq: null,
        },
        {
          id: "ffffffff-ffff-7000-8000-000000000001",
          install_id: "poison",
          insights_source_seq: null,
        },
      ]);
      expect(
        (
          await db.query<{
            ready: boolean;
            poison: string | null;
            committed_seq: number;
            migration_after_id: string | null;
          }>(
            `select ready,poison,committed_seq,migration_after_id
             from public.hot_updater_v1_insights_source_state where id=1`,
          )
        ).rows[0],
      ).toEqual({
        ready: false,
        poison: "event:ffffffff-ffff-7000-8000-000000000001",
        committed_seq: 0,
        migration_after_id: null,
      });
      const rpc = pgliteRpc(db);
      const runtime = createSupabaseInsights(
        { rpc: rpc as unknown as SupabaseClient<Database>["rpc"] },
        databaseNamespace,
      );
      const appended = event(904, {
        type: "UNCHANGED",
        install_id: "valid-after-poison",
        received_at_ms: 3,
      });
      await runtime.append(appended);
      expect(
        (
          await db.query<{
            source_seq: number;
            poison: string;
          }>(`
            select event.insights_source_seq::integer source_seq,source.poison
            from public.hot_updater_v1_bundle_events event
            cross join public.hot_updater_v1_insights_source_state source
            where event.id='${appended.id}'
          `)
        ).rows[0],
      ).toEqual({
        source_seq: 1,
        poison: "event:ffffffff-ffff-7000-8000-000000000001",
      });
      await db.exec(`
        UPDATE public.hot_updater_v1_bundle_events
        SET sdk_version='1.0.0'
        WHERE id='ffffffff-ffff-7000-8000-000000000001'
      `);
      const worker = createSupabaseInsightsMaintenance(
        {
          rpc: rpc as unknown as SupabaseClient<Database>["rpc"],
        },
        databaseNamespace,
      );
      for (let step = 0; step < 8; step += 1) {
        const progress = await worker.runJobStep("supabase-v2-migration", {
          maxItems: 1000,
          maxRequests: 2,
        });
        if (progress.state === "complete") break;
      }
      expect(
        (
          await db.query<{ ready: boolean; poison: string | null }>(
            `select ready,poison
             from public.hot_updater_v1_insights_source_state where id=1`,
          )
        ).rows[0],
      ).toEqual({ ready: true, poison: null });
    } finally {
      await db.close();
    }
  });

  it("accepts append while a bounded legacy keyset backfill is preparing", async () => {
    const db = new PGlite();
    try {
      await db.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
      );
      await db.exec(
        await readFile(
          `${migrationsPath}/20260818000000_hot-updater_1.0.0.sql`,
          "utf8",
        ),
      );
      for (const row of [
        event(902, {
          type: "UNCHANGED",
          install_id: "legacy-b",
          received_at_ms: 2,
        }),
        event(901, {
          type: "UNCHANGED",
          install_id: "legacy-a",
          received_at_ms: 1,
        }),
      ]) {
        await db.query(
          `insert into public.hot_updater_v1_bundle_events
           select * from jsonb_populate_record(
             null::public.hot_updater_v1_bundle_events,$1::jsonb
           )`,
          [JSON.stringify(row)],
        );
      }
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.hot_updater_v1_commit(p_commit jsonb)
        RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog, public AS $$
        DECLARE v_event public.hot_updater_v1_bundle_events;
        BEGIN
          v_event := jsonb_populate_record(
            null::public.hot_updater_v1_bundle_events,
            p_commit->'changes'->0->'row'
          );
          INSERT INTO public.hot_updater_v1_bundle_events SELECT v_event.*;
          RETURN jsonb_build_object('committed', true);
        END;
        $$;
        GRANT EXECUTE ON FUNCTION public.hot_updater_v1_commit(jsonb)
          TO service_role;
      `);
      const before = (
        await db.query<{ row: Record<string, unknown> }>(
          `select to_jsonb(event) row
           from public.hot_updater_v1_bundle_events event order by id`,
        )
      ).rows;
      await db.exec(await readFile(insightsMigrationPath, "utf8"));

      await db.exec("SET ROLE service_role");
      await expect(
        db.query("select public.hot_updater_v1_commit($1::jsonb)", [
          JSON.stringify({
            changes: [
              {
                model: "insights",
                operation: "insert",
                row: event(905, {
                  type: "UNCHANGED",
                  install_id: "old-writer-bypass",
                  received_at_ms: 4,
                }),
              },
            ],
          }),
        ]),
      ).rejects.toThrow("append RPC");
      await db.exec("RESET ROLE");
      expect(
        (
          await db.query<{ count: number }>(
            `select count(*)::integer count
             from public.hot_updater_v1_bundle_events
             where install_id='old-writer-bypass'`,
          )
        ).rows[0]!.count,
      ).toBe(0);

      const rpc = pgliteRpc(db);
      const client = {
        rpc: rpc as unknown as SupabaseClient<Database>["rpc"],
      };
      const runtime = createSupabaseInsights(client, databaseNamespace);
      const worker = createSupabaseInsightsMaintenance(
        client,
        databaseNamespace,
      );
      const gated = await runtime.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 10,
        limit: 1,
      });
      expect(gated).toMatchObject({
        state: "preparing",
        job: { id: "supabase-v2-migration" },
      });
      expect(
        (
          await db.query<{ cursor: string | null; unprepared: number }>(`
            select source.migration_after_id::text cursor,
              count(*) filter (where event.insights_source_seq is null)::integer
                unprepared
            from public.hot_updater_v1_bundle_events event
            cross join public.hot_updater_v1_insights_source_state source
            group by source.migration_after_id
          `)
        ).rows[0],
      ).toEqual({ cursor: null, unprepared: 2 });

      const appended = event(903, {
        type: "UNCHANGED",
        install_id: "new-during-backfill",
        received_at_ms: 3,
      });
      await runtime.append(appended);
      expect(
        (
          await db.query<{
            count: number;
            unprepared: number;
            ready: boolean;
          }>(`
            select count(*)::integer count,
              count(*) filter (where event.insights_source_seq is null)::integer
                unprepared,
              bool_and(source.ready) ready
            from public.hot_updater_v1_bundle_events event
            cross join public.hot_updater_v1_insights_source_state source
          `)
        ).rows[0],
      ).toEqual({ count: 3, unprepared: 2, ready: false });

      await expect(
        worker.runJobStep("supabase-v2-migration", {
          maxItems: 1,
          maxRequests: 1,
        }),
      ).resolves.toMatchObject({
        state: "idle",
        usage: { items: 0, requests: 0, bytes: 0 },
      });
      const reopened = createSupabaseInsightsMaintenance(
        {
          rpc: rpc as unknown as SupabaseClient<Database>["rpc"],
        },
        databaseNamespace,
      );
      await expect(
        reopened.runJobStep("supabase-v2-migration", {
          maxItems: 1,
          maxRequests: 1,
        }),
      ).resolves.toMatchObject({
        state: "idle",
        usage: { items: 0, requests: 0, bytes: 0 },
      });
      expect(
        (
          await db.query<{ unprepared: number }>(`
            select count(*) filter (
              where insights_source_seq is null
            )::integer unprepared
            from public.hot_updater_v1_bundle_events
          `)
        ).rows[0],
      ).toEqual({ unprepared: 2 });
      for (const expectedState of ["running", "complete"] as const) {
        const stepWorker = createSupabaseInsightsMaintenance(
          {
            rpc: rpc as unknown as SupabaseClient<Database>["rpc"],
          },
          databaseNamespace,
        );
        const progress = await stepWorker.runJobStep("supabase-v2-migration", {
          maxItems: 1,
          maxRequests: 2,
        });
        expect(progress.state).toBe(expectedState);
        expect(progress.usage.items).toBe(1);
        expect(progress.usage.requests).toBe(2);
        expect(progress.usage.bytes).toBeGreaterThan(0);
        expect(progress.usage.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      }

      const after = (
        await db.query<{ row: Record<string, unknown> }>(
          `select to_jsonb(event) - 'insights_event' - 'insights_event_bytes' -
             'insights_source_seq' - 'insights_install_key' -
             'insights_cohort_order' row
           from public.hot_updater_v1_bundle_events event
           where install_id like 'legacy-%' order by id`,
        )
      ).rows;
      expect(after).toEqual(before);
    } finally {
      await db.close();
    }
  });
});
