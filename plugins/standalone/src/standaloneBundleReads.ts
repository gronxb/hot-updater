import {
  bundleToPatchRows,
  DatabasePluginInputError,
} from "@hot-updater/plugin-core";
import type {
  DatabaseDistinctFields,
  DatabaseDistinctOn,
  DatabaseModel,
  DatabaseOrderBy,
  DatabaseRow,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";

import type { StandaloneBundleReader } from "./standaloneBundleReader";
import type { StandaloneBundleRemote } from "./standaloneBundleRemote";
import {
  matchesStandaloneWhere,
  queryStandaloneRows,
} from "./standaloneDatabaseQuery";

type BundleReads = Pick<
  StandaloneBundleReader,
  "count" | "findOne" | "findMany"
>;

type BundleQuery<TModel extends DatabaseModel> = {
  readonly distinctOn?: DatabaseDistinctOn<TModel>;
  readonly limit: number;
  readonly offset: number;
  readonly orderBy?: DatabaseOrderBy<TModel>;
  readonly where?: readonly DatabaseWhere<TModel>[];
};

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
};

const queryBundleRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  input: BundleQuery<TModel>,
): DatabaseRow<TModel>[] => {
  const filtered = queryStandaloneRows(rows, { where: input.where });
  const orderBy = input.orderBy;
  if (orderBy !== undefined) {
    filtered.sort((left, right) => {
      for (const clause of orderBy) {
        const leftValue = Reflect.get(left, clause.field);
        const rightValue = Reflect.get(right, clause.field);
        if (leftValue === rightValue) continue;
        if (leftValue === null || rightValue === null) {
          const nulls =
            clause.nulls ?? (clause.direction === "asc" ? "last" : "first");
          return leftValue === null
            ? nulls === "first"
              ? -1
              : 1
            : nulls === "first"
              ? 1
              : -1;
        }
        const result = compare(leftValue, rightValue);
        if (result !== 0) {
          return clause.direction === "asc" ? result : -result;
        }
      }
      return 0;
    });
  }
  const distinct =
    input.distinctOn === undefined
      ? filtered
      : filtered.filter(
          (row, index, ordered) =>
            ordered.findIndex(
              (candidate) =>
                JSON.stringify(
                  input.distinctOn?.fields.map((field) =>
                    Reflect.get(candidate, field),
                  ),
                ) ===
                JSON.stringify(
                  input.distinctOn?.fields.map((field) =>
                    Reflect.get(row, field),
                  ),
                ),
            ) === index,
        );
  return distinct.slice(input.offset, input.offset + input.limit);
};

const countDistinctRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  fields: DatabaseDistinctFields<TModel> | undefined,
): number =>
  fields === undefined
    ? rows.length
    : new Set(
        rows.map((row) =>
          JSON.stringify(fields.map((field) => Reflect.get(row, field))),
        ),
      ).size;

export const createBundleReads = (
  remote: StandaloneBundleRemote,
): BundleReads => {
  const loadPatches = async (
    where: readonly DatabaseWhere<"bundle_patches">[] | undefined,
  ) => {
    if (where?.some(({ connector }) => connector === "OR"))
      throw new DatabasePluginInputError("invalid-operation");
    const owner = where?.find(({ field }) => field === "bundle_id");
    const ids =
      owner?.operator === "in" && Array.isArray(owner.value)
        ? owner.value
        : owner &&
            (owner.operator === undefined || owner.operator === "eq") &&
            typeof owner.value === "string"
          ? [owner.value]
          : undefined;
    if (ids === undefined)
      throw new DatabasePluginInputError("invalid-operation");
    const rows = [];
    for (const id of new Set(ids)) {
      const bundle = await remote.loadBundle(id);
      if (bundle !== null) rows.push(...bundleToPatchRows(bundle));
    }
    return rows;
  };
  return {
    async count(input) {
      if (input.model === "bundle_patches")
        return countDistinctRows(
          queryStandaloneRows(await loadPatches(input.where), {
            where: input.where,
          }),
          input.distinct,
        );
      if (input.distinct !== undefined)
        throw new DatabasePluginInputError("invalid-operation");
      const window = await remote.loadBundleWindow({
        where: input.where,
        limit: 1,
        offset: 0,
      });
      if (window === null)
        throw new DatabasePluginInputError("invalid-operation");
      return window.total;
    },
    async findOne(input) {
      if (input.model === "bundle_patches")
        return (
          queryStandaloneRows(await loadPatches(input.where), {
            where: input.where,
            limit: 1,
          })[0] ?? null
        );
      const id = input.where?.length === 1 ? input.where[0] : undefined;
      if (
        id?.field === "id" &&
        (id.operator === undefined || id.operator === "eq") &&
        typeof id.value === "string"
      ) {
        const row = await remote.loadBundleRow(id.value);
        return row && matchesStandaloneWhere(row, input.where) ? row : null;
      }
      const window = await remote.loadBundleWindow({
        where: input.where,
        limit: 1,
        offset: 0,
      });
      if (window === null)
        throw new DatabasePluginInputError("invalid-operation");
      return window.rows[0] ?? null;
    },
    async findMany(input) {
      if (input.model === "bundle_patches")
        return queryBundleRows(await loadPatches(input.where), input);
      if (
        input.distinctOn !== undefined ||
        (input.orderBy !== undefined &&
          (input.orderBy.length !== 1 || input.orderBy[0].field !== "id"))
      )
        throw new DatabasePluginInputError("invalid-operation");
      const window = await remote.loadBundleWindow({
        where: input.where,
        limit: input.limit,
        offset: input.offset,
        orderBy: input.orderBy?.[0],
      });
      if (window === null)
        throw new DatabasePluginInputError("invalid-operation");
      return window.rows;
    },
  };
};
