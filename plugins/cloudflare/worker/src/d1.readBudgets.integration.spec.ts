import { toolingTargetOf } from "@hot-updater/plugin-core";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";
import { setupReadBudgetTestSuite } from "@hot-updater/test-utils";
import type { RowsExamined } from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import { inject } from "vitest";

import { d1SchemaSql } from "../../src/d1Schema";
import { d1Database, type D1Like } from "../../src/worker";

/**
 * The binding, and D1's `rows_read` for each SELECT it runs outside a batch
 * while counting: the reads of the SQL core. D1 reads a batch get's key list
 * and a multi-valued index's own table beside each row it returns, and one
 * row past the end of a range.
 */
const rowsRead = (database: D1Database) => {
  const statements = new WeakMap<object, D1PreparedStatement>();
  let counting = false;
  let read = 0;
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
    batch: (bound) =>
      database.batch(bound.map((statement) => statements.get(statement)!)),
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
  return { binding, examined };
};

const plugins = [insights(), apiKeys()];

/**
 * The worker's `d1Database` on the D1 binding. Its schema fence reads the
 * settings rows the migrations write once, while the suite seeds: the
 * package's, with core's tables, and the one init writes for the plugins.
 */
setupReadBudgetTestSuite({
  name: "d1 (workerd)",
  createAdapter: async () => {
    const [migration] = inject("d1Migrations");
    for (const sql of [migration!.sql, d1SchemaSql(toolingTargetOf(plugins))]) {
      // `exec` runs one statement per line, and a comment line is not one.
      await env.DB.exec(
        sql
          .split("\n")
          .filter((line) => line.trim() !== "" && !line.startsWith("--"))
          .join("\n"),
      );
    }
    const { binding, examined } = rowsRead(env.DB);
    return { adapter: d1Database(binding).adapter, examined };
  },
});
