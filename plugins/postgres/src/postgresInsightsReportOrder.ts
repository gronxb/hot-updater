import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
} from "@hot-updater/plugin-core";
import { sql, type QueryExecutorProvider, type Transaction } from "kysely";

const counts = "private_hot_updater_insights_report_counts";
const states = "private_hot_updater_insights_report_order_states";
const runs = "private_hot_updater_insights_report_order_rows";
const maximum = 9_223_372_036_854_775_807n;
const decimal = /^(0|[1-9][0-9]{0,18})$/;
const hash = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runSize = 32;

export type PostgresInsightsReportOrderSection =
  | {
      readonly section: "movementCohorts";
      readonly metric: "installed" | "recovered";
    }
  | { readonly section: "bundleDistribution" | "activeBundleTotals" };

export interface PostgresInsightsReportOrderRow {
  readonly ordinal: string;
  readonly label: string;
  readonly value: number;
  readonly countKey: string;
}
type Scope = {
  section: PostgresInsightsReportOrderSection["section"];
  metric: string;
};
type State = {
  phase: "copy" | "merge" | "ready";
  afterCountKey: string | null;
  total: bigint;
  pass: bigint;
  pair: bigint;
  left: bigint;
  right: bigint;
  out: bigint;
};
type StoredState = {
  phase: State["phase"];
  after_count_key: string | null;
  total_rows: string;
  sort_pass: string;
  pair: string;
  left_pos: string;
  right_pos: string;
  out_pos: string;
};
type StoredRow = {
  ordinal: string;
  label: string;
  value: string;
  count_key: string;
};
const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};
const integer = (value: unknown): bigint => {
  if (typeof value !== "string" || !decimal.test(value)) return invalid();
  const parsed = BigInt(value);
  if (parsed > maximum) return invalid();
  return parsed;
};
const passNumber = (value: unknown): bigint => {
  const pass = integer(value);
  if (pass > 58n) return invalid();
  return pass;
};
const inputInteger = (value: string, pass = false): bigint => {
  try {
    return pass ? passNumber(value) : integer(value);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
};
const capacity = (pass: bigint): bigint => 32n << pass;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const ceiling = (n: bigint, divisor: bigint) => (n + divisor - 1n) / divisor;
const finalPass = (total: bigint): bigint => {
  let pass = 0n;
  while (capacity(pass) < total) pass++;
  return pass;
};
const scope = (
  jobId: string,
  descriptor: PostgresInsightsReportOrderSection,
): Scope => {
  if (
    typeof jobId !== "string" ||
    !uuid.test(jobId) ||
    typeof descriptor !== "object" ||
    descriptor === null
  )
    throw new DatabasePluginInputError("invalid-query");
  if (
    descriptor.section === "movementCohorts" &&
    Object.keys(descriptor).every(
      (key) => key === "section" || key === "metric",
    ) &&
    (descriptor.metric === "installed" || descriptor.metric === "recovered")
  )
    return descriptor;
  if (
    (descriptor.section === "bundleDistribution" ||
      descriptor.section === "activeBundleTotals") &&
    Object.keys(descriptor).every((key) => key === "section")
  )
    return { section: descriptor.section, metric: "" };
  throw new DatabasePluginInputError("invalid-query");
};
const predicate = (jobId: string, descriptor: Scope) =>
  sql`job_id = ${jobId}::uuid and section = ${descriptor.section} and metric = ${descriptor.metric}`;

export const assertPostgresInsightsReportOrderIndexes = async (
  db: QueryExecutorProvider,
): Promise<void> => {
  const required = [
    [
      counts,
      "insights_report_counts_order_input_idx",
      false,
      ["job_id", "section", "metric", "count_key"],
    ],
    [states, `${states}_pkey`, true, ["job_id", "section", "metric"]],
    [
      runs,
      `${runs}_pkey`,
      true,
      [
        "job_id",
        "section",
        "metric",
        "sort_pass",
        "run_number",
        "row_position",
      ],
    ],
  ] as const;
  const result = await sql<{ ready: boolean }>`select bool_and(exists (
    select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam
    where i.indexrelid = to_regclass(required.index_name) and i.indrelid = to_regclass(required.table_name)
      and i.indisvalid and i.indisready and i.indisunique = required.is_unique
      and i.indnkeyatts = cardinality(required.columns) and i.indnatts = cardinality(required.columns)
      and i.indexprs is null and am.amname = 'btree'
      and case when required.index_name = 'insights_report_counts_order_input_idx'
        then pg_get_expr(i.indpred, i.indrelid) = '(section = ANY (ARRAY[''movementCohorts''::text, ''bundleDistribution''::text, ''activeBundleTotals''::text]))'
        else i.indpred is null end
      and not exists (select 1 from unnest(required.columns) with ordinality col(name, position)
        where pg_get_indexdef(i.indexrelid, col.position::int, false) <> col.name)
      and not exists (select 1 from unnest(i.indoption) bits where bits <> 0)
      and not exists (select 1 from unnest(i.indclass) class_id join pg_opclass opclass on opclass.oid = class_id where not opclass.opcdefault)
      and not exists (select 1 from unnest(i.indcollation) collation_id
        join pg_collation co on co.oid = collation_id where co.collname <> 'C')
  )) as ready from (values ${sql.join(required.map(([table, index, unique, columns]) => sql`(${table}::text, ${index}::text, ${unique}::boolean, array[${sql.join(columns)}]::text[])`))})
    required(table_name, index_name, is_unique, columns)`.execute(db);
  if (!result.rows[0]?.ready) throw new InsightsQueryNotReadyError();
};

const parseState = (row: StoredState): State => {
  const state: State = {
    phase: row.phase,
    afterCountKey: row.after_count_key,
    total: integer(row.total_rows),
    pass: passNumber(row.sort_pass),
    pair: integer(row.pair),
    left: integer(row.left_pos),
    right: integer(row.right_pos),
    out: integer(row.out_pos),
  };
  if (
    state.total === 0n
      ? state.afterCountKey !== null
      : typeof state.afterCountKey !== "string" ||
        !hash.test(state.afterCountKey)
  )
    invalid();
  if (state.phase === "copy") {
    if (
      state.total % 32n !== 0n ||
      state.pass !== 0n ||
      state.pair !== 0n ||
      state.left !== 0n ||
      state.right !== 0n ||
      state.out !== 0n
    )
      invalid();
  } else if (state.phase === "ready") {
    if (
      state.pass !== finalPass(state.total) ||
      state.pair !== 0n ||
      state.left !== 0n ||
      state.right !== 0n ||
      state.out !== 0n
    )
      invalid();
  } else if (state.phase === "merge") {
    if (
      state.total <= 32n ||
      state.pass === 0n ||
      state.pass > finalPass(state.total)
    )
      invalid();
    const width = capacity(state.pass);
    if (state.pair >= ceiling(state.total, width)) invalid();
    const leftLength = min(width / 2n, state.total - state.pair * width);
    const rightLength = min(
      width / 2n,
      state.total - state.pair * width - leftLength,
    );
    if (
      state.left > leftLength ||
      state.right > rightLength ||
      state.out !== state.left + state.right ||
      state.out >= leftLength + rightLength
    )
      invalid();
  } else invalid();
  return state;
};
const readState = async (
  db: QueryExecutorProvider,
  jobId: string,
  descriptor: Scope,
  lock: boolean,
): Promise<State | null> => {
  const result =
    await sql<StoredState>`select phase, after_count_key, total_rows::text, sort_pass::text,
    pair::text, left_pos::text, right_pos::text, out_pos::text from ${sql.table(states)}
    where ${predicate(jobId, descriptor)} ${lock ? sql`for update` : sql``}`.execute(
      db,
    );
  return result.rows[0] === undefined ? null : parseState(result.rows[0]);
};
const compare = (
  descriptor: Scope,
  a: PostgresInsightsReportOrderRow,
  b: PostgresInsightsReportOrderRow,
): number => {
  if (descriptor.section !== "movementCohorts" && a.value !== b.value)
    return a.value > b.value ? -1 : 1;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
};
const parseRow = (
  row: StoredRow,
  descriptor: Scope,
): PostgresInsightsReportOrderRow => {
  integer(row.ordinal);
  const value = Number(integer(row.value));
  if (
    typeof row.label !== "string" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    !hash.test(row.count_key)
  )
    return invalid();
  const identity = JSON.stringify([
    descriptor.section,
    descriptor.metric,
    row.label,
    -1,
  ]);
  if (createHash("sha256").update(identity).digest("hex") !== row.count_key)
    return invalid();
  return {
    ordinal: row.ordinal,
    label: row.label,
    value,
    countKey: row.count_key,
  };
};
const readRun = async (
  db: QueryExecutorProvider,
  jobId: string,
  descriptor: Scope,
  pass: bigint,
  run: bigint,
  start: bigint,
  length: number,
): Promise<PostgresInsightsReportOrderRow[]> => {
  if (length === 0) return [];
  const result =
    await sql<StoredRow>`select row_position::text as ordinal, label, value::text, count_key
    from ${sql.table(runs)} where ${predicate(jobId, descriptor)} and sort_pass = ${Number(pass)}
      and run_number = ${run.toString()}::bigint and row_position >= ${start.toString()}::bigint
      and row_position < ${(start + BigInt(length)).toString()}::bigint
    order by row_position limit ${length}`.execute(db);
  if (result.rows.length !== length) return invalid();
  const rows = result.rows.map((row, index) => {
    const parsed = parseRow(row, descriptor);
    if (BigInt(parsed.ordinal) !== start + BigInt(index)) return invalid();
    return parsed;
  });
  for (let i = 1; i < rows.length; i++)
    if (compare(descriptor, rows[i - 1]!, rows[i]!) >= 0) invalid();
  return rows;
};
const writeRun = async (
  db: QueryExecutorProvider,
  jobId: string,
  descriptor: Scope,
  pass: bigint,
  run: bigint,
  start: bigint,
  rows: readonly PostgresInsightsReportOrderRow[],
) => {
  if (rows.length === 0) return;
  await sql`insert into ${sql.table(runs)} (job_id, section, metric, sort_pass, run_number, row_position, label, value, count_key)
    values ${sql.join(
      rows.map(
        (
          row,
          index,
        ) => sql`(${jobId}::uuid, ${descriptor.section}, ${descriptor.metric}, ${Number(pass)}, ${run.toString()}::bigint,
      ${(start + BigInt(index)).toString()}::bigint, ${row.label}, ${row.value}::bigint, ${row.countKey})`,
      ),
    )}`.execute(db);
};
const writeState = async (
  db: QueryExecutorProvider,
  jobId: string,
  descriptor: Scope,
  state: State,
) => {
  await sql`update ${sql.table(states)} set phase = ${state.phase}, after_count_key = ${state.afterCountKey},
    total_rows = ${state.total.toString()}::bigint, sort_pass = ${Number(state.pass)}, pair = ${state.pair.toString()}::bigint,
    left_pos = ${state.left.toString()}::bigint, right_pos = ${state.right.toString()}::bigint, out_pos = ${state.out.toString()}::bigint
    where ${predicate(jobId, descriptor)}`.execute(db);
};

/** Caller seals count mutations first and runs each step inside its job lease. */
export const stepPostgresInsightsReportOrder = async <TDatabase>(
  db: Transaction<TDatabase>,
  jobId: string,
  section: PostgresInsightsReportOrderSection,
): Promise<{ ready: boolean; processed: number }> => {
  const descriptor = scope(jobId, section);
  if (!db.isTransaction) throw new DatabasePluginInputError("invalid-query");
  await assertPostgresInsightsReportOrderIndexes(db);
  await sql`insert into ${sql.table(states)} (job_id, section, metric, phase, total_rows, sort_pass, pair, left_pos, right_pos, out_pos)
    values (${jobId}::uuid, ${descriptor.section}, ${descriptor.metric}, 'copy', 0, 0, 0, 0, 0, 0)
    on conflict (job_id, section, metric) do nothing`.execute(db);
  const state = (await readState(db, jobId, descriptor, true))!;
  if (state.phase === "ready") return { ready: true, processed: 0 };
  if (state.phase === "copy") {
    const result = await sql<
      StoredRow & { identity: unknown }
    >`select '0' as ordinal, label, value::text, count_key, identity
      from ${sql.table(counts)} where ${predicate(jobId, descriptor)}
      and section in ('movementCohorts', 'bundleDistribution', 'activeBundleTotals')
      ${state.afterCountKey === null ? sql`` : sql`and count_key > ${state.afterCountKey}`}
      order by count_key limit ${runSize}`.execute(db);
    if (result.rows.length > runSize) return invalid();
    let previous = state.afterCountKey;
    const rows = result.rows.map((row) => {
      const parsed = parseRow(row, descriptor);
      if (
        JSON.stringify(row.identity) !==
          JSON.stringify([
            descriptor.section,
            descriptor.metric,
            parsed.label,
            -1,
          ]) ||
        (previous !== null && parsed.countKey <= previous)
      )
        return invalid();
      previous = parsed.countKey;
      return parsed;
    });
    rows.sort((a, b) => compare(descriptor, a, b));
    for (let i = 1; i < rows.length; i++)
      if (compare(descriptor, rows[i - 1]!, rows[i]!) >= 0) invalid();
    if (state.total + BigInt(rows.length) > maximum) return invalid();
    await writeRun(db, jobId, descriptor, 0n, state.total / 32n, 0n, rows);
    state.total += BigInt(rows.length);
    state.afterCountKey = previous;
    if (rows.length < runSize) {
      state.phase = state.total <= 32n ? "ready" : "merge";
      state.pass = state.phase === "ready" ? 0n : 1n;
    }
    await writeState(db, jobId, descriptor, state);
    return { ready: state.phase === "ready", processed: rows.length };
  }

  const width = capacity(state.pass);
  const leftRun = state.pair * 2n;
  const leftLength = min(width / 2n, state.total - state.pair * width);
  const rightLength = min(
    width / 2n,
    state.total - state.pair * width - leftLength,
  );
  const readInput = async (run: bigint, position: bigint, length: bigint) => {
    if (position === length) return [];
    // Include the preceding row within the 32-row budget to validate the input
    // ordering across checkpoints. Never refill a consumed short candidate list.
    const start = position === 0n ? 0n : position - 1n;
    const rows = await readRun(
      db,
      jobId,
      descriptor,
      state.pass - 1n,
      run,
      start,
      Number(min(32n, length - start)),
    );
    return position === 0n ? rows : rows.slice(1);
  };
  const left = await readInput(leftRun, state.left, leftLength);
  const right = await readInput(leftRun + 1n, state.right, rightLength);
  const prior =
    state.out === 0n
      ? []
      : await readRun(
          db,
          jobId,
          descriptor,
          state.pass,
          state.pair,
          state.out - 1n,
          1,
        );
  const output: PostgresInsightsReportOrderRow[] = [];
  let l = 0;
  let r = 0;
  while (output.length < runSize) {
    const a = left[l];
    const b = right[r];
    if (a === undefined && state.left + BigInt(l) < leftLength) break;
    if (b === undefined && state.right + BigInt(r) < rightLength) break;
    if (a === undefined && b === undefined) break;
    const next =
      b === undefined || (a !== undefined && compare(descriptor, a, b) < 0)
        ? left[l++]!
        : right[r++]!;
    const previous = output.at(-1) ?? prior[0];
    if (previous !== undefined && compare(descriptor, previous, next) >= 0)
      return invalid();
    output.push(next);
  }
  if (output.length === 0) return invalid();
  await writeRun(
    db,
    jobId,
    descriptor,
    state.pass,
    state.pair,
    state.out,
    output,
  );
  state.left += BigInt(l);
  state.right += BigInt(r);
  state.out += BigInt(output.length);
  if (state.out === leftLength + rightLength) {
    state.pair++;
    state.left = state.right = state.out = 0n;
    if (state.pair === ceiling(state.total, width)) {
      state.pair = 0n;
      if (width >= state.total) state.phase = "ready";
      else state.pass++;
    }
  }
  await writeState(db, jobId, descriptor, state);
  return { ready: state.phase === "ready", processed: output.length };
};

export const getPostgresInsightsReportOrderReady = async (
  db: QueryExecutorProvider,
  jobId: string,
  section: PostgresInsightsReportOrderSection,
): Promise<{ pass: string; totalRows: string } | null> => {
  const descriptor = scope(jobId, section);
  await assertPostgresInsightsReportOrderIndexes(db);
  const state = await readState(db, jobId, descriptor, false);
  return state?.phase === "ready"
    ? { pass: state.pass.toString(), totalRows: state.total.toString() }
    : null;
};

export const readPostgresInsightsReportOrderRange = async (
  db: QueryExecutorProvider,
  jobId: string,
  section: PostgresInsightsReportOrderSection,
  pass: string,
  startOrdinal: string,
  limit: number,
): Promise<readonly PostgresInsightsReportOrderRow[]> => {
  const descriptor = scope(jobId, section);
  const parsedPass = inputInteger(pass, true);
  const start = inputInteger(startOrdinal);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
    throw new DatabasePluginInputError("invalid-query");
  const ready = await getPostgresInsightsReportOrderReady(db, jobId, section);
  if (ready === null) throw new InsightsQueryNotReadyError();
  const total = BigInt(ready.totalRows);
  if (ready.pass !== pass || start > total)
    throw new DatabasePluginInputError("invalid-query");
  return readRun(
    db,
    jobId,
    descriptor,
    parsedPass,
    0n,
    start,
    Number(min(BigInt(limit), total - start)),
  );
};
