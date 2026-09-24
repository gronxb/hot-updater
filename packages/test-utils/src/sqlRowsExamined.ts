/**
 * Rows a SQL database examined for the reads a storage adapter made: what
 * read-budget suites compare with the rows the adapter read.
 */
export interface RowsExamined {
  /** Counts the reads from now on, and only those. */
  reset(): void;
  /** Rows examined for the reads since `reset`. */
  total(): Promise<number>;
  /** Rows the backend examines natively for each row it returns (default 1). */
  readonly perRow?: number;
  /** Rows the backend examines natively for each read beyond those (default 0). */
  readonly perRead?: number;
}

/** A statement as the SQL core runs it. */
export interface SqlStatementLike {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A SQL core executor: its top-level `execute` runs the adapter's reads. */
export interface SqlExecutorLike {
  execute(statement: SqlStatementLike): Promise<unknown>;
}

/** Runs one statement on the session reads are explained on. */
export type SqlQuery = (
  sql: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/** Wraps executors so each read they run while counting is examined first. */
const examineReads = (hooks: {
  readonly examine: (statement: SqlStatementLike) => Promise<number>;
  readonly onReset?: () => void;
}) => {
  let counting = false;
  let examined = 0;
  return {
    /** The executor, examining each SELECT it runs outside a transaction. */
    wrap: <T extends SqlExecutorLike>(executor: T): T => ({
      ...executor,
      async execute(statement: SqlStatementLike) {
        if (counting && /^\s*SELECT\b/iu.test(statement.sql)) {
          // Reads run concurrently: add once this one's count is known.
          const rows = await hooks.examine(statement);
          examined += rows;
        }
        return executor.execute(statement);
      },
    }),
    examined: {
      reset() {
        counting = true;
        examined = 0;
        hooks.onReset?.();
      },
      async total() {
        counting = false;
        return examined;
      },
    } satisfies RowsExamined,
  };
};

interface PostgresPlanNode {
  readonly "Relation Name"?: string;
  readonly Alias?: string;
  readonly "Actual Rows"?: number;
  readonly "Actual Loops"?: number;
  readonly "Rows Removed by Filter"?: number;
  readonly "Rows Removed by Index Recheck"?: number;
  readonly Plans?: readonly PostgresPlanNode[];
}

/** Rows each table read of a plan examined: rows it produced, filtered out, or rechecked away, over all its loops. */
const postgresTableReads = (
  node: PostgresPlanNode,
  reads = new Map<string, number>(),
): Map<string, number> => {
  const relation = node["Relation Name"];
  if (relation !== undefined) {
    const table = node.Alias ?? relation;
    const rows =
      (node["Actual Rows"] ?? 0) +
      (node["Rows Removed by Filter"] ?? 0) +
      (node["Rows Removed by Index Recheck"] ?? 0);
    reads.set(
      table,
      (reads.get(table) ?? 0) + rows * (node["Actual Loops"] ?? 0),
    );
  }
  for (const child of node.Plans ?? []) postgresTableReads(child, reads);
  return reads;
};

/**
 * Planner settings under which a test's small tables plan as production-sized
 * ones: no sequential scan, which only a small table affords, and an index
 * entry weighted like a row, so a plan reads no more entries than the read
 * needs, as a large index forces. With fresh statistics a plan then takes
 * the index path a production-sized table takes, and a read no index serves
 * still scans.
 */
const POSTGRES_PLANNER = ["enable_seqscan = off", "cpu_index_tuple_cost = 1"];

/**
 * Rows examined on PostgreSQL (PGlite or a server). Each SELECT a wrapped
 * executor runs is first run under `EXPLAIN (ANALYZE, FORMAT JSON)` on
 * `query`, one session with the planner settings above, after an ANALYZE
 * per `reset`. A statement counts the rows its busiest table read examined,
 * so an exact plan counts the rows it returns, a multi-valued index's own
 * table included.
 */
export const postgresRowsExamined = (query: SqlQuery) => {
  let planner: Promise<void> | undefined;
  let stale = true;
  return examineReads({
    onReset: () => {
      stale = true;
    },
    async examine({ sql, params }) {
      planner ??= (async () => {
        for (const setting of POSTGRES_PLANNER) {
          await query(`SET ${setting}`, []);
        }
      })();
      await planner;
      if (stale) {
        stale = false;
        await query("ANALYZE", []);
      }
      const [row] = await query(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
        params,
      );
      const output = row?.["QUERY PLAN"];
      const [plan] = (
        typeof output === "string" ? JSON.parse(output) : output
      ) as readonly { readonly Plan: PostgresPlanNode }[];
      return Math.max(0, ...postgresTableReads(plan!.Plan).values());
    },
  });
};

/** An `EXPLAIN ANALYZE` iterator that reads a table: its table, and its actual rows and loops. */
const MYSQL_TABLE_READ =
  /-> (?:Table scan|(?:Covering )?[Ii]ndex (?:scan|lookup|range scan|skip scan)|Single-row (?:covering )?index lookup|Multi-range index scan) on (\S+).*\(actual time=[\d.e+-]+\.\.[\d.e+-]+ rows=([\d.e+-]+) loops=(\d+)\)/u;

/**
 * Rows examined on MySQL. Each SELECT a wrapped executor runs is first run
 * under `EXPLAIN ANALYZE` on `query`, and counts the rows its busiest table
 * read examined; a filter above a table read drops rows that read produced.
 */
export const mysqlRowsExamined = (query: SqlQuery) =>
  examineReads({
    async examine({ sql, params }) {
      const [row] = await query(`EXPLAIN ANALYZE ${sql}`, params);
      const reads = new Map<string, number>();
      for (const line of String(Object.values(row ?? {})[0]).split("\n")) {
        const read = MYSQL_TABLE_READ.exec(line);
        if (read === null) continue;
        const [, table, rows, loops] = read;
        reads.set(
          table!,
          (reads.get(table!) ?? 0) + Number(rows) * Number(loops),
        );
      }
      return Math.max(0, ...reads.values());
    },
  });
