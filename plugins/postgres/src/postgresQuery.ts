import type {
  CountDatabaseImplementationInput,
  DatabaseImplementationResult,
  FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import type { Kysely, OrderByItemBuilder, RawBuilder } from "kysely";

import type { Database } from "./types";

type PostgresWhere = RawBuilder<boolean> | undefined;

const applyOrder = (
  order: OrderByItemBuilder,
  clause: {
    readonly direction: "asc" | "desc";
    readonly nulls?: "first" | "last";
  },
): OrderByItemBuilder => {
  const directed = clause.direction === "asc" ? order.asc() : order.desc();
  return clause.nulls === undefined
    ? directed
    : clause.nulls === "first"
      ? directed.nullsFirst()
      : directed.nullsLast();
};

export const countPostgresRows = async (
  db: Kysely<Database>,
  input: CountDatabaseImplementationInput,
  where: PostgresWhere,
): Promise<number> => {
  switch (input.model) {
    case "bundles": {
      let rows = db.selectFrom("bundles");
      if (where !== undefined) rows = rows.where(where);
      const query =
        input.distinct === undefined
          ? rows.select(({ fn }) => fn.countAll<string>().as("count"))
          : db
              .selectFrom(
                rows.select(input.distinct).distinct().as("distinct_rows"),
              )
              .select(({ fn }) => fn.countAll<string>().as("count"));
      return Number((await query.executeTakeFirstOrThrow()).count);
    }
    case "bundle_patches": {
      let rows = db.selectFrom("bundle_patches");
      if (where !== undefined) rows = rows.where(where);
      const query =
        input.distinct === undefined
          ? rows.select(({ fn }) => fn.countAll<string>().as("count"))
          : db
              .selectFrom(
                rows.select(input.distinct).distinct().as("distinct_rows"),
              )
              .select(({ fn }) => fn.countAll<string>().as("count"));
      return Number((await query.executeTakeFirstOrThrow()).count);
    }
    case "bundle_events": {
      let rows = db.selectFrom("bundle_events");
      if (where !== undefined) rows = rows.where(where);
      const query =
        input.distinct === undefined
          ? rows.select(({ fn }) => fn.countAll<string>().as("count"))
          : db
              .selectFrom(
                rows.select(input.distinct).distinct().as("distinct_rows"),
              )
              .select(({ fn }) => fn.countAll<string>().as("count"));
      return Number((await query.executeTakeFirstOrThrow()).count);
    }
  }
};

export const findManyPostgresRows = async (
  db: Kysely<Database>,
  input: FindManyDatabaseImplementationInput,
  where: PostgresWhere,
): Promise<readonly DatabaseImplementationResult[]> => {
  switch (input.model) {
    case "bundles": {
      let query = db.selectFrom("bundles").selectAll();
      if (where !== undefined) query = query.where(where);
      if (input.distinctOn !== undefined) {
        query = query.distinctOn(input.distinctOn.fields);
      }
      for (const clause of input.orderBy ??
        (input.sortBy ? [input.sortBy] : [])) {
        query = query.orderBy(clause.field, (order) =>
          applyOrder(order, clause),
        );
      }
      return query.limit(input.limit).offset(input.offset).execute();
    }
    case "bundle_patches": {
      let query = db.selectFrom("bundle_patches").selectAll();
      if (where !== undefined) query = query.where(where);
      if (input.distinctOn !== undefined) {
        query = query.distinctOn(input.distinctOn.fields);
      }
      for (const clause of input.orderBy ??
        (input.sortBy ? [input.sortBy] : [])) {
        query = query.orderBy(clause.field, (order) =>
          applyOrder(order, clause),
        );
      }
      return query.limit(input.limit).offset(input.offset).execute();
    }
    case "bundle_events": {
      let query = db.selectFrom("bundle_events").selectAll();
      if (where !== undefined) query = query.where(where);
      if (input.distinctOn !== undefined) {
        query = query.distinctOn(input.distinctOn.fields);
      }
      for (const clause of input.orderBy ??
        (input.sortBy ? [input.sortBy] : [])) {
        query = query.orderBy(clause.field, (order) =>
          applyOrder(order, clause),
        );
      }
      return query.limit(input.limit).offset(input.offset).execute();
    }
  }
};
