import type { PGlite } from "@electric-sql/pglite";
import type {
  FullQueryResults,
  NeonQueryFunction,
} from "@neondatabase/serverless";

/** A query the driver sends when awaited, or as part of a transaction. */
interface PendingQuery extends PromiseLike<FullQueryResults<false>> {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** One statement as Neon's SQL-over-HTTP endpoint answers it, with `fullResults`. */
const run = async (
  runner: Pick<PGlite, "query">,
  { text, params }: Pick<PendingQuery, "text" | "params">,
): Promise<FullQueryResults<false>> => {
  const { rows, affectedRows } = await runner.query<Record<string, unknown>>(
    text,
    [...params],
  );
  const command = /^\s*(\w+)/u.exec(text)![1]!.toUpperCase();
  return {
    command,
    // Like pg, Neon counts a SELECT's returned rows.
    rowCount: command === "SELECT" ? rows.length : (affectedRows ?? 0),
    rows,
    fields: [],
    rowAsArray: false,
  };
};

/**
 * Neon's HTTP driver over PGlite: `query` runs when awaited, and
 * `transaction` runs its queries in order in one transaction, as Neon runs a
 * non-interactive transaction.
 */
export const pgliteNeon = (db: PGlite): NeonQueryFunction<false, true> => {
  const query = (text: string, params: readonly unknown[] = []) => {
    const pending: PendingQuery = {
      text,
      params,
      then: (onFulfilled, onRejected) =>
        run(db, pending).then(onFulfilled, onRejected),
    };
    return pending;
  };
  const transaction = (queries: readonly PendingQuery[]) =>
    db.transaction(async (tx) => {
      const results: FullQueryResults<false>[] = [];
      for (const pending of queries) results.push(await run(tx, pending));
      return results;
    });
  return { query, transaction } as unknown as NeonQueryFunction<false, true>;
};
