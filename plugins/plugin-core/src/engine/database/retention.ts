import type {
  DatabaseAdapter,
  PhysicalRetention,
  PhysicalTable,
  StoredRow,
  WriteOp,
} from "../../database/adapter";
import type { ModelShape, SchemaShape } from "./definitions";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A model's retention as its physical table carries it, which each adapter maps natively. */
export const physicalRetention = ({
  retention,
}: ModelShape): { readonly retention?: PhysicalRetention } =>
  retention === undefined
    ? {}
    : { retention: { column: retention.field, ms: retention.days * DAY_MS } };

/** Models in a reference or a rooted index, which an expired row's delete would break. */
const linkedModels = (schema: SchemaShape) =>
  Object.entries(schema).flatMap(([name, { fields, indexes }]) =>
    [
      ...Object.values(fields).map(({ references }) => references),
      ...Object.values(indexes).map(({ root }) => root),
    ].flatMap((link) => (link ? [name, link.model] : [])),
  );

/**
 * What is wrong with a model's retention: it counts from an integer field,
 * over whole days, and expired rows are deleted without cascades, counter
 * moves, or root bumps, so the model is in no reference or rooted index.
 */
export const retentionProblems = (
  schema: SchemaShape,
  model: string,
): string[] => {
  const definition = schema[model]!;
  if (definition.retention === undefined) return [];
  const { field, days } = definition.retention;
  const declared =
    definition.fields[field] ??
    (definition.kind === "table" ? definition.derived[field] : undefined);
  return [
    ...(declared?.type !== "integer" ||
    ("multi" in declared && declared.multi === true)
      ? [`retention field "${field}" is not an integer field`]
      : []),
    ...(Number.isSafeInteger(days) && days >= 1
      ? []
      : ["retention days must be a whole number of at least 1"]),
    ...(linkedModels(schema).includes(model)
      ? ["a model with retention is in no reference or rooted index"]
      : []),
  ];
};

/**
 * Rows a pass deletes from each table: one statement or two a table, so a
 * pass stays well inside D1's 50 queries an invocation.
 */
const PASS_LIMIT = 500;
/** The lease row: when the next pass is due, in epoch ms. */
const LEASE_KEY = "retention.nextPassAt";

/**
 * The adapter, pruning during its writes with no scheduler: once the lease
 * row in `leaseTable` is due, the write that takes it first runs one bounded
 * pass over the tables with retention, and other writers skip. The next pass is due in an hour, or in a minute while a pass still
 * found a full batch of expired rows in some table. A backend that expires
 * rows natively, or a schema without retention, gets its adapter back.
 */
export const pruneDuringWrites = (
  adapter: DatabaseAdapter,
  tables: readonly PhysicalTable[],
  { leaseTable: table, now }: { leaseTable: PhysicalTable; now: () => number },
): DatabaseAdapter => {
  const expiring = tables.filter(({ retention }) => retention !== undefined);
  if (adapter.prune === undefined || expiring.length === 0) return adapter;
  const key = [LEASE_KEY];
  let checkAt = 0;
  // Moves the lease to `due` from `row`: the row it wrote, or null when
  // another writer moved the lease first.
  const lease = async (row: StoredRow | null, due: number) => {
    const value = String(due);
    const guard = { v: row === null ? -1 : Number(row._v) };
    const next = { key: LEASE_KEY, value, _v: guard.v + 1 };
    const op: WriteOp =
      row === null
        ? { type: "insert", table, row: next }
        : { type: "patch", table, key, set: { value }, guard, previous: row };
    return (await adapter.write([op])).ok ? next : null;
  };
  const pass = async () => {
    const at = now();
    if (at < checkAt) return;
    checkAt = at + MINUTE_MS;
    const [row = null] = await adapter.get(table, [key]);
    // Due, or missing: this process reads it again if another takes it first.
    checkAt = row === null ? at : Number(row.value);
    if (checkAt > at) return;
    const held = await lease(row, at + HOUR_MS);
    if (held === null) return;
    checkAt = at + HOUR_MS;
    const deleted: number[] = [];
    for (const t of expiring) {
      deleted.push(await adapter.prune!(t, at - t.retention!.ms, PASS_LIMIT));
    }
    const backlog = deleted.includes(PASS_LIMIT);
    if (backlog && (await lease(held, at + MINUTE_MS)) !== null) {
      checkAt = at + MINUTE_MS;
    }
  };
  const warn = (error: unknown) =>
    console.warn("[hot-updater] Pruning expired rows failed.", error);
  // Inherits every other member, so it reads the adapter as it is at each
  // call, a proxy's included.
  return Object.assign(Object.create(adapter) as DatabaseAdapter, {
    // Before the write, so a pass never deletes what that write stores:
    // rows written already expired go at the next pass.
    async write(ops: readonly WriteOp[]) {
      await pass().catch(warn);
      return adapter.write(ops);
    },
  });
};
