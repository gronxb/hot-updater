import type { SqlResult, SqlStatement } from "@hot-updater/plugin-core";

import { d1MigrationStatements } from "./d1Schema";

/**
 * The table `wrangler d1 migrations apply` records each migration it ran
 * in, by file name: what the managed Worker's init applies them with.
 */
const MIGRATIONS_TABLE = "d1_migrations";

/** The migration every managed database ran first: init's. */
const FIRST_MIGRATION = "0001_hot-updater_1.0.0.sql";

/** A migration file of the managed Worker: its name and SQL. */
export interface D1Migration {
  readonly name: string;
  readonly sql: string;
}

/**
 * Runs the managed migrations a D1 database has not run, in the order of
 * their names, as `wrangler d1 migrations apply` does: each one's statements
 * and its record in `d1_migrations` in one batch, which D1 runs in one
 * transaction, so init later skips it. A database whose records lack the
 * first migration is not one the managed init created, and is left alone.
 */
export const applyD1Migrations = async (
  runner: {
    query(statement: SqlStatement): Promise<SqlResult>;
    batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
  },
  migrations: readonly D1Migration[],
): Promise<{ applied: string[] } | { skip: string; unmanaged: true }> => {
  let ran: Set<string>;
  try {
    const { rows } = await runner.query({
      sql: `SELECT name FROM ${MIGRATIONS_TABLE}`,
      params: [],
    });
    ran = new Set(rows.map(({ name }) => String(name)));
  } catch (error) {
    if (!/no such table/iu.test(String(error))) throw error;
    ran = new Set();
  }
  if (!ran.has(FIRST_MIGRATION)) {
    return {
      skip: `The D1 database has no record of ${FIRST_MIGRATION}, so \`hot-updater init\` did not create it. Run \`npx hot-updater db migrate\` in the server's project, or \`npx hot-updater db generate\` and apply the migration it writes with \`wrangler d1 migrations apply\`.`,
      unmanaged: true,
    };
  }
  const pending = migrations
    .filter(({ name }) => !ran.has(name))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  for (const { name, sql } of pending) {
    await runner.batch([
      ...d1MigrationStatements(sql).map((statement) => ({
        sql: statement,
        params: [],
      })),
      {
        sql: `INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`,
        params: [name],
      },
    ]);
  }
  return { applied: pending.map(({ name }) => name) };
};
