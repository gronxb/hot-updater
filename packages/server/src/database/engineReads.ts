import {
  type DatabaseAdapter,
  type DatabaseKey,
  type DatabaseKeyValue,
  DATABASE_MAX_QUERY_LIMIT,
  indexOrderColumns,
  indexOrderTuple,
  isKeyValue,
  mergeInsightsDistinct,
  type PhysicalIndex,
  type QueryBound,
  type StoredRow,
} from "@hot-updater/plugin-core/internal";

import { cursorScope, decodeCursor, encodeCursor } from "./cursor";
import {
  type ResolvedModel,
  type ResolvedSchema,
  SHARD_COLUMN,
} from "./resolveSchema";

export class DatabaseQueryError extends Error {
  readonly name = "DatabaseQueryError";
}

/** A value of the index's first order field, or a prefix of its order tuple. */
export type RangeValue = DatabaseKeyValue | readonly DatabaseKeyValue[];

export interface ReadRange {
  readonly gt?: RangeValue;
  readonly gte?: RangeValue;
  readonly lt?: RangeValue;
  readonly lte?: RangeValue;
}

export interface ReadInput {
  readonly index: string;
  /** Values for every eq field of the index. */
  readonly where?: Readonly<Record<string, DatabaseKeyValue>>;
  /** Bounds on the index's first order field, or on a prefix of its order tuple. */
  readonly range?: ReadRange;
  readonly order?: "asc" | "desc";
  readonly limit: number;
  readonly cursor?: string;
}

export interface Page<TRow> {
  readonly rows: readonly TRow[];
  /** Present only after a full page. */
  readonly next?: string;
}

export interface EngineReadCount {
  readonly calls: number;
  readonly rows: number;
}

export interface EngineReadOptions {
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  /** The largest `limit` a read accepts (default and maximum 500). */
  readonly maxPageSize?: number;
}

const sameFields = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((field) => right.includes(field));

const keyValue = (value: unknown, field: string): DatabaseKeyValue => {
  if (!isKeyValue(value)) {
    throw new DatabaseQueryError(
      `${field} needs a string, number, or boolean.`,
    );
  }
  return value;
};

const bound = (
  exclusive: RangeValue | undefined,
  inclusive: RangeValue | undefined,
  columns: readonly string[],
): QueryBound | undefined => {
  const field = columns[0]!;
  if (exclusive !== undefined && inclusive !== undefined) {
    throw new DatabaseQueryError(
      `range on ${field} sets both bounds of one side.`,
    );
  }
  const value = exclusive ?? inclusive;
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > columns.length) {
    throw new DatabaseQueryError(
      `range on ${field} takes 1–${columns.length} values of ${columns.join(", ")}.`,
    );
  }
  return {
    values: values.map((item, position) => keyValue(item, columns[position]!)),
    inclusive: inclusive !== undefined,
  };
};

