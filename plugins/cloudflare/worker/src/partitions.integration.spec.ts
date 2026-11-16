// Not the package index: it loads Node-only helpers workerd lacks.
import { setupKeyOrderTestSuite } from "@hot-updater/test-utils";
import { applyD1Migrations, env } from "cloudflare:test";
import { expect, inject } from "vitest";

import { d1MigrationStatements } from "../../src/d1Schema";
import { d1Database } from "../../src/worker";

const PARTITIONS = "release_catalog_partitions";

/** A migration as `exec` runs it: one statement per line, and a comment line is not one. */
const execable = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("--"))
    .join("\n");

const recordedMigrations = async () =>
  (
    await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{
      name: string;
    }>()
  ).results.map(({ name }) => name);

const hasPartitions = async () =>
  (
    await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
    )
      .bind(PARTITIONS)
      .all()
  ).results.length === 1;

/** Drops every table the migrations created, so the next suite starts empty. */
const dropAll = async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  await env.DB.batch(
    results.map(({ name }) => env.DB.prepare(`DROP TABLE "${name}"`)),
  );
};

/**
 * The managed migrations as `wrangler d1 migrations apply` runs them on a new
 * database, and the managed server's adapter: the table's keys are D1's
 * default BINARY collation.
 */
setupKeyOrderTestSuite({
  name: "d1 (workerd), the managed migrations",
  createAdapter: async () => {
    await applyD1Migrations(
      env.DB,
      inject("d1Migrations").map(({ name, sql }) => ({
        name,
        queries: d1MigrationStatements(sql),
      })),
    );
    expect(await hasPartitions()).toBe(true);
    return { adapter: d1Database(env.DB).adapter, cleanup: dropAll };
  },
});

/**
 * A database a 1.2 prerelease initialized: `d1_migrations` records 0002
 * without the table, so `wrangler d1 migrations apply` runs nothing, and the
 * release notes' step runs the file by hand, as
 * `wrangler d1 execute <db> --remote --file .../0002_hot-updater_1.2.0.sql`
 * does. Run twice, it creates the table once and changes nothing else.
 */
setupKeyOrderTestSuite({
  name: "d1 (workerd), a prerelease's database after the by-hand step, run twice",
  createAdapter: async () => {
    const migrations = inject("d1Migrations");
    const latest = migrations.at(-1)!;
    expect(latest.name).toBe("0002_hot-updater_1.2.0.sql");
    const prerelease = migrations.map(({ name, sql }) => ({
      name,
      queries: d1MigrationStatements(sql).filter(
        (statement) => !statement.includes(`"${PARTITIONS}"`),
      ),
    }));
    expect(prerelease.at(-1)!.queries.length).toBe(
      d1MigrationStatements(latest.sql).length - 1,
    );
    await applyD1Migrations(env.DB, prerelease);
    expect(await hasPartitions()).toBe(false);
    // `migrations apply` has nothing to run: 0002 is recorded.
    await applyD1Migrations(
      env.DB,
      migrations.map(({ name, sql }) => ({
        name,
        queries: d1MigrationStatements(sql),
      })),
    );
    expect(await hasPartitions()).toBe(false);
    const settings = () =>
      env.DB.prepare(
        "SELECT key, value FROM private_hot_updater_settings ORDER BY key",
      ).all();
    const before = (await settings()).results;
    const recorded = await recordedMigrations();

    await env.DB.exec(execable(latest.sql));
    await env.DB.exec(execable(latest.sql));

    expect(await hasPartitions()).toBe(true);
    expect((await settings()).results).toEqual(before);
    expect(await recordedMigrations()).toEqual(recorded);
    return { adapter: d1Database(env.DB).adapter, cleanup: dropAll };
  },
});
