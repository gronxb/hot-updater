import { setupReadBudgetTestSuite } from "@hot-updater/test-utils";
import type { RowsExamined } from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import { inject } from "vitest";

import { d1Database, type D1Like } from "../../src/worker";

/**
 * The binding, and D1's `rows_read` for each SELECT it runs outside a batch
 * while counting: the reads of the SQL core. D1 reads a batch get's key list
 * and a multi-valued index's own table beside each row it returns, and one
 * row past the end of a range. `written` keeps each batch statement's
 * `rows_read`: the SQL core's writes and prunes, which D1 bills the same.
 */
const rowsRead = (database: D1Database) => {
  const statements = new WeakMap<object, D1PreparedStatement>();
  let counting = false;
  let read = 0;
  let writing = false;
  let readByWrites: number[] = [];
  const binding: D1Like = {
    prepare: (sql) => ({
      bind: (...params) => {
        const statement = database.prepare(sql).bind(...params);
        const bound = {
          all: async () => {
            const result = await statement.all();
            if (counting && /^\s*SELECT\b/iu.test(sql)) {
              read += result.meta.rows_read;
            }
            return result;
          },
        };
        statements.set(bound, statement);
        return bound;
      },
    }),
    batch: async (bound) => {
      const results = await database.batch(
        bound.map((statement) => statements.get(statement)!),
      );
      if (writing) {
        readByWrites.push(...results.map(({ meta }) => meta.rows_read));
      }
      return results;
    },
  };
  const examined: RowsExamined = {
    reset() {
      counting = true;
      read = 0;
    },
    async total() {
      counting = false;
      return read;
    },
    perRow: 2,
    perRead: 1,
  };
  const written = {
    reset() {
      writing = true;
      readByWrites = [];
    },
    async rows() {
      writing = false;
      return readByWrites;
    },
  };
  return { binding, examined, written };
};

/**
 * The worker's `d1Database` on the D1 binding. Its schema fence reads the
 * settings rows the migration writes once, while the suite seeds.
 */
setupReadBudgetTestSuite({
  name: "d1 (workerd)",
  createAdapter: async () => {
    const [migration] = inject("d1Migrations");
    // `exec` runs one statement per line, and a comment line is not one.
    await env.DB.exec(
      migration!.sql
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("--"))
        .join("\n"),
    );
    const { binding, examined, written } = rowsRead(env.DB);
    return { adapter: d1Database(binding).adapter, examined, written };
  },
});
