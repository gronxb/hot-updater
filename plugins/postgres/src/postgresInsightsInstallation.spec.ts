import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";
import type {
  BundleEventRow,
  InsightsInstallationPageInput,
} from "@hot-updater/plugin-core";
import { databaseFields } from "@hot-updater/plugin-core/internal";
import { Kysely, sql } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";
import { createPostgresInsightsInstallationLookup } from "./postgresInsightsInstallation";

describe("live PostgreSQL exact installation lookup", () => {
  let client: PGlite;
  let db: Kysely<object>;
  let pages: ReturnType<typeof createPostgresInsightsInstallationLookup>;
  let statements: string[];
  let returned: number;
  beforeEach(async () => {
    client = new PGlite();
    await client.exec(
      await readFile("plugins/postgres/sql/bundles.sql", "utf8"),
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
    pages = createPostgresInsightsInstallationLookup(db);
  });
  afterEach(async () => {
    await db.destroy();
    await client.close();
  });
  const append = async (event: BundleEventRow) => {
    await sql`insert into bundle_events (${sql.join(databaseFields.bundle_events.map((field) => sql.ref(field)))})
      values (${sql.join(databaseFields.bundle_events.map((field) => event[field]))})`.execute(
      db,
    );
  };
  const lookup = (installId: string, limit = 100) =>
    pages.pageInstallation({ kind: "installation", installId, limit });

  it("returns the latest tuple across all event types, without report/source preparation or movement filtering", async () => {
    const movement = {
      from_bundle_id: "00000000-0000-0000-0000-000000000001",
      update_strategy: "appVersion" as const,
    };
    const rows: BundleEventRow[] = [
      {
        ...createBundleEventRowFixture("1", 1000),
        ...movement,
        type: "UPDATE_APPLIED" as const,
      },
      {
        ...createBundleEventRowFixture("2", 2000),
        ...movement,
        type: "RECOVERED" as const,
      },
      {
        ...createBundleEventRowFixture("3", 3000),
        ...movement,
        type: "RELEASE_ADOPTED" as const,
      },
      {
        ...createBundleEventRowFixture("4", 3000),
        type: "UNCHANGED" as const,
        from_bundle_id: null,
        update_strategy: null,
      },
      {
        ...createBundleEventRowFixture("5", Date.now() + 60_000),
        type: "UNCHANGED" as const,
        from_bundle_id: null,
        update_strategy: null,
      },
    ];
    for (const event of rows.toReversed())
      await append({
        ...event,
        install_id: "one-install",
        user_id: `user-${event.type}`,
      });
    statements = [];
    returned = 0;
    const result = await lookup("one-install");
    expect(result).toMatchObject({
      state: "ready",
      consistency: "live",
      nextCursor: null,
      observedAtMs: expect.any(Number),
      rows: [
        {
          id: rows[3]!.id,
          install_id: "one-install",
          type: "UNCHANGED",
          user_id: "user-UNCHANGED",
          received_at_ms: 3000,
        },
      ],
    });
    expect(statements).toHaveLength(2);
    expect(returned).toBe(2);
    expect(
      statements.some((statement) =>
        /offset|count\(|source_|report_/i.test(statement),
      ),
    ).toBe(false);
    if (result.state !== "ready") throw new Error("Expected live row.");
    expect(Object.keys(result.rows[0]!).sort()).toEqual(
      [
        "id",
        "install_id",
        "user_id",
        "username",
        "to_bundle_id",
        "type",
        "platform",
        "app_version",
        "channel",
        "cohort",
        "received_at_ms",
      ].sort(),
    );
    expect(result).not.toHaveProperty("total");
    expect(result).not.toHaveProperty("publication");
  });

  it("preserves empty, long, case-sensitive and Unicode identities without driver replacement matches", async () => {
    const ids = [
      "",
      "A",
      "a",
      "é",
      "e\u0301",
      "😀",
      "\ufffd",
      "x%_' OR TRUE --",
      "長".repeat(10_000),
    ];
    for (const [index, install_id] of ids.entries())
      await append({
        ...createBundleEventRowFixture(String(index + 1), 100),
        install_id,
      });
    for (const installId of ids) {
      expect(await lookup(installId, 1)).toMatchObject({
        rows: [{ install_id: installId }],
        nextCursor: null,
      });
    }
    for (const installId of ["not-present", "É", "\0", "\ud800", "\udfff"]) {
      statements = [];
      expect(await lookup(installId)).toMatchObject({
        state: "ready",
        rows: [],
        nextCursor: null,
      });
      if (!installId.isWellFormed() || installId.includes("\0"))
        expect(
          statements.some((statement) => /from bundle_events/i.test(statement)),
        ).toBe(false);
    }
  });

  it("rejects invalid fields and every supplied cursor before querying", async () => {
    const valid = { kind: "installation", installId: "a", limit: 1 } as const;
    for (const input of [
      null,
      [],
      { ...valid, kind: "all" },
      { ...valid, installId: 1 },
      { ...valid, limit: 0 },
      { ...valid, limit: 101 },
      { ...valid, limit: 1.5 },
      { ...valid, cursor: "" },
      { ...valid, cursor: "[]" },
      { ...valid, query: "a" },
      { ...valid, publicationId: "x" },
    ]) {
      await expect(
        pages.pageInstallation(
          input as Extract<
            InsightsInstallationPageInput,
            { kind: "installation" }
          >,
        ),
      ).rejects.toMatchObject({ code: "invalid-query" });
    }
    expect(statements).toEqual([]);
  });

  it("fails before raw reads when the warm index disappears or has incompatible order/collation", async () => {
    await append({ ...createBundleEventRowFixture("1", 100), install_id: "a" });
    expect(await lookup("a")).toMatchObject({ rows: [{ install_id: "a" }] });
    await client.exec("drop index bundle_events_install_idx");
    for (const replacement of [
      null,
      "create index bundle_events_install_idx on bundle_events(install_id, received_at_ms asc, id desc)",
      'create index bundle_events_install_idx on bundle_events(install_id collate "C", received_at_ms, id)',
    ]) {
      if (replacement) await client.exec(replacement);
      statements = [];
      await expect(lookup("a")).rejects.toMatchObject({
        code: "INSIGHTS_QUERY_NOT_READY",
      });
      expect(statements).toHaveLength(1);
      expect(statements[0]).not.toMatch(/from bundle_events\b/i);
      if (replacement)
        await client.exec("drop index bundle_events_install_idx");
    }
    await client.exec(
      "create index bundle_events_install_idx on bundle_events(install_id, received_at_ms, id)",
    );
    expect(await lookup("a")).toMatchObject({ rows: [{ install_id: "a" }] });
  });

  it("rejects invalid latest data rather than filtering it into an empty result", async () => {
    await append({ ...createBundleEventRowFixture("1", 100), install_id: "a" });
    await client.exec("update bundle_events set received_at_ms=100.5");
    await expect(lookup("a")).rejects.toMatchObject({ code: "invalid-result" });
  });
});
