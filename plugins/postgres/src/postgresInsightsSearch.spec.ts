import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import type { BundleEventRow } from "@hot-updater/plugin-core";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { searchEventInstallations } from "../../../packages/server/src/insights/bounded/installationSearch";
import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  migratePostgresInsightsReports,
  migratePostgresInsightsSource,
} from "./db";
import { postgres } from "./postgres";
import { createPostgresInsightsJobs } from "./postgresInsightsJobs";
import { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
import { createPostgresInsightsSearchPages } from "./postgresInsightsSearchPages";
import { createPostgresInsightsSourceTools } from "./postgresInsightsSource";
import type { Database } from "./types";

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
    plugin = postgres({ dialect: new PGliteDialect(client) });
    await migratePostgresInsightsSource(db);
    await migratePostgresInsightsReports(db);
    await createPostgresInsightsSourceTools(db).backfillStep(1);
    jobs = createPostgresInsightsJobs(db);
    worker = createPostgresInsightsReportWorker(db);
    pages = createPostgresInsightsSearchPages(db);
  });
  afterEach(async () => {
    await plugin.dispose?.();
    await db.destroy();
    await client.close();
  });
  const reserve = async (
    query: string,
    asOfMs = cutoff,
    minAsOfMs?: number,
  ) => {
    const result = await jobs.getSearch({
      query,
      ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
    });
    if (result.state !== "queued") throw new Error("Expected queued search.");
    const base = (
      await sql<{
        base_job_id: string;
      }>`select base_job_id from private_hot_updater_insights_report_jobs where id = ${result.jobId}::uuid`.execute(
        db,
      )
    ).rows[0]!.base_job_id;
    await sql`update private_hot_updater_insights_report_jobs set as_of_ms = ${asOfMs} where id = ${base}::uuid and status = 'queued'`.execute(
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
  const finish = async (query: string, minAsOfMs?: number, maxItems = 256) => {
    for (let i = 0; i < 1200; i++) {
      const current = await jobs.getSearch({
        query,
        ...(minAsOfMs === undefined ? {} : { minAsOfMs }),
      });
      if (current.state === "ready") return current.publication;
      expect(current.state).not.toBe("failed");
      expect((await step(maxItems)).state).not.toBe("idle");
    }
    throw new Error("Search failed to make bounded completion progress.");
  };

  it("matches historical user/username semantics, pages full JS ID order and reuses normalized searches", async () => {
    const rows: BundleEventRow[] = [];
    for (let i = 0; i < 137; i++) {
      const id = `${["A", "a", "😀", "\ue000"][i % 4]}-${String(i).padStart(3, "0")}`;
      rows.push(
        event(i + 1, id, "FORMER/Team", cutoff - 100),
        event(i + 200, id, "current", cutoff - 1),
      );
    }
    rows.push({ ...event(900, "legacy", "current"), username: "Former/Team" });
    rows.push(event(901, "unrelated", "other"));
    for (const row of [...rows].reverse())
      await plugin.models.insights.append(row);
    const reserved = await reserve("former/team");
    expect(await jobs.getSearch({ query: "FORMER/TEAM" })).toMatchObject({
      state: "queued",
      jobId: reserved.id,
    });
    const publication = await finish("former/team");
    expect(publication).toMatchObject({
      id: reserved.id,
      asOfMs: cutoff,
      total: 138,
      accuracy: "exact",
    });
    const actual = [];
    let cursor: string | undefined;
    for (const limit of [1, 100, 37]) {
      statements = [];
      returned = 0;
      const result = await pages.pageContains({
        kind: "contains",
        query: "FORMER/TEAM",
        limit,
        publicationId: publication.id,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (result.state !== "ready") throw new Error("Expected ready page.");
      expect(result.consistency).toBe("snapshot");
      expect(result.rows).toHaveLength(limit);
      expect(
        statements.some((value) =>
          /\bbundle_events\b|\boffset\b|^(insert|update|delete)/i.test(value),
        ),
      ).toBe(false);
      expect(statements.length).toBeLessThanOrEqual(20);
      expect(returned).toBeLessThanOrEqual(2 * limit + 15);
      actual.push(...result.rows);
      cursor = result.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();
    const expected = [0, 100].flatMap(
      (offset) =>
        searchEventInstallations({
          rows,
          query: "former/team",
          limit: 100,
          offset,
        }).data,
    );
    expect(actual.map((row) => row.install_id)).toEqual(
      expected.map((row) => row.installId),
    );
    expect(actual.every((row) => row.user_id === "current")).toBe(true);
  });

  it("freezes aliases/latest at its pinned source and preserves old pages during refresh", async () => {
    await plugin.models.insights.append(event(1, "first", "Needle"));
    const initial = await reserve("needle");
    await step(); // The earlier base job captures its source first.
    await plugin.models.insights.append(
      event(2, "second", "Needle", cutoff - 20),
    );
    const first = await finish("needle");
    expect(first.total).toBe(1);
    const next = await reserve("needle", cutoff + 1, cutoff + 1);
    expect(next.base).not.toBe(initial.base);
    const second = await finish("needle", cutoff + 1);
    expect(second).toMatchObject({ total: 2, asOfMs: cutoff + 1 });
    expect(second.sourceGeneration).not.toBe(first.sourceGeneration);
    const pinned = await pages.pageContains({
      kind: "contains",
      query: "needle",
      limit: 100,
      publicationId: first.id,
      minAsOfMs: cutoff,
    });
    expect(pinned).toMatchObject({
      state: "ready",
      rows: [{ install_id: "first" }],
      publication: first,
    });
    await expect(
      pages.pageContains({
        kind: "contains",
        query: "needle",
        limit: 100,
        publicationId: first.id,
        minAsOfMs: cutoff + 1,
      }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      sql`delete from private_hot_updater_insights_report_jobs where id = ${initial.base}::uuid`.execute(
        db,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await jobs.getSearch({ query: "needle" })).toEqual({
      state: "ready",
      publication: second,
    });
  });

  it("binds bookmarks to query/publication, accepts page-size changes and rejects malformed input before I/O", async () => {
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
    const next = await pages.pageContains({
      kind: "contains",
      query: "QUERY",
      cursor: first.nextCursor,
      limit: 100,
    });
    expect(next).toMatchObject({
      state: "ready",
      rows: [{ install_id: "second" }],
      nextCursor: null,
    });
    await expect(
      pages.pageContains({ ...input, query: "other" }),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(
      await pages.pageContains({
        ...input,
        publicationId: "00000000-0000-0000-0000-000000000099",
      }),
    ).toEqual({
      state: "expired",
      publicationId: "00000000-0000-0000-0000-000000000099",
    });
    const unseen = await reserve("not-ready");
    await expect(
      pages.pageContains({
        ...input,
        query: "not-ready",
        publicationId: unseen.id,
      }),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
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
      await jobs.getSearch({ query });
      expect(await finish(query)).toMatchObject({ total });
      expect(
        await pages.pageContains({ kind: "contains", query, limit: 100 }),
      ).toMatchObject({ state: "ready", publication: { total } });
    }
    expect(await jobs.getSearch({ query: "İ" })).toEqual(
      await jobs.getSearch({ query: "i\u0307" }),
    );
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
      select n, md5(n::text)::uuid::text as id, 'lookup-' || lpad(n::text,5,'0') as install_id
      from generate_series(0,50000)n
    ), sharded as (
      select *, get_byte(sha256(convert_to(id,'UTF8')),0) % 16 as shard from ids
    ), source as (
      select *, row_number() over (partition by shard order by n) as sequence from sharded
    ) insert into bundle_events select (jsonb_populate_record(null::bundle_events,
      ${JSON.stringify(template)}::jsonb || jsonb_build_object('id',id,'install_id',install_id,
      'insights_source_shard',shard,'insights_source_seq',sequence))).* from source`.execute(
      db,
    );
    await sql`update private_hot_updater_insights_source_clocks c set committed_seq=s.last_sequence from
      (select insights_source_shard,max(insights_source_seq) as last_sequence from bundle_events group by insights_source_shard)s
      where c.shard=s.insights_source_shard`.execute(db);
    const generation = await createPostgresInsightsSourceTools(db).capture();
    await sql`insert into private_hot_updater_insights_report_latest(job_id,install_key,bucket_index,install_id,event)
      select ${baseId}::uuid,encode(sha256(convert_to(to_json(install_id)::text,'UTF8')),'hex'),-1,install_id,
        to_jsonb(e)-'insights_source_shard'-'insights_source_seq' from bundle_events e`.execute(
      db,
    );
    await sql`insert into private_hot_updater_insights_report_aliases(job_id,alias_key,install_key,identity)
      select ${baseId}::uuid,encode(sha256(convert_to(identity_text,'UTF8')),'hex'),install_key,identity_text::json
      from (select install_key,'["installation","'||install_id||'","'||install_id||'"]' as identity_text
      from private_hot_updater_insights_report_latest where job_id=${baseId}::uuid)fixture`.execute(
      db,
    );
    for (const [section, label] of [
      ["installations", ""],
      ["bundleDistribution", template.to_bundle_id],
    ] as const) {
      const identity = JSON.stringify([section, "", label, -1]);
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
        identity: [string, string, string];
      }>`select identity from private_hot_updater_insights_report_aliases
      where job_id=${baseId}::uuid order by alias_key desc limit 1`.execute(db)
    ).rows[0]!.identity[1];
    const search = await jobs.getSearch({ query: target });
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
  });

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
    expect(await jobs.getSearch({ query: "needle" })).toMatchObject({
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
