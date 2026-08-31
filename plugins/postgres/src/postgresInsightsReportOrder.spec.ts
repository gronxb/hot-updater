import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPostgresInsightsReportOrderReady,
  readPostgresInsightsReportOrderRange,
  stepPostgresInsightsReportOrder,
  type PostgresInsightsReportOrderSection,
} from "./postgresInsightsReportOrder";

const counts = "private_hot_updater_insights_report_counts";
const states = "private_hot_updater_insights_report_order_states";
const runs = "private_hot_updater_insights_report_order_rows";
const jobId = "00000000-0000-0000-0000-000000000001";
const cohorts = { section: "movementCohorts", metric: "installed" } as const;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const metric = (section: PostgresInsightsReportOrderSection) =>
  "metric" in section ? section.metric : "";
const prefix = Array.from({ length: 96 }, (_, i) =>
  createHash("sha256").update(String(i)).digest("base64"),
).join("");
const labels = Array.from(
  { length: 137 },
  (_, i) =>
    `${prefix}${["A", "a", "z", "𐀀", "😀", "\ue000", "\uffff"][i % 7]}-${String(i).padStart(4, "0")}`,
);

describe("PostgreSQL bounded external report ordering", () => {
  let client: PGlite;
  let db: Kysely<object>;
  const seed = async (
    section: PostgresInsightsReportOrderSection,
    input = labels,
  ) => {
    await sql`insert into ${sql.table(counts)} (job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
      values ${sql.join(
        input.map((label, index) => {
          const identity = JSON.stringify([
            section.section,
            metric(section),
            label,
            -1,
          ]);
          return sql`(${jobId}::uuid,${hash(identity)},${identity}::jsonb,${section.section},${metric(section)},${label},-1,${section.section === "installationIds" ? 1 : (index % 4) + 1})`;
        }),
      )}`.execute(db);
    return input.map((label, index) => ({
      label,
      value: section.section === "installationIds" ? 1 : (index % 4) + 1,
      countKey: hash(
        JSON.stringify([section.section, metric(section), label, -1]),
      ),
    }));
  };
  const step = (section: PostgresInsightsReportOrderSection = cohorts) =>
    db
      .transaction()
      .execute((transaction) =>
        stepPostgresInsightsReportOrder(transaction, jobId, section),
      );
  const state = async () =>
    (await client.query(`select * from ${states}`)).rows;
  const finish = async (
    section: PostgresInsightsReportOrderSection = cohorts,
  ) => {
    const calls = vi.spyOn(client, "query");
    try {
      for (let i = 0; i < 200; i++) {
        calls.mockClear();
        const progress = await step(section);
        const results = await Promise.all(
          calls.mock.results.map(async (result, index) => ({
            query: calls.mock.calls[index]![0],
            rows: ((await result.value) as { rows: unknown[] }).rows.length,
          })),
        );
        const dataCalls = results.filter(
          ({ query }) => !/^(begin|commit|rollback)/i.test(query),
        );
        expect(dataCalls.length).toBeLessThanOrEqual(8);
        expect(
          dataCalls.reduce((total, result) => total + result.rows, 0),
        ).toBeLessThanOrEqual(67);
        for (const result of dataCalls.filter(({ query }) =>
          /order by (count_key|row_position)/.test(query),
        ))
          expect(result.rows).toBeLessThanOrEqual(32);
        expect(progress.processed).toBeLessThanOrEqual(32);
        if (progress.ready) return;
      }
      throw new Error(
        "Ordering did not finish within its fixture step budget.",
      );
    } finally {
      calls.mockRestore();
    }
  };

  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      await readFile(
        "plugins/postgres/sql/insights-report-data-v1.sql",
        "utf8",
      ),
    );
    await client.exec(
      await readFile(
        "plugins/postgres/sql/insights-report-order-v1.sql",
        "utf8",
      ),
    );
    db = new Kysely<object>({ dialect: new PGliteDialect(client) });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it.each<PostgresInsightsReportOrderSection>([
    cohorts,
    { section: "movementCohorts", metric: "recovered" },
    { section: "bundleDistribution" },
    { section: "activeBundleTotals" },
    { section: "installationIds" },
  ])(
    "sorts multiple passes of long labels using exact UTF-16 and count tie order: %j",
    async (section) => {
      const input = await seed(section);
      const expected = [...input].sort((a, b) => {
        if (section.section !== "movementCohorts" && a.value !== b.value)
          return b.value - a.value;
        return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
      });
      expect(Buffer.byteLength(input[0]!.label)).toBeGreaterThan(4000);
      await finish(section);
      const ready = await getPostgresInsightsReportOrderReady(
        db,
        jobId,
        section,
      );
      expect(ready).toEqual({ pass: "3", totalRows: "137" });
      const output = [];
      for (let offset = 0; offset < expected.length; offset += 17)
        output.push(
          ...(await readPostgresInsightsReportOrderRange(
            db,
            jobId,
            section,
            ready!.pass,
            String(offset),
            17,
          )),
        );
      expect(output).toEqual(
        expected.map((row, ordinal) => ({ ...row, ordinal: String(ordinal) })),
      );
      expect(new Set(output.map((row) => row.countKey)).size).toBe(
        input.length,
      );
      const before = await state();
      expect(await step(section)).toEqual({ ready: true, processed: 0 });
      expect(await state()).toEqual(before);
      expect(
        (
          await client.query(
            `select distinct sort_pass from ${runs} order by sort_pass`,
          )
        ).rows,
      ).toEqual([0, 1, 2, 3].map((sort_pass) => ({ sort_pass })));
    },
  );

  it("keeps an empty scope empty and validates range bounds before storage", async () => {
    expect(
      await getPostgresInsightsReportOrderReady(db, jobId, cohorts),
    ).toBeNull();
    expect(await step()).toEqual({ ready: true, processed: 0 });
    expect(
      await getPostgresInsightsReportOrderReady(db, jobId, cohorts),
    ).toEqual({ pass: "0", totalRows: "0" });
    expect(
      await readPostgresInsightsReportOrderRange(
        db,
        jobId,
        cohorts,
        "0",
        "0",
        101,
      ),
    ).toEqual([]);
    expect((await client.query(`select * from ${runs}`)).rows).toHaveLength(0);
    const calls = vi.spyOn(client, "query");
    for (const [pass, position, limit] of [
      ["59", "0", 1],
      ["9223372036854775807", "0", 1],
      ["0", "9223372036854775808", 1],
      ["0", "0", 102],
    ] as const) {
      await expect(
        readPostgresInsightsReportOrderRange(
          db,
          jobId,
          cohorts,
          pass,
          position,
          limit,
        ),
      ).rejects.toMatchObject({ code: "invalid-query" });
    }
    expect(calls).not.toHaveBeenCalled();
  });

  it("rolls back run rows and copy/merge positions together after a worker crash and safely resumes", async () => {
    await seed(cohorts, labels.slice(0, 65));
    await expect(
      db.transaction().execute(async (transaction) => {
        await stepPostgresInsightsReportOrder(transaction, jobId, cohorts);
        throw new Error("copy worker crashed");
      }),
    ).rejects.toThrow("copy worker crashed");
    expect(await state()).toHaveLength(0);
    expect((await client.query(`select * from ${runs}`)).rows).toHaveLength(0);
    await step();
    await step();
    await step();
    const before = await state();
    const initialRows = (await client.query(`select * from ${runs}`)).rows;
    await expect(
      db.transaction().execute(async (transaction) => {
        await stepPostgresInsightsReportOrder(transaction, jobId, cohorts);
        throw new Error("merge worker crashed");
      }),
    ).rejects.toThrow("merge worker crashed");
    expect(await state()).toEqual(before);
    expect((await client.query(`select * from ${runs}`)).rows).toEqual(
      initialRows,
    );
    await finish();
    const ready = (await getPostgresInsightsReportOrderReady(
      db,
      jobId,
      cohorts,
    ))!;
    const output = await readPostgresInsightsReportOrderRange(
      db,
      jobId,
      cohorts,
      ready.pass,
      "0",
      101,
    );
    expect(output).toHaveLength(65);
    expect(new Set(output.map((row) => row.countKey)).size).toBe(65);
  });

  it("rejects corrupted source identities, input gaps, invalid state and run ordering without advancing state", async () => {
    const input = await seed(cohorts, labels.slice(0, 65));
    await client.query(
      `update ${counts} set identity='["movementCohorts","installed","wrong",-1]'::jsonb where count_key=$1`,
      [input[0]!.countKey],
    );
    await expect(finish()).rejects.toMatchObject({ code: "invalid-result" });
    await client.query(
      `update ${counts} set identity=$2::jsonb where count_key=$1`,
      [
        input[0]!.countKey,
        JSON.stringify(["movementCohorts", "installed", input[0]!.label, -1]),
      ],
    );
    await finish();
    const ready = (await getPostgresInsightsReportOrderReady(
      db,
      jobId,
      cohorts,
    ))!;
    await client.query(
      `delete from ${runs} where sort_pass=$1 and run_number=0 and row_position=5`,
      [ready.pass],
    );
    await expect(
      readPostgresInsightsReportOrderRange(
        db,
        jobId,
        cohorts,
        ready.pass,
        "0",
        17,
      ),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await client.exec(`update ${states} set pair=1`);
    await expect(
      getPostgresInsightsReportOrderReady(db, jobId, cohorts),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("rejects short or unsorted merge inputs instead of treating them as exhausted", async () => {
    await seed(cohorts, labels.slice(0, 65));
    await step();
    await step();
    await step();
    const before = await state();
    const original = (
      await client.query<{
        row_position: string;
        label: string;
        value: string;
        count_key: string;
      }>(
        `select row_position::text,label,value::text,count_key from ${runs} where sort_pass=0 and run_number=0 and row_position in (5,6) order by row_position`,
      )
    ).rows;
    await client.exec(
      `delete from ${runs} where sort_pass=0 and run_number=0 and row_position=5`,
    );
    await expect(step()).rejects.toMatchObject({ code: "invalid-result" });
    expect(await state()).toEqual(before);
    await client.query(
      `insert into ${runs}(job_id,section,metric,sort_pass,run_number,row_position,label,value,count_key)
      values ($1,'movementCohorts','installed',0,0,5,$2,$3,$4)`,
      [jobId, original[0]!.label, original[0]!.value, original[0]!.count_key],
    );
    for (const [position, replacement] of [
      [5, original[1]!],
      [6, original[0]!],
    ] as const) {
      await client.query(
        `update ${runs} set label=$2,value=$3,count_key=$4 where sort_pass=0 and run_number=0 and row_position=$1`,
        [position, replacement.label, replacement.value, replacement.count_key],
      );
    }
    await expect(step()).rejects.toMatchObject({ code: "invalid-result" });
    expect(await state()).toEqual(before);
  });

  it("rejects a wrong or removed input index before reading count or run data", async () => {
    await seed(cohorts, labels.slice(0, 2));
    await client.exec(`drop index insights_report_counts_order_input_idx;
      create index insights_report_counts_order_input_idx on ${counts}(job_id,section,count_key,metric)
      where section in ('movementCohorts', 'bundleDistribution', 'activeBundleTotals', 'installationIds')`);
    const calls = vi.spyOn(client, "query");
    await expect(step()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(
      calls.mock.calls.some(([query]) =>
        /order by (count_key|row_position)/.test(query),
      ),
    ).toBe(false);
    await client.exec("drop index insights_report_counts_order_input_idx");
    calls.mockClear();
    await expect(step()).rejects.toMatchObject({
      code: "INSIGHTS_QUERY_NOT_READY",
    });
    expect(
      calls.mock.calls.some(([query]) =>
        /order by (count_key|row_position)/.test(query),
      ),
    ).toBe(false);
    await client.exec(
      `create index insights_report_counts_order_input_idx on ${counts}(job_id,section,metric,count_key)
      where section in ('movementCohorts', 'bundleDistribution', 'activeBundleTotals', 'installationIds')`,
    );
    expect(await step()).toEqual({ ready: true, processed: 2 });
  });

  it.each([
    ["unrestricted", ""],
    ["incomplete", "where section = 'movementCohorts'"],
  ])(
    "rejects an %s input index predicate before scanning",
    async (_, predicate) => {
      await seed(cohorts, labels.slice(0, 2));
      await client.exec(`drop index insights_report_counts_order_input_idx;
      create index insights_report_counts_order_input_idx on ${counts}(job_id,section,metric,count_key) ${predicate}`);
      const calls = vi.spyOn(client, "query");
      await expect(step()).rejects.toMatchObject({
        code: "INSIGHTS_QUERY_NOT_READY",
      });
      expect(
        calls.mock.calls.some(([query]) =>
          /order by (count_key|row_position)/.test(query),
        ),
      ).toBe(false);
      expect(await state()).toEqual([]);
    },
  );
});
