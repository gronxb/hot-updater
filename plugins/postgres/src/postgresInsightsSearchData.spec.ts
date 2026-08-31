import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  getPostgresInsightsReportOrderReady,
  readPostgresInsightsReportOrderRange,
  stepPostgresInsightsReportOrder,
} from "./postgresInsightsReportOrder";
import { savePostgresInsightsSearchMatches } from "./postgresInsightsSearchData";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const jobId = randomUUID();
const section = { section: "installationIds" } as const;
const match = (id: string) => ({
  installKey: hash(JSON.stringify(id)),
  event: { ...createBundleEventRowFixture("1", 1000), install_id: id },
});
const countKey = (id: string) =>
  hash(JSON.stringify(["installationIds", "", id, -1]));

describe("historical contains installation membership", () => {
  let client: PGlite;
  let db: Kysely<object>;
  let statements: string[];
  let returned: number;
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
  });
  afterEach(async () => {
    await db.destroy();
    await client.close();
  });
  const save = (
    matches: Parameters<typeof savePostgresInsightsSearchMatches>[2],
  ) =>
    db
      .transaction()
      .execute((tx) => savePostgresInsightsSearchMatches(tx, jobId, matches));
  const saved = async () =>
    (
      await sql<{ count_key: string; value: string; version: string }>`
    select count_key, value::text, xmin::text as version from private_hot_updater_insights_report_counts
    where job_id = ${jobId}::uuid order by count_key`.execute(db)
    ).rows;

  it("keeps repeated aliases and replay as one immutable membership without combining case-distinct install IDs", async () => {
    const matches = Array.from({ length: 200 }, (_, i) =>
      match(i % 2 ? "Install-A" : "install-a"),
    );
    await save(matches);
    expect(
      statements.filter((value) => !/^(begin|commit)/i.test(value)),
    ).toHaveLength(2);
    expect(returned).toBe(2);
    const first = await saved();
    expect(first).toHaveLength(2);
    expect(first.every((row) => row.value === "1")).toBe(true);
    await save(matches.reverse());
    expect(await saved()).toEqual(first);
  });

  it("sorts complete long install IDs in JS order after matching and keeps ordinal pages bounded", async () => {
    const labels = Array.from(
      { length: 137 },
      (_, i) =>
        `${"가".repeat(1500)}${["Z", "z", "😀", "\ue000"][i % 4]}${String(i).padStart(3, "0")}`,
    );
    await save(labels.map(match));
    for (let i = 0; i < 100; i++) {
      const result = await db
        .transaction()
        .execute((tx) => stepPostgresInsightsReportOrder(tx, jobId, section));
      expect(result.processed).toBeLessThanOrEqual(32);
      if (result.ready) break;
    }
    const ready = await getPostgresInsightsReportOrderReady(db, jobId, section);
    expect(ready).toEqual({ totalRows: "137", pass: "3" });
    const actual: string[] = [];
    for (let offset = 0; offset < 137; offset += 17) {
      const rows = await readPostgresInsightsReportOrderRange(
        db,
        jobId,
        section,
        ready!.pass,
        String(offset),
        17,
      );
      expect(rows).toHaveLength(Math.min(17, 137 - offset));
      expect(rows.every((row) => row.value === 1)).toBe(true);
      actual.push(...rows.map((row) => row.label));
    }
    expect(actual).toEqual(labels.sort());
  });

  it("rejects every corrupted membership field and rolls back newly inserted matches in that batch", async () => {
    const row = match("existing");
    for (const update of [
      { section: "bundleDistribution" },
      { metric: "installed" },
      { label: "wrong" },
      { bucket_start_ms: 0 },
      { value: 2 },
      { identity: ["installationIds", "", "wrong", -1] },
    ]) {
      await sql`delete from private_hot_updater_insights_report_counts`.execute(
        db,
      );
      await save([row]);
      const [field, value] = Object.entries(update)[0]!;
      await sql`update private_hot_updater_insights_report_counts set ${sql.ref(field)} = ${field === "identity" ? sql`${JSON.stringify(value)}::jsonb` : sql`${value}`}
        where job_id = ${jobId}::uuid and count_key = ${countKey("existing")}`.execute(
        db,
      );
      await expect(save([match("new"), row])).rejects.toMatchObject({
        code: "invalid-result",
      });
      expect((await saved()).map((row) => row.count_key)).toEqual([
        countKey("existing"),
      ]);
    }
  });

  it("rejects oversized, sparse and mismatched match batches before data writes; empty batches do no work", async () => {
    for (const [matches, code] of [
      [Array(201).fill(match("one")), "invalid-query"],
      [Array(1), "invalid-result"],
      [[{ ...match("one"), installKey: "invalid" }], "invalid-result"],
    ] as const) {
      statements = [];
      await expect(save(matches)).rejects.toMatchObject({ code });
      expect(
        statements.filter((value) => !/^(begin|rollback)/i.test(value)),
      ).toEqual([]);
    }
    statements = [];
    await save([]);
    expect(
      statements.filter((value) => !/^(begin|commit)/i.test(value)),
    ).toEqual([]);
  });
});
