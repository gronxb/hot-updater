import {
  type DatabaseKey,
  DATABASE_VERSION_COLUMN,
  findPhysicalColumn,
  type PhysicalTable,
  rowKey,
  type StoredRow,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";

import type {
  SqlCompiler,
  SqlCondition,
  SqlExecutor,
  SqlStatement,
} from "./sqlAdapter";
import { isMultiIndex } from "./sqlSchema";

/** Where a batch write records its first failed op, before any change applies. */
export const WRITE_GUARD_TABLE: PhysicalTable = {
  name: "_hu_write",
  columns: [
    { name: "id", type: "string", nullable: false, maxLength: 36 },
    { name: "failed_op", type: "integer", nullable: true },
  ],
  key: ["id"],
  indexes: [],
};

type Statement = ReturnType<SqlCompiler["statement"]>;

/**
 * SQL that holds when `op` would fail against the rows before any change;
 * none when it cannot. Rows the write deletes or patches (`released`) do not
 * count as holding a unique value.
 */
const failureOf = (
  compiler: SqlCompiler,
  op: WriteOp,
  statement: Statement,
  released: readonly DatabaseKey[],
): string | undefined => {
  const { table } = op;
  const { quote } = compiler;
  const from = `SELECT 1 FROM ${compiler.tableOf(table)} WHERE`;
  const key = (value: DatabaseKey) =>
    compiler.keyMatch(statement, table.key, value);
  // Locked where the dialect locks (PostgreSQL), so no writer moves a guarded row before the batch commits.
  const exists = (value: DatabaseKey, v?: number) =>
    `EXISTS (${from} ${key(value)}${v === undefined ? "" : ` AND ${quote(DATABASE_VERSION_COLUMN)} = ${statement.bind(v)}`}${compiler.lock})`;
  /** Another row already holding a unique value this op writes. */
  const clashes = (row: StoredRow, own?: DatabaseKey, changed?: string[]) =>
    table.indexes
      .filter(
        (index) =>
          index.unique &&
          !isMultiIndex(table, index) &&
          index.eq.every((column) => (row[column] ?? null) !== null) &&
          (!changed || index.eq.some((column) => changed.includes(column))),
      )
      .map((index) => {
        const match = index.eq.map(
          (column) =>
            `${quote(column)} = ${statement.bind(row[column], findPhysicalColumn(table, column))}`,
        );
        const others = [...(own ? [own] : []), ...released].map(
          (value) => ` AND NOT (${key(value)})`,
        );
        return `EXISTS (${from} ${match.join(" AND ")}${others.join("")})`;
      });
  switch (op.type) {
    case "insert":
      return [exists(rowKey(table, op.row)), ...clashes(op.row)].join(" OR ");
    case "patch":
      return [
        `NOT ${exists(op.key, op.guard.v)}`,
        ...clashes({ ...op.previous, ...op.set }, op.key, Object.keys(op.set)),
      ].join(" OR ");
    case "delete":
    case "check":
      return `NOT ${exists(op.key, op.guard.v)}`;
    case "increment":
      return op.init !== undefined && op.guard === undefined
        ? undefined
        : `NOT ${exists(op.key, op.guard?.v)}`;
  }
};

/**
 * A write as one atomic batch, for drivers without interactive transactions:
 * each op's guard, against the rows before any change, records the first
 * failing op in a guard row; every change applies only when none failed; the
 * last two statements read the failure and remove the row. Unique fields are
 * checked ahead, since a batch cannot name the statement a constraint stopped.
 */
export const compileBatchWrite = (
  compiler: SqlCompiler,
  ops: readonly WriteOp[],
  id: string,
): SqlStatement[] => {
  const guard = compiler.tableOf(WRITE_GUARD_TABLE);
  const [idColumn, failed] = ["id", "failed_op"].map(compiler.quote);
  const byId = (statement: Statement) => `${idColumn} = ${statement.bind(id)}`;
  const released = (table: string) =>
    ops.flatMap((op) =>
      (op.type === "delete" || op.type === "patch") && op.table.name === table
        ? [op.key]
        : [],
    );
  const guards = ops.flatMap((op, position) => {
    const statement = compiler.statement();
    const failure = failureOf(compiler, op, statement, released(op.table.name));
    if (failure === undefined) return [];
    return [
      statement.done(
        `UPDATE ${guard} SET ${failed} = ${position} WHERE ${failed} IS NULL AND (${failure}) AND ${byId(statement)}`,
      ),
    ];
  });
  const when: SqlCondition = (bind) =>
    `(SELECT ${failed} FROM ${guard} WHERE ${idColumn} = ${bind(id)}) IS NULL`;
  const [open, read, clear] = [0, 1, 2].map(() => compiler.statement());
  return [
    open!.done(
      `INSERT INTO ${guard} (${idColumn}, ${failed}) VALUES (${open!.bind(id)}, NULL)`,
    ),
    ...guards,
    ...ops.flatMap((op) => compiler.write(op, when).statements),
    read!.done(`SELECT ${failed} FROM ${guard} WHERE ${byId(read!)}`),
    clear!.done(`DELETE FROM ${guard} WHERE ${byId(clear!)}`),
  ];
};

/** Runs `compileBatchWrite`'s statements and reads the first failed op, if any. */
export const writeBatch = async (
  compiler: SqlCompiler,
  batch: NonNullable<SqlExecutor["batch"]>,
  ops: readonly WriteOp[],
  classify: (error: unknown) => "constraint" | "retry" | undefined,
): Promise<WriteResult> => {
  try {
    const statements = compileBatchWrite(compiler, ops, crypto.randomUUID());
    const failed = (await batch(statements)).at(-2)?.rows[0]?.failed_op ?? null;
    return failed === null
      ? { ok: true }
      : { ok: false, failedOp: Number(failed) };
  } catch (error) {
    const kind = classify(error);
    if (kind === "retry") return { ok: false, retry: true };
    // Unique fields were checked ahead; a constraint here is among the ops themselves.
    if (kind === "constraint") return { ok: false, failedOp: 0 };
    throw error;
  }
};
