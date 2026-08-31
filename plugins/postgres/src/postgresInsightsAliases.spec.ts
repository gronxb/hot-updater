import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import type { BundleEventRow } from "@hot-updater/plugin-core";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import {
  readPostgresInsightsAliasPage,
  savePostgresInsightsAliases,
} from "./postgresInsightsAliases";

const table = "private_hot_updater_insights_report_aliases";
const jobId = "00000000-0000-0000-0000-000000000001";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const event = (overrides: Partial<BundleEventRow> = {}): BundleEventRow =>
  ({
    ...createBundleEventRowFixture("1", 1000),
    user_id: "User-A",
    username: " İÉ ",
    ...overrides,
  }) as BundleEventRow;

describe("immutable PostgreSQL historical installation aliases", () => {
  let client: PGlite;
  let db: Kysely<object>;
  const save = (row: BundleEventRow) =>
    db
      .transaction()
      .execute((tx) => savePostgresInsightsAliases(tx, jobId, row));
  const snapshot = () =>
    client.query(
      `select alias_key,install_key,identity,xmin::text,ctid::text from ${table} order by alias_key`,
    );
  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      await readFile("plugins/postgres/sql/insights-aliases-v1.sql", "utf8"),
    );
    db = new Kysely<object>({ dialect: new PGliteDialect(client) });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
  });

  it("retains historical names, lowers whole fields without trim or NFC, and separates installations", async () => {
    await save(event({ install_id: "Install-A" }));
    await save(
      event({
        install_id: "Install-A",
        user_id: "USER-a",
        username: " I\u0307E\u0301 ",
      }),
    );
    await save(event({ install_id: "Install-a" }));
    const rows = [];
    let after: string | null = null;
    for (;;) {
      const page = await readPostgresInsightsAliasPage(db, jobId, after, 2);
      rows.push(...page);
      if (page.length < 2) break;
      after = page.at(-1)!.aliasKey;
    }
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.aliasKey)).toEqual(
      rows.map((row) => row.aliasKey).sort(),
    );
    expect(
      rows
        .filter(
          (row) => row.kind === "username" && row.installId === "Install-A",
        )
        .map((row) => row.normalizedAlias)
        .sort(),
    ).toEqual([" i\u0307e\u0301 ", " i\u0307é "]);
    expect(
      rows
        .filter((row) => row.kind === "installation")
        .map((row) => row.normalizedAlias),
    ).toEqual(["install-a", "install-a"]);
    for (const row of rows) {
      expect(row.aliasKey).toBe(
        hash(JSON.stringify([row.kind, row.normalizedAlias, row.installId])),
      );
      expect(row.installKey).toBe(hash(JSON.stringify(row.installId)));
    }
    expect(new Set(rows.map((row) => row.installKey)).size).toBe(2);
  });

  it("does not rewrite alias versions on repeated activity and stays within two SQL requests", async () => {
    const row = event();
    await save(row);
    const before = (await snapshot()).rows;
    const calls = vi.spyOn(client, "query");
    await save({ ...row, received_at_ms: 2000 });
    const operations = await Promise.all(
      calls.mock.results.map(async (result, i) => ({
        sql: calls.mock.calls[i]![0],
        rows: ((await result.value) as { rows: unknown[] }).rows.length,
      })),
    );
    const data = operations.filter(({ sql }) => !/^(begin|commit)/i.test(sql));
    expect(data).toHaveLength(2);
    expect(data.reduce((sum, result) => sum + result.rows, 0)).toBe(3);
    expect((await snapshot()).rows).toEqual(before);
  });

  it("preserves long and escaped identity payloads without indexing full values", async () => {
    const prefix = Array.from({ length: 96 }, (_, i) => hash(String(i))).join(
      "",
    );
    const row = event({
      install_id: `${prefix}\ud800\u0000A`,
      user_id: `${prefix}😀Ü`,
      username: "",
    });
    await save(row);
    await save(row);
    const rows = await readPostgresInsightsAliasPage(db, jobId, null, 200);
    expect(rows).toHaveLength(3);
    expect(
      rows.find((alias) => alias.kind === "installation")?.normalizedAlias,
    ).toBe(row.install_id.toLowerCase());
    expect(rows.find((alias) => alias.kind === "user")?.normalizedAlias).toBe(
      row.user_id!.toLowerCase(),
    );
    expect(
      rows.find((alias) => alias.kind === "username")?.normalizedAlias,
    ).toBe("");
    expect(rows.every((alias) => alias.installId === row.install_id)).toBe(
      true,
    );
    expect(Buffer.byteLength(row.install_id)).toBeGreaterThan(6000);
  });

  it("omits null aliases and preserves the same value in distinct alias kinds", async () => {
    await save(event({ install_id: "same", user_id: null, username: null }));
    expect(
      await readPostgresInsightsAliasPage(db, jobId, null, 200),
    ).toHaveLength(1);
    await save(
      event({ install_id: "same", user_id: "SAME", username: "Same" }),
    );
    const rows = await readPostgresInsightsAliasPage(db, jobId, null, 200);
    expect(rows.map((row) => row.kind).sort()).toEqual([
      "installation",
      "user",
      "username",
    ]);
    expect(rows.every((row) => row.normalizedAlias === "same")).toBe(true);
  });

  it("rolls back both new aliases and the caller checkpoint on an identity collision", async () => {
    await save(event());
    await client.exec(
      "create table checkpoint(sequence integer not null); insert into checkpoint values(0)",
    );
    const userKey = hash(JSON.stringify(["user", "user-a", "install-1"]));
    await client.query(
      `update ${table} set identity=$1::json where alias_key=$2`,
      [JSON.stringify(["user", "different", "install-1"]), userKey],
    );
    const before = (await snapshot()).rows;
    await expect(
      db.transaction().execute(async (tx) => {
        await sql`update checkpoint set sequence=1`.execute(tx);
        await savePostgresInsightsAliases(
          tx,
          jobId,
          event({ username: "new historical name" }),
        );
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
    expect((await snapshot()).rows).toEqual(before);
    expect(
      (await client.query("select sequence from checkpoint")).rows,
    ).toEqual([{ sequence: 0 }]);
    await client.query(
      `update ${table} set identity=$1::json where alias_key=$2`,
      [JSON.stringify(["user", "user-a", "install-1"]), userKey],
    );
    await save(event({ username: "new historical name" }));
    expect(
      await readPostgresInsightsAliasPage(db, jobId, null, 200),
    ).toHaveLength(4);
  });

  it("can replay a source step after interruption without a partial alias snapshot", async () => {
    await expect(
      db.transaction().execute(async (tx) => {
        await savePostgresInsightsAliases(tx, jobId, event());
        throw new Error("interrupted before checkpoint commit");
      }),
    ).rejects.toThrow("interrupted before checkpoint commit");
    expect((await snapshot()).rows).toEqual([]);
    await save(event());
    await save(event());
    expect(
      await readPostgresInsightsAliasPage(db, jobId, null, 200),
    ).toHaveLength(3);
  });

  it("rejects bad page arguments before querying storage", async () => {
    const calls = vi.spyOn(client, "query");
    for (const [job, after, limit] of [
      ["invalid", null, 1],
      [jobId, "ABC", 1],
      [jobId, null, 0],
      [jobId, null, 201],
      [jobId, null, 1.5],
      [jobId, null, NaN],
    ] as const) {
      await expect(
        readPostgresInsightsAliasPage(db, job, after, limit),
      ).rejects.toMatchObject({ code: "invalid-query" });
    }
    expect(calls).not.toHaveBeenCalled();
    await db.transaction().execute(async (tx) => {
      calls.mockClear();
      await expect(
        savePostgresInsightsAliases(tx, jobId, event({ received_at_ms: 1.5 })),
      ).rejects.toMatchObject({ code: "invalid-result" });
      expect(calls).not.toHaveBeenCalled();
    });
  });

  it.each(["identity", "install_key"])(
    "rejects corrupted %s before exposing an alias",
    async (column) => {
      await save(event());
      if (column === "identity")
        await client.query(`update ${table} set identity=$1::json`, [
          JSON.stringify(["user", "UPPERCASE", "install-1"]),
        ]);
      else await client.exec(`update ${table} set install_key='wrong'`);
      await expect(
        readPostgresInsightsAliasPage(db, jobId, null, 200),
      ).rejects.toMatchObject({ code: "invalid-result" });
    },
  );

  it("rejects absent or reversed primary keys before reading alias rows", async () => {
    await save(event());
    await client.exec(`alter table ${table} drop constraint ${table}_pkey`);
    const calls = vi.spyOn(client, "query");
    await expect(
      readPostgresInsightsAliasPage(db, jobId, null, 200),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(
      calls.mock.calls.some(([query]) => /order by alias_key/.test(query)),
    ).toBe(false);
    await client.exec(`alter table ${table} add primary key(alias_key,job_id)`);
    calls.mockClear();
    await expect(
      readPostgresInsightsAliasPage(db, jobId, null, 200),
    ).rejects.toMatchObject({ code: "INSIGHTS_QUERY_NOT_READY" });
    expect(
      calls.mock.calls.some(([query]) => /order by alias_key/.test(query)),
    ).toBe(false);
  });
});
