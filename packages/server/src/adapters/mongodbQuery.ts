import type {
  ApiKeyRow,
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import type {
  DatabaseModel,
  DatabaseOrderBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core/internal";
import type { Document, Filter, Sort } from "mongodb";

type AnyDatabaseWhere = {
  readonly [TModel in DatabaseModel]: DatabaseWhere<TModel>;
}[DatabaseModel];
type AnyDatabaseOrderBy = {
  readonly [TModel in DatabaseModel]: DatabaseOrderBy<TModel>;
}[DatabaseModel];

function literal(value: unknown): Document {
  return { $literal: value };
}

const predicate = (where: AnyDatabaseWhere): Document => {
  const field = `$${where.field}`;
  switch (where.operator) {
    case undefined:
    case "eq":
      return { $expr: { $eq: [field, literal(where.value)] } };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return {
        $and: [
          { $expr: { $ne: [field, null] } },
          { $expr: { [`$${where.operator}`]: [field, literal(where.value)] } },
        ],
      };
    case "in":
      return { $expr: { $in: [field, literal(where.value)] } };
  }
};

const createMongoWhereDocument = (
  where: readonly AnyDatabaseWhere[] | undefined,
  toPredicate: (condition: AnyDatabaseWhere) => Document = predicate,
): Document => {
  const items = Array.isArray(where) ? where : [];
  const first = items[0];
  if (first === undefined) return {};

  let result = toPredicate(first);
  for (const item of items.slice(1)) {
    result = { $and: [result, toPredicate(item)] };
  }
  return result;
};

// Fixed Insights predicates use native fields so equality/range indexes apply.
const insightsPredicate = (where: AnyDatabaseWhere): Document => {
  switch (where.operator) {
    case undefined:
    case "eq":
      return { [where.field]: { $eq: where.value } };
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "in":
      return { [where.field]: { [`$${where.operator}`]: where.value } };
  }
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

export function createMongoEventWhere(
  where: readonly DatabaseWhere<"bundle_events">[] | undefined,
): Filter<BundleEventRow>;
export function createMongoEventWhere(
  where: readonly DatabaseWhere<"bundle_events">[] | undefined,
): Document {
  return createMongoWhereDocument(where, insightsPredicate);
}

export function createMongoApiKeyWhere(
  where: readonly DatabaseWhere<"api_keys">[] | undefined,
): Filter<ApiKeyRow>;
export function createMongoApiKeyWhere(
  where: readonly DatabaseWhere<"api_keys">[] | undefined,
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

export function createMongoReleaseWhere(
  where: readonly DatabaseWhere<"releases">[] | undefined,
): Filter<ReleaseRow>;
export function createMongoReleaseWhere(
  where: readonly DatabaseWhere<"releases">[] | undefined,
): Document {
  return createMongoWhereDocument(where);
}

export function createMongoReleaseCatalogWhere(
  where: readonly DatabaseWhere<"release_catalogs">[] | undefined,
): Filter<ReleaseCatalogRow>;
export function createMongoReleaseCatalogWhere(
  where: readonly DatabaseWhere<"release_catalogs">[] | undefined,
): Document {
  return createMongoWhereDocument(where);
}

export const createMongoSort = (
  input:
    | {
        readonly orderBy?: AnyDatabaseOrderBy;
      }
    | AnyDatabaseOrderBy
    | undefined,
): Sort | undefined => {
  const clauses:
    | readonly { field: string; direction: "asc" | "desc" }[]
    | undefined = Array.isArray(input)
    ? (input as readonly { field: string; direction: "asc" | "desc" }[])
    : input && "orderBy" in input && Array.isArray(input.orderBy)
      ? (input.orderBy as readonly {
          field: string;
          direction: "asc" | "desc";
        }[])
      : undefined;
  if (clauses === undefined || clauses.length === 0) return undefined;
  return Object.fromEntries(
    clauses.map((clause) => [
      clause.field,
      clause.direction === "asc" ? 1 : -1,
    ]),
  );
};
