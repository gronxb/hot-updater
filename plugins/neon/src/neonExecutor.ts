import type {
  SqlExecutor,
  SqlResult,
  SqlStatement,
} from "@hot-updater/plugin-core";
import type {
  FullQueryResults,
  NeonQueryFunction,
} from "@neondatabase/serverless";

/** Commands whose `rowCount` counts changed rows. A SELECT's counts the rows it returned. */
const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);

const toSqlResult = ({
  command,
  rowCount,
  rows,
}: FullQueryResults<false>): SqlResult => ({
  rows,
  changes: WRITES.has(command) ? Number(rowCount ?? 0) : 0,
});

/**
 * The SQL core's executor over Neon's HTTP driver: each statement is one
 * HTTPS request, and a batch is one non-interactive transaction in one
 * request. Neon's errors carry the SQLSTATE in `code`, which the SQL core
 * classifies.
 */
export const neonExecutor = (
  sql: NeonQueryFunction<false, true>,
): SqlExecutor => {
  const query = ({ sql: text, params }: SqlStatement) =>
    sql.query(text, [...params]);
  return {
    dialect: "postgresql",
    execute: async (statement) => toSqlResult(await query(statement)),
    batch: async (statements) =>
      statements.length === 0
        ? []
        : (await sql.transaction(statements.map(query))).map(toSqlResult),
    transaction: () => {
      throw new Error(
        "Neon's HTTP driver has no interactive transactions. Writes are batches.",
      );
    },
  };
};
