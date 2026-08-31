import { createHash, randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { migratePostgresInsightsReports } from "./db";
import { readPostgresInsightsLatestByKey } from "./postgresInsightsReportData";

const installKey = (value: string) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("frozen installation point lookups", () => {
  let client: PGlite;
  let db: Kysely<object>;
  let statements: string[];
  let returned: number;
  const first = randomUUID();
  const second = randomUUID();
  const rows = Array.from({ length: 200 }, (_, i) => ({
    ...createBundleEventRowFixture(String(i + 1), i + 1),
    install_id: `install-${i}`,
  }));

  beforeEach(async () => {
    client = new PGlite();
    statements = [];
    returned = 0;
    db = new Kysely<object>({
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
    await migratePostgresInsightsReports(db);
    await sql`insert into private_hot_updater_insights_report_latest
      (job_id, install_key, bucket_index, install_id, event) values ${sql.join(
        rows.map(
          (row) =>
            sql`(${first}::uuid, ${installKey(row.install_id)}, -1, ${row.install_id}, ${JSON.stringify(row)}::jsonb)`,
        ),
      )}`.execute(db);
    // An identically keyed installation in another publication or bucket must
    // never satisfy a missing whole-publication latest record.
    await sql`insert into private_hot_updater_insights_report_latest
      select ${second}::uuid, install_key, bucket_index, install_id,
        event || '{"user_id":"new-generation"}'::jsonb
      from private_hot_updater_insights_report_latest where job_id = ${first}::uuid`.execute(
      db,
    );
    await sql`insert into private_hot_updater_insights_report_latest
      select job_id, install_key, 0, install_id, event
      from private_hot_updater_insights_report_latest where job_id = ${first}::uuid`.execute(
      db,
    );
    statements = [];
    returned = 0;
  });
  afterEach(async () => {
    await db.destroy();
    await client.close();
  });

  it("resolves 200 hash points without ordering, raw reads or cross-publication metadata", async () => {
    const requested = [...rows].reverse();
    expect(
      await readPostgresInsightsLatestByKey(
        db,
        first,
        requested.map((row) => installKey(row.install_id)),
      ),
    ).toEqual(
      requested.map((event) => ({
        installKey: installKey(event.install_id),
        event,
      })),
    );
    expect(statements).toHaveLength(2);
    expect(returned).toBe(201);
    expect(
      statements.some((statement) =>
        /bundle_events|order by|offset/i.test(statement),
      ),
    ).toBe(false);
    expect(
      await readPostgresInsightsLatestByKey(db, first, [
        installKey(rows[0]!.install_id),
        installKey(rows[0]!.install_id),
      ]),
    ).toHaveLength(1);
  });

  it("rejects missing or mismatched expected records instead of publishing a shortened result", async () => {
    const key = installKey(rows[0]!.install_id);
    await sql`delete from private_hot_updater_insights_report_latest where job_id = ${first}::uuid and install_key = ${key} and bucket_index = -1`.execute(
      db,
    );
    await expect(
      readPostgresInsightsLatestByKey(db, first, [key]),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await sql`update private_hot_updater_insights_report_latest set install_id = 'different' where job_id = ${second}::uuid and install_key = ${key}`.execute(
      db,
    );
    await expect(
      readPostgresInsightsLatestByKey(db, second, [key]),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("rejects excessive or malformed requests before I/O and skips empty matches", async () => {
    const key = installKey(rows[0]!.install_id);
    for (const keys of [
      Array(201).fill(key),
      Array(1),
      ["invalid"],
      [null],
      [key.toUpperCase()],
    ])
      await expect(
        readPostgresInsightsLatestByKey(db, first, keys as string[]),
      ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(
      readPostgresInsightsLatestByKey(db, "invalid", [key]),
    ).rejects.toMatchObject({ code: "invalid-query" });
    expect(await readPostgresInsightsLatestByKey(db, first, [])).toEqual([]);
    expect(statements).toEqual([]);
  });

  it("fails before a point lookup when the required latest primary key is missing", async () => {
    await sql`alter table private_hot_updater_insights_report_latest drop constraint private_hot_updater_insights_report_latest_pkey`.execute(
      db,
    );
    statements = [];
    await expect(
      readPostgresInsightsLatestByKey(db, first, [
        installKey(rows[0]!.install_id),
      ]),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("pg_index");
  });
});
