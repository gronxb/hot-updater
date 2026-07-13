import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseModel,
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core";
import type { Document, Filter, Sort } from "mongodb";

type AnyDatabaseWhere = {
  readonly [TModel in DatabaseModel]: DatabaseWhere<TModel>;
}[DatabaseModel];
type AnyDatabaseSortBy = {
  readonly [TModel in DatabaseModel]: DatabaseSortBy<TModel>;
}[DatabaseModel];

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stringExpression = (
  field: string,
  operator: "contains" | "ends_with" | "starts_with",
  value: string,
  mode: "insensitive" | "sensitive" | undefined,
): Document => {
  const escaped = escapeRegularExpression(value);
  const regex =
    operator === "starts_with"
      ? `^${escaped}`
      : operator === "ends_with"
        ? `${escaped}$`
        : escaped;
  return {
    $regexMatch: {
      input: { $ifNull: [`$${field}`, ""] },
      regex,
      ...(mode === "insensitive" ? { options: "i" } : {}),
    },
  };
};

const predicate = (where: AnyDatabaseWhere): Document => {
  const field = `$${where.field}`;
  switch (where.operator) {
    case undefined:
    case "eq":
      return {
        $expr:
          "mode" in where &&
          where.mode === "insensitive" &&
          typeof where.value === "string"
            ? {
                $eq: [
                  { $toLower: { $ifNull: [field, ""] } },
                  where.value.toLocaleLowerCase(),
                ],
              }
            : { $eq: [field, where.value] },
      };
    case "ne": {
      const comparison =
        "mode" in where && where.mode === "insensitive"
          ? {
              $ne: [
                { $toLower: { $ifNull: [field, ""] } },
                where.value.toLocaleLowerCase(),
              ],
            }
          : { $ne: [field, where.value] };
      return where.value === null
        ? { $expr: comparison }
        : {
            $and: [{ $expr: { $ne: [field, null] } }, { $expr: comparison }],
          };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return {
        $and: [
          { $expr: { $ne: [field, null] } },
          { $expr: { [`$${where.operator}`]: [field, where.value] } },
        ],
      };
    case "in":
      return { $expr: { $in: [field, where.value] } };
    case "not_in":
      return where.value.length === 0
        ? { $expr: { $not: [{ $in: [field, where.value] }] } }
        : {
            $and: [
              { $expr: { $ne: [field, null] } },
              { $expr: { $not: [{ $in: [field, where.value] }] } },
            ],
          };
    case "contains":
    case "starts_with":
    case "ends_with":
      return {
        $expr: stringExpression(
          where.field,
          where.operator,
          where.value,
          where.mode,
        ),
      };
  }
};

const createMongoWhereDocument = (
  where: readonly AnyDatabaseWhere[] | undefined,
): Document => {
  const items = where ?? [];
  const first = items[0];
  if (first === undefined) return {};

  let result = predicate(first);
  for (const item of items.slice(1)) {
    result = {
      [item.connector === "OR" ? "$or" : "$and"]: [result, predicate(item)],
    };
  }
  return result;
};

export function createMongoBundleWhere(
  where: readonly DatabaseWhere<"bundles">[] | undefined,
): Filter<BundleRow>;
export function createMongoBundleWhere(
  where: readonly DatabaseWhere<"bundles">[] | undefined,
): Document {
  return createMongoWhereDocument(where);
}

export function createMongoPatchWhere(
  where: readonly DatabaseWhere<"bundle_patches">[] | undefined,
): Filter<BundlePatchRow>;
export function createMongoPatchWhere(
  where: readonly DatabaseWhere<"bundle_patches">[] | undefined,
): Document {
  return createMongoWhereDocument(where);
}

export function createMongoChannelWhere(
  where: readonly DatabaseWhere<"channels">[] | undefined,
): Filter<ChannelRow>;
export function createMongoChannelWhere(
  where: readonly DatabaseWhere<"channels">[] | undefined,
): Document {
  return createMongoWhereDocument(where);
}

export const createMongoSort = (
  sortBy: AnyDatabaseSortBy | undefined,
): Sort | undefined =>
  sortBy === undefined
    ? undefined
    : { [sortBy.field]: sortBy.direction === "asc" ? 1 : -1 };
