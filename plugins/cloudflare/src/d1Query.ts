import type {
  CountDatabaseImplementationInput,
  DatabaseImplementationResult,
  DatabaseModel,
  FindManyDatabaseImplementationInput,
} from "@hot-updater/plugin-core";

import type { D1Executor } from "./d1Implementation";
import { parseD1Row } from "./d1Rows";
import { buildD1Order, buildD1Where, encodeD1Values } from "./d1Sql";

export const d1TableNames = {
  bundles: "bundles",
  bundle_patches: "bundle_patches",
  bundle_events: "bundle_events",
} as const satisfies Record<DatabaseModel, string>;

export const countD1Rows = async (
  executor: D1Executor,
  input: CountDatabaseImplementationInput,
): Promise<number> => {
  const where = buildD1Where(input.where);
  const table = d1TableNames[input.model];
  const source =
    input.distinct === undefined
      ? `${table}${where.sql}`
      : `(SELECT DISTINCT ${input.distinct.join(", ")} FROM ${table}${where.sql}) AS distinct_rows`;
  const rows = await executor.query(
    `SELECT COUNT(*) AS count FROM ${source}`,
    where.params,
  );
  const row = rows[0];
  if (typeof row !== "object" || row === null || !("count" in row)) return 0;
  return Number(row.count);
};

export const findManyD1Rows = async (
  executor: D1Executor,
  input: FindManyDatabaseImplementationInput,
): Promise<readonly DatabaseImplementationResult[]> => {
  const where = buildD1Where(input.where);
  const orderBy = input.orderBy ?? (input.sortBy ? [input.sortBy] : undefined);
  const order = buildD1Order(orderBy);
  const table = d1TableNames[input.model];
  const source =
    input.distinctOn === undefined
      ? `SELECT * FROM ${table}${where.sql}${order}`
      : `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY ${input.distinctOn.fields.join(", ")}${order}) AS __hot_updater_rank FROM ${table}${where.sql}) AS distinct_rows WHERE __hot_updater_rank = 1${order}`;
  const pageParams = encodeD1Values([input.limit, input.offset]);
  const rows = await executor.query(
    `${source} LIMIT json_extract(?, '$') OFFSET json_extract(?, '$')`,
    [...where.params, ...pageParams],
  );
  switch (input.model) {
    case "bundles":
      return rows.map((row) => parseD1Row("bundles", row));
    case "bundle_patches":
      return rows.map((row) => parseD1Row("bundle_patches", row));
    case "bundle_events":
      return rows.map((row) => parseD1Row("bundle_events", row));
  }
};
