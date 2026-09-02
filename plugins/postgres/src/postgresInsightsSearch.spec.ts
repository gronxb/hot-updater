import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import type { BundleEventRow } from "@hot-updater/plugin-core";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  migratePostgresInsightsLive,
  migratePostgresInsightsReports,
  migratePostgresInsightsSource,
} from "./db";
import { postgres } from "./postgres";
import { createPostgresInsightsJobs } from "./postgresInsightsJobs";
import { createPostgresInsightsLiveTools } from "./postgresInsightsLive";
import { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
import { createPostgresInsightsSearchPages } from "./postgresInsightsSearchPages";
import { createPostgresInsightsSourceTools } from "./postgresInsightsSource";
import type { Database } from "./types";

const insightsDatabaseNamespace = "00000000-0000-7000-8000-00000000f001";

const cutoff = Date.UTC(2026, 0, 10, 12, 34, 56);
const event = (
  id: number,
  installId: string,
  userId: string,
  time = cutoff - 10,
): BundleEventRow => ({
  ...createBundleEventRowFixture(String(id), time),
  install_id: installId,
  user_id: userId,
});

describe("durable historical contains and immutable installation pages", () => {
  let client: PGlite;
  let db: Kysely<Database>;
  let plugin: ReturnType<typeof postgres>;
  let jobs: ReturnType<typeof createPostgresInsightsJobs<Database>>;
  let worker: ReturnType<typeof createPostgresInsightsReportWorker<Database>>;
  let pages: ReturnType<typeof createPostgresInsightsSearchPages<Database>>;
  let databaseNamespace: string;
  let statements: string[];
  let returned: number;
  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
    );
    statements = [];
    returned = 0;
    db = new Kysely<Database>({
      dialect: new PGliteDialect(client),
      log: (event) => {
        statements.push(event.query.sql);
      },
      plugins: [
        {
          transformQuery: ({ node }) => node,
          async transformResult({ result }) {
            returned += result.rows.length;
            return result;
          },
        },
      ],
    });
    plugin = postgres({
      insightsDatabaseNamespace,
      dialect: new PGliteDialect(client),
    });
    await migratePostgresInsightsSource(db, insightsDatabaseNamespace);
    await migratePostgresInsightsReports(db, insightsDatabaseNamespace);
    await createPostgresInsightsSourceTools(
      db,
      insightsDatabaseNamespace,
    ).backfillStep(1);
    databaseNamespace = (
      await sql<{ source_id: string }>`select source_id::text
        from private_hot_updater_insights_source_state where id=1`.execute(db)
    ).rows[0]!.source_id;
    await migratePostgresInsightsLive(db, insightsDatabaseNamespace);
    await createPostgresInsightsLiveTools(
      db,
      insightsDatabaseNamespace,
    ).backfillStep(1);
    jobs = createPostgresInsightsJobs(db, insightsDatabaseNamespace);
    worker = createPostgresInsightsReportWorker(db, insightsDatabaseNamespace);
    pages = createPostgresInsightsSearchPages(db, databaseNamespace);
  });
  afterEach(async () => {
    await plugin.dispose?.();
    await db.destroy();
    await client.close();
  });
  const reserve = async (query: string) => {
    const result = await jobs.getSearch({
      kind: "contains",
      query,
    });
    if (result.state !== "queued") throw new Error("Expected queued search.");
    const base = (
      await sql<{
        base_job_id: string;
      }>`select base_job_id from private_hot_updater_insights_report_jobs where id = ${result.jobId}::uuid`.execute(
        db,
      )
    ).rows[0]!.base_job_id;
    await sql`update private_hot_updater_insights_report_jobs set as_of_ms = ${cutoff} where id = ${base}::uuid and status = 'queued'`.execute(
      db,
    );
    return { id: result.jobId, base };
  };
  const step = async (maxItems = 256) => {
    statements = [];
    returned = 0;
    const result = await worker.runStep({ maxItems, maxRequests: 128 });
    expect(statements.length).toBeLessThanOrEqual(128);
    expect(returned).toBeLessThanOrEqual(maxItems);
    return result;
  };
  const finish = async (query: string) => {
    for (let i = 0; i < 1200; i++) {
      const current = await jobs.getSearch({ kind: "contains", query });
      if (current.state === "ready") return current.publication;
      expect(current.state).not.toBe("failed");
      expect((await step()).state).not.toBe("idle");
    }
    throw new Error("Search failed to make bounded completion progress.");
  };

  it("rejects malformed bookmarks before I/O and resumes with a changed page size", async () => {
    await plugin.models.insights.append(event(1, "first", "query"));
    await plugin.models.insights.append(event(2, "second", "query"));
    const initial = await reserve("query");
    await finish("query");
    const input = {
      kind: "contains",
      query: "query",
      limit: 1,
      publicationId: initial.id,
    } as const;
    const first = await pages.pageContains(input);
    if (first.state !== "ready" || first.nextCursor === null)
      throw new Error("Expected bookmark.");
    const otherKind = await jobs.getSearch({ kind: "userId", query: "query" });
    if (otherKind.state !== "queued")
      throw new Error("Expected queued user search.");
    let otherPublication: string | undefined;
    for (let i = 0; i < 1200; i++) {
      const current = await jobs.getSearch({ kind: "userId", query: "query" });
      if (current.state === "ready") {
        otherPublication = current.publication.id;
        break;
      }
      expect(current.state).not.toBe("failed");
      expect((await step()).state).not.toBe("idle");
    }
    if (otherPublication === undefined)
      throw new Error("User search failed to complete.");
    await expect(
      pages.pageContains({ ...input, publicationId: otherPublication }),
    ).resolves.toEqual({
      state: "expired",
      publicationId: otherPublication,
    });
    await client.exec("drop index bundle_events_source_idx");
    statements = [];
    await expect(pages.pageContains(input)).resolves.toMatchObject({
      state: "ready",
      publication: { id: initial.id },
    });
    await expect(
      pages.pageContains({
        kind: "contains",
        query: "query",
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).resolves.toMatchObject({ state: "ready", nextCursor: null });
    expect(statements.some((query) => /bundle_events/.test(query))).toBe(false);
    expect(
      statements.filter((query) =>
        /private_hot_updater_insights_source_state/.test(query),
      ),
    ).toHaveLength(2);
    for (const bad of [
      { ...input, query: "different", cursor: first.nextCursor },
      { ...input, publicationId: initial.base, cursor: first.nextCursor },
      { ...input, cursor: "x".repeat(513) },
      {
        ...input,
        cursor: JSON.stringify([
          1,
          "snapshot",
          initial.id,
          JSON.parse(first.nextCursor)[3],
          "01",
        ]),
      },
      {
        ...input,
        cursor: JSON.stringify([
          1,
          "snapshot",
          initial.id,
          JSON.parse(first.nextCursor)[3],
          "9223372036854775808",
        ]),
      },
      { ...input, limit: 101 },
    ]) {
      statements = [];
      await expect(pages.pageContains(bad)).rejects.toMatchObject({
        code: "invalid-query",
      });
      expect(statements).toEqual([]);
    }
    await expect(
      pages.pageContains({
        kind: "contains",
        query: "QUERY",
        cursor: first.nextCursor,
        limit: 100,
      }),
    ).resolves.toMatchObject({ state: "ready", nextCursor: null });
  });

  it("keeps literal substring and Unicode lowercase semantics while bounding an all-matching alias page", async () => {
    for (let i = 0; i < 75; i++)
      await plugin.models.insights.append({
        ...event(i + 1, `A%_${i}`, "unused"),
        user_id: null,
        username: null,
      });
    await plugin.models.insights.append({
      ...event(1000, "case", "unused"),
      username: "İ",
    });
    await plugin.models.insights.append({
      ...event(1001, "accent", "unused"),
      username: "e\u0301",
    });
    await plugin.models.insights.append(event(1002, "AXY-other", "unused"));
    await reserve("a%_");
    expect(await finish("a%_")).toMatchObject({ total: 75 });
    for (const [query, total] of [
      ["İ", 1],
      ["é", 0],
      ["e\u0301", 1],
      ["\u0000\uD800", 0],
    ] as const) {
      await jobs.getSearch({ kind: "contains", query });
      expect(await finish(query)).toMatchObject({ total });
      expect(
        await pages.pageContains({ kind: "contains", query, limit: 100 }),
      ).toMatchObject({ state: "ready", publication: { total } });
    }
  });

  it("scans beyond 50,000 prepared aliases in bounded steps even when only the final alias matches", async () => {
    const report = await jobs.getReport({
      query: { kind: "installationOverview" },
    });
    if (report.state !== "queued") throw new Error("Expected base job.");
    const baseId = report.jobId;
    // Bulk fixture preparation models the completed source phase, which has its
    // own worker tests. Raw rows, captured shard prefixes, aliases and latest
    // records agree; only the contains job consumes the 50,001-alias fixture.
    const template = {
      ...event(1, "unused", "unused"),
      user_id: null,
      username: null,
    };
    await sql`with ids as (
      select n, ('10000000-0000-7000-8000-'||lpad(n::text,12,'0'))::uuid::text as id,
        'lookup-' || lpad(n::text,5,'0') as install_id
      from generate_series(0,50000)n
    ), sharded as (
      select *, get_byte(sha256(convert_to(id,'UTF8')),0) % 16 as shard from ids
    ), source as (
      select *, row_number() over (partition by shard order by n) as sequence from sharded
    ), events as (
      select *, ${JSON.stringify(template)}::jsonb ||
        jsonb_build_object('id',id,'install_id',install_id) as event from source
    ) insert into bundle_events select (jsonb_populate_record(null::bundle_events,
      event || jsonb_build_object('insights_source_shard',shard,
      'insights_source_seq',sequence,'insights_event',event,
      'insights_live_version',1))).* from events`.execute(db);
    await sql`update private_hot_updater_insights_source_clocks c set committed_seq=s.last_sequence from
      (select insights_source_shard,max(insights_source_seq) as last_sequence from bundle_events group by insights_source_shard)s
      where c.shard=s.insights_source_shard`.execute(db);
    const generation = await createPostgresInsightsSourceTools(
      db,
      insightsDatabaseNamespace,
    ).capture();
    await sql`insert into private_hot_updater_insights_report_latest(job_id,install_key,bucket_index,install_id,event)
      select ${baseId}::uuid,encode(sha256(convert_to(to_json(install_id)::text,'UTF8')),'hex'),-1,install_id,
        e.insights_event from bundle_events e`.execute(db);
    await sql`insert into private_hot_updater_insights_report_aliases(job_id,alias_key,install_key,identity)
      select ${baseId}::uuid,encode(sha256(convert_to(identity_text,'UTF8')),'hex'),install_key,identity_text::json
      from (select install_key,'["installation","'||install_id||'","'||install_id||'","'||install_id||'"]' as identity_text
      from private_hot_updater_insights_report_latest where job_id=${baseId}::uuid)fixture`.execute(
      db,
    );
    for (const [section, label] of [
      ["installations", ""],
      ["bundleDistribution", template.to_bundle_id],
    ] as const) {
      const identity = JSON.stringify([section, "", label, -1]);
      await sql`insert into private_hot_updater_insights_report_count_manifest
        (job_id,count_key,identity,section,metric,label,bucket_start_ms)
        values(${baseId}::uuid,encode(sha256(convert_to(${identity},'UTF8')),'hex'),
          ${identity}::jsonb,${section},'',${label},-1)`.execute(db);
      await sql`insert into private_hot_updater_insights_report_counts(job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
        values(${baseId}::uuid,encode(sha256(convert_to(${identity},'UTF8')),'hex'),${identity}::jsonb,${section},'',${label},-1,50001)`.execute(
        db,
      );
    }
    await sql`update private_hot_updater_insights_report_jobs set as_of_ms=${cutoff},source_generation=${generation},
      checkpoint='{"phase":"ordering","section":0}'::jsonb where id=${baseId}::uuid`.execute(
      db,
    );
    for (let i = 0; i < 5; i++) if ((await step()).state === "published") break;
    expect(
      await jobs.getReport({ query: { kind: "installationOverview" } }),
    ).toMatchObject({
      state: "ready",
      publication: { summary: { trackedInstallations: 50001 } },
    });
    const target = (
      await sql<{
        identity: [string, string, string, string];
      }>`select identity from private_hot_updater_insights_report_aliases
      where job_id=${baseId}::uuid order by alias_key desc limit 1`.execute(db)
    ).rows[0]!.identity[1];
    const search = await jobs.getSearch({ kind: "contains", query: target });
    if (search.state !== "queued") throw new Error("Expected queued search.");
    let consumed = 0;
    let complete = false;
    for (let i = 0; i < 300; i++) {
      const result = await step(1024);
      expect(result.jobId).toBe(search.jobId);
      expect(result.processed).toBeLessThanOrEqual(200);
      expect(
        statements.some((statement) =>
          /\bbundle_events\b|\boffset\b/i.test(statement),
        ),
      ).toBe(false);
      consumed += result.processed;
      if (result.state === "published") {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    expect(consumed).toBe(50002); // Every alias plus the one emitted sort record.
    expect(
      await pages.pageContains({ kind: "contains", query: target, limit: 100 }),
    ).toMatchObject({
      state: "ready",
      publication: { total: 1, asOfMs: cutoff, sourceGeneration: generation },
      rows: [{ install_id: target }],
      nextCursor: null,
    });
  }, 120_000);

  it("fails a search before publication when a matching base installation is missing", async () => {
    await plugin.models.insights.append(event(1, "match", "needle"));
    const search = await reserve("needle");
    for (let i = 0; i < 100; i++) {
      const stored = (
        await sql<{
          checkpoint: { phase: string };
        }>`select checkpoint from private_hot_updater_insights_report_jobs where id=${search.id}::uuid`.execute(
          db,
        )
      ).rows[0]!;
      if (stored.checkpoint.phase === "aliases") break;
      await step();
    }
    await sql`delete from private_hot_updater_insights_report_latest where job_id=${search.base}::uuid and bucket_index=-1`.execute(
      db,
    );
    await expect(step()).rejects.toMatchObject({ code: "invalid-result" });
    expect(
      await jobs.getSearch({ kind: "contains", query: "needle" }),
    ).toMatchObject({
      state: "failed",
      previous: null,
    });
    expect(
      (
        await sql`select * from private_hot_updater_insights_report_counts where job_id=${search.id}::uuid`.execute(
          db,
        )
      ).rows,
    ).toEqual([]);
  });
});
