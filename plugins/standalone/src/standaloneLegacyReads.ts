import type {
  DatabaseDistinctFields,
  DatabaseDistinctOn,
  DatabaseModel,
  DatabaseOrderBy,
  DatabasePluginImplementation,
  DatabaseRow,
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core";
import { bundleToRow } from "@hot-updater/plugin-core";

import type { StandaloneBundleRemote } from "./standaloneBundleRemote";
import {
  matchesStandaloneWhere,
  queryStandaloneRows,
} from "./standaloneDatabaseQuery";
import { loadRows } from "./standaloneLegacyData";

type LegacyReads = Pick<
  DatabasePluginImplementation,
  "count" | "findOne" | "findMany"
>;

type LegacyQuery<TModel extends DatabaseModel> = {
  readonly distinctOn?: DatabaseDistinctOn<TModel>;
  readonly limit: number;
  readonly offset: number;
  readonly orderBy?: DatabaseOrderBy<TModel>;
  readonly sortBy?: DatabaseSortBy<TModel>;
  readonly where?: readonly DatabaseWhere<TModel>[];
};

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
};

const queryLegacyRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  input: LegacyQuery<TModel>,
): DatabaseRow<TModel>[] => {
  const filtered = queryStandaloneRows(rows, { where: input.where });
  const orderBy = input.orderBy ?? (input.sortBy ? [input.sortBy] : undefined);
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

export const createLegacyReads = (
  remote: StandaloneBundleRemote,
): LegacyReads => ({
  async count(input) {
    switch (input.model) {
      case "bundles": {
        const where = input.where as
          | readonly DatabaseWhere<"bundles">[]
          | undefined;
        if (input.distinct === undefined) {
          const remoteWindow = await remote.loadBundleWindow({
            where,
            limit: 1,
            offset: 0,
          });
          if (remoteWindow) return remoteWindow.total;
        }
        const rows = queryStandaloneRows(await loadRows(remote, "bundles"), {
          where,
        });
        return countDistinctRows(rows, input.distinct);
      }
      case "bundle_patches": {
        const rows = queryStandaloneRows(
          await loadRows(remote, "bundle_patches"),
          { where: input.where },
        );
        return countDistinctRows(rows, input.distinct);
      }
      case "bundle_events":
        return 0;
    }
  },
  async findOne(input) {
    if (input.model === "bundles") {
      const idSelector = input.where?.length === 1 ? input.where[0] : undefined;
      if (
        idSelector?.field === "id" &&
        (idSelector.operator === undefined || idSelector.operator === "eq") &&
        typeof idSelector.value === "string"
      ) {
        const bundle = await remote.loadBundle(idSelector.value);
        const row = bundle ? bundleToRow(bundle) : null;
        return row && matchesStandaloneWhere(row, input.where) ? row : null;
      }
      return (
        queryStandaloneRows(await loadRows(remote, "bundles"), {
          where: input.where,
          limit: 1,
        })[0] ?? null
      );
    }
    if (input.model === "bundle_events") return null;
    return (
      queryStandaloneRows(await loadRows(remote, "bundle_patches"), {
        where: input.where as
          | readonly DatabaseWhere<"bundle_patches">[]
          | undefined,
        limit: 1,
      })[0] ?? null
    );
  },
  async findMany(input) {
    switch (input.model) {
      case "bundles": {
        const where = input.where as
          | readonly DatabaseWhere<"bundles">[]
          | undefined;
        const orderBy =
          input.orderBy ?? (input.sortBy ? [input.sortBy] : undefined);
        const remoteSort =
          orderBy?.length === 1 && orderBy[0]?.field === "id"
            ? orderBy[0]
            : undefined;
        if (
          input.distinctOn === undefined &&
          (orderBy === undefined || remoteSort)
        ) {
          const remoteWindow = await remote.loadBundleWindow({
            where,
            limit: input.limit,
            offset: input.offset,
            sortBy: remoteSort,
          });
          if (remoteWindow) return remoteWindow.rows;
        }
        return queryLegacyRows(await loadRows(remote, "bundles"), {
          distinctOn: input.distinctOn,
          where,
          limit: input.limit,
          offset: input.offset,
          orderBy: input.orderBy,
          sortBy: input.sortBy,
        });
      }
      case "bundle_patches":
        return queryLegacyRows(await loadRows(remote, "bundle_patches"), {
          distinctOn: input.distinctOn,
          where: input.where as
            | readonly DatabaseWhere<"bundle_patches">[]
            | undefined,
          limit: input.limit,
          offset: input.offset,
          orderBy: input.orderBy,
          sortBy: input.sortBy,
        });
      case "bundle_events":
        return [];
    }
  },
});
