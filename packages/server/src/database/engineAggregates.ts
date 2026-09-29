import {
  type DatabaseAdapter,
  type DatabaseKey,
  type DatabaseKeyValue,
  DATABASE_VERSION_COLUMN,
  isKeyValue,
  mergeInsightsDistinct,
  type StoredRow,
  type WriteOp,
} from "@hot-updater/plugin-core/internal";

import { fnv1a } from "./cursor";
import type { AggregateShape } from "./definitions";
import { DatabaseTransactionError } from "./errors";
import type { ResolvedModel } from "./resolveSchema";

/** The pending changes to one shard row of an aggregate. */
export interface AggregateChange {
  readonly model: ResolvedModel;
  /** The identity values in key order, then the shard. */
  readonly key: DatabaseKey;
  readonly deltas: Record<string, number>;
  readonly sketches: Record<string, string>;
}

const definitionOf = (model: ResolvedModel) =>
  model.definition as AggregateShape;

/** Every change keyed by one value lands on one shard. */
export const shardOf = (value: string, shards: number): number =>
  fnv1a(value) % shards;

/** Merges one `tx.aggregate` call into its shard row's pending changes. */
export const recordAggregate = (
  changes: Map<string, AggregateChange>,
  model: ResolvedModel,
  identity: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  shardBy: string | undefined,
) => {
  const {
    key: fields,
    counters,
    gauges,
    distinct,
    shards,
  } = definitionOf(model);
  const fail = (message: string) =>
    new DatabaseTransactionError(`${model.table.name}: ${message}`);
  if (
    Object.keys(identity).length !== fields.length ||
    !fields.every((name) => isKeyValue(identity[name]))
  ) {
    throw fail(
      `aggregate takes exactly its identity fields: ${fields.join(", ")}.`,
    );
  }
  if (
    shardBy === undefined &&
    shards > 1 &&
    gauges.some((gauge) => gauge in values)
  ) {
    throw fail("gauges of a sharded aggregate need shardBy.");
  }
  const shard =
    shardBy === undefined
      ? Math.floor(Math.random() * shards)
      : shardOf(shardBy, shards);
  const key = [
    ...fields.map((name) => identity[name] as DatabaseKeyValue),
    shard,
  ];
  const id = JSON.stringify([model.table.name, key]);
  const change = changes.get(id) ?? { model, key, deltas: {}, sketches: {} };
  changes.set(id, change);
  for (const [metric, value] of Object.entries(values)) {
    if (distinct.includes(metric) && typeof value === "string") {
      change.sketches[metric] = mergeInsightsDistinct([
        change.sketches[metric],
        value,
      ]);
    } else if (
      (counters.includes(metric) || gauges.includes(metric)) &&
      Number.isSafeInteger(value)
    ) {
      change.deltas[metric] = (change.deltas[metric] ?? 0) + Number(value);
    } else {
      throw fail(
        `${metric} is not a counter, gauge, or sketch of this aggregate.`,
      );
    }
  }
};

/** A shard row before its first change: every metric zero or empty. */
const blank = (model: ResolvedModel, key: DatabaseKey): StoredRow => {
  const { counters, gauges, distinct } = definitionOf(model);
  return Object.fromEntries([
    ...model.table.key.map((column, position) => [column, key[position]!]),
    ...[...counters, ...gauges].map((name) => [name, 0]),
    ...distinct.map((name) => [name, null]),
    [DATABASE_VERSION_COLUMN, 0],
  ]);
};

/**
 * A gauge computed below zero. Deltas from a row another writer has since
 * moved do this, so the transaction reruns; it is thrown only when it lasts.
 */
export class NegativeGaugeError extends DatabaseTransactionError {}

/** The guarded write that merges `change` into `current`: insert, patch, or delete at zero. */
const rewrite = (
  { model, key, deltas, sketches }: AggregateChange,
  current: StoredRow | null,
): WriteOp | undefined => {
  const { table } = model;
  const { counters, gauges, distinct } = definitionOf(model);
  const base = current ?? blank(model, key);
  const set: Record<string, number | string> = {};
  for (const [metric, delta] of Object.entries(deltas)) {
    set[metric] = Number(base[metric] ?? 0) + delta;
  }
  for (const [metric, sketch] of Object.entries(sketches)) {
    set[metric] = mergeInsightsDistinct([
      base[metric] as string | null,
      sketch,
    ]);
  }
  // A merge that changes nothing (a sketch already counting its value) is not written.
  if (
    current &&
    Object.entries(set).every(([metric, value]) => current[metric] === value)
  ) {
    return undefined;
  }
  const row = { ...base, ...set };
  if (gauges.some((gauge) => Number(row[gauge]) < 0)) {
    throw new NegativeGaugeError(`${table.name}: a gauge went below 0.`);
  }
  const zero =
    distinct.length === 0 &&
    [...counters, ...gauges].every((metric) => Number(row[metric]) === 0);
  if (current === null)
    return zero ? undefined : { type: "insert", table, row };
  const guard = { v: Number(current[DATABASE_VERSION_COLUMN]) };
  return zero
    ? { type: "delete", table, key, guard, previous: current }
    : { type: "patch", table, key, set, guard, previous: current };
};

/**
 * Counter-only rows become blind increments that create the row when it is
 * missing. Rows with gauges or sketches are read in one parallel batch per
 * table, merged, and written back under a guard, so a conflict resends only
 * them.
 */
export const compileAggregates = async (
  adapter: DatabaseAdapter,
  changes: Iterable<AggregateChange>,
): Promise<WriteOp[]> => {
  const ops: WriteOp[] = [];
  const merged = new Map<ResolvedModel, AggregateChange[]>();
  for (const change of changes) {
    const { model, key, deltas, sketches } = change;
    if (
      Object.keys(sketches).length > 0 ||
      definitionOf(model).gauges.some((gauge) => (deltas[gauge] ?? 0) !== 0)
    ) {
      merged.set(model, [...(merged.get(model) ?? []), change]);
    } else if (Object.values(deltas).some((delta) => delta !== 0)) {
      const { table } = model;
      const init = blank(model, key);
      ops.push({ type: "increment", table, key, by: deltas, init });
    }
  }
  const groups = [...merged.values()];
  const current = await Promise.all(
    groups.map((group) =>
      adapter.get(
        group[0]!.model.table,
        group.map(({ key }) => key),
      ),
    ),
  );
  groups.forEach((group, index) =>
    group.forEach((change, position) => {
      const op = rewrite(change, current[index]![position] ?? null);
      if (op !== undefined) ops.push(op);
    }),
  );
  return ops;
};