export const createEngineReads = (options: EngineReadOptions) => {
  const { adapter, schema } = options;
  const maxPageSize = Math.min(
    options.maxPageSize ?? DATABASE_MAX_QUERY_LIMIT,
    DATABASE_MAX_QUERY_LIMIT,
  );
  let count: EngineReadCount = { calls: 0, rows: 0 };
  const returned = <T>(rows: T): T => {
    const size = Array.isArray(rows) ? rows.length : rows === null ? 0 : 1;
    count = { calls: count.calls + 1, rows: count.rows + size };
    return rows;
  };

  const modelOf = (
    name: string,
    kind: "table" | "aggregate",
  ): ResolvedModel => {
    const model = schema.models.get(name);
    if (model === undefined)
      throw new DatabaseQueryError(`Unknown model ${name}.`);
    if (model.definition.kind !== kind) {
      throw new DatabaseQueryError(
        kind === "table"
          ? `${name} is an aggregate; read it with findAggregates.`
          : `${name} is a table; read it with findMany.`,
      );
    }
    return model;
  };

  const plan = (model: ResolvedModel, input: ReadInput) => {
    const { table } = model;
    const index: PhysicalIndex | undefined = table.indexes.find(
      (candidate) => candidate.name === input.index,
    );
    if (index === undefined) {
      throw new DatabaseQueryError(
        `${table.name} has no index ${input.index}.`,
      );
    }
    const where = input.where ?? {};
    if (!sameFields(Object.keys(where), index.eq)) {
      throw new DatabaseQueryError(
        `${table.name}.${index.name} reads need where on exactly: ${index.eq.join(", ") || "(none)"}.`,
      );
    }
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > maxPageSize
    ) {
      throw new DatabaseQueryError(`limit must be 1–${maxPageSize}.`);
    }
    const order = input.order ?? "asc";
    const columns = indexOrderColumns(table, index);
    const eq = index.eq.map((field) =>
      keyValue(where[field], `${table.name}.${field}`),
    );
    const scope = cursorScope([
      table.name,
      index.name,
      eq,
      order,
      input.range ?? null,
    ]);
    let lower = bound(input.range?.gt, input.range?.gte, columns);
    let upper = bound(input.range?.lt, input.range?.lte, columns);
    if (input.cursor !== undefined) {
      const after = {
        values: decodeCursor(scope, input.cursor),
        inclusive: false,
      };
      if (order === "asc") lower = after;
      else upper = after;
    }
    return {
      request: {
        index: index.name,
        eq,
        order,
        limit: input.limit,
        ...(lower === undefined ? {} : { lower }),
        ...(upper === undefined ? {} : { upper }),
      },
      index,
      scope,
    };
  };

  const logicalKey = (model: ResolvedModel, row: StoredRow): DatabaseKey =>
    model.table.key
      .filter((column) => column !== SHARD_COLUMN)
      .map((column) => keyValue(row[column], column));

  /** Sums counters and gauges and merges sketches across one logical row's shards. */
  const mergeShards = (
    model: ResolvedModel,
    shards: readonly StoredRow[],
  ): StoredRow => {
    if (model.definition.kind !== "aggregate")
      throw new DatabaseQueryError("Not an aggregate.");
    const { definition } = model;
    const merged: Record<string, unknown> = Object.fromEntries(
      Object.keys(definition.fields).map((field) => [field, shards[0]![field]]),
    );
    for (const metric of [...definition.counters, ...definition.gauges]) {
      merged[metric] = shards.reduce(
        (sum, row) => sum + Number(row[metric] ?? 0),
        0,
      );
    }
    for (const metric of definition.distinct) {
      merged[metric] = mergeInsightsDistinct(
        shards.map((row) => row[metric] as string | null),
      );
    }
    return merged as StoredRow;
  };

  return {
    maxPageSize,
    reads: {
      total: (): EngineReadCount => count,
      reset: () => {
        count = { calls: 0, rows: 0 };
      },
    },

    /** Reads rows by key in one batch; the results follow the keys' order. */
    async findByKeys(
      name: string,
      lookups: readonly Readonly<Record<string, DatabaseKeyValue>>[],
    ): Promise<(StoredRow | null)[]> {
      const { table } = modelOf(name, "table");
      const keys = lookups.map((lookup) => {
        if (!sameFields(Object.keys(lookup), table.key)) {
          throw new DatabaseQueryError(
            `findByKeys on ${name} takes its key: ${table.key.join(", ")}.`,
          );
        }
        return table.key.map((field) =>
          keyValue(lookup[field], `${name}.${field}`),
        );
      });
      const rows = keys.length === 0 ? [] : await adapter.get(table, keys);
      returned(rows.filter((row) => row !== null));
      return rows.map((row) => row ?? null);
    },

    /** Reads one row by its key or by the eq fields of a unique index. */
    async findOne(
      name: string,
      lookup: Readonly<Record<string, DatabaseKeyValue>>,
    ): Promise<StoredRow | null> {
      const model = modelOf(name, "table");
      const { table } = model;
      const fields = Object.keys(lookup);
      if (sameFields(fields, table.key)) {
        const [row] = await adapter.get(table, [
          table.key.map((field) => keyValue(lookup[field], `${name}.${field}`)),
        ]);
        return returned(row ?? null);
      }
      const index = table.indexes.find(
        (candidate) => candidate.unique && sameFields(fields, candidate.eq),
      );
      if (index === undefined) {
        throw new DatabaseQueryError(
          `findOne on ${name} needs its key or a unique field, not ${fields.join(", ")}.`,
        );
      }
      const [row] = await adapter.query(table, {
        index: index.name,
        eq: index.eq.map((field) =>
          keyValue(lookup[field], `${name}.${field}`),
        ),
        order: "asc",
        limit: 1,
      });
      return returned(row ?? null);
    },

    /** Reads one page of an index range; `next` resumes right after it. */
    async findMany(name: string, input: ReadInput): Promise<Page<StoredRow>> {
      const model = modelOf(name, "table");
      const { request, index, scope } = plan(model, input);
      const rows = await adapter.query(model.table, request);
      const last = rows.at(-1);
      returned(rows);
      return rows.length === input.limit && last !== undefined
        ? {
            rows,
            next: encodeCursor(
              scope,
              indexOrderTuple(model.table, index, last),
            ),
          }
        : { rows };
    },

    /**
     * Reads one page of logical aggregate rows. A row cut off by the limit is
     * completed by reading only its remaining shards.
     */
    async findAggregates(
      name: string,
      input: ReadInput,
    ): Promise<Page<StoredRow>> {
      const model = modelOf(name, "aggregate");
      const { request, index, scope } = plan(model, input);
      const rows = await adapter.query(model.table, request);
      const groups: StoredRow[][] = [];
      for (const row of rows) {
        const group = groups.at(-1);
        const key = JSON.stringify(logicalKey(model, row));
        if (
          group !== undefined &&
          JSON.stringify(logicalKey(model, group[0]!)) === key
        ) {
          group.push(row);
        } else {
          groups.push([row]);
        }
      }
      const full = rows.length === input.limit;
      const last = groups.at(-1);
      if (full && last !== undefined && model.definition.kind === "aggregate") {
        const seen = new Set(last.map((row) => row[SHARD_COLUMN]));
        const missing = Array.from(
          { length: model.definition.shards },
          (_, shard) => shard,
        ).filter((shard) => !seen.has(shard));
        if (missing.length > 0) {
          const key = logicalKey(model, last[0]!);
          const rest = await adapter.get(
            model.table,
            missing.map((shard) => [...key, shard]),
          );
          last.push(...rest.filter((row): row is StoredRow => row !== null));
        }
      }
      const merged = groups.map((group) => mergeShards(model, group));
      returned(merged);
      if (!full || last === undefined) return { rows: merged };
      const tuple = indexOrderTuple(model.table, index, last[0]!);
      return { rows: merged, next: encodeCursor(scope, tuple.slice(0, -1)) };
    },
  };
};

export type EngineReads = ReturnType<typeof createEngineReads>;
