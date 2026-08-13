import type {
  BundleRow,
  ReleaseCatalogRow,
  ReleaseRow,
  ReleaseRowUpdate,
} from "@hot-updater/plugin-core";
import { isDatabaseMetadataObject } from "@hot-updater/plugin-core";
import type {
  DatabaseModel,
  DatabaseOrderBy,
  DatabaseSortBy,
} from "@hot-updater/plugin-core/internal";

import type { ORMSQLProvider } from "../db/types";

export type StoredBundleRow = Omit<BundleRow, "metadata"> & {
  readonly metadata: unknown;
};

export type StoredReleaseRow = Omit<ReleaseRow, "target_cohorts"> & {
  readonly target_cohorts: unknown;
};

export type StoredReleaseCatalogRow = Omit<
  ReleaseCatalogRow,
  "is_tombstone"
> & {
  readonly is_tombstone: unknown;
};

type AnyDatabaseSortBy = {
  readonly [TModel in DatabaseModel]: DatabaseSortBy<TModel>;
}[DatabaseModel];
type AnyDatabaseOrderBy = {
  readonly [TModel in DatabaseModel]: DatabaseOrderBy<TModel>;
}[DatabaseModel];
type AnyDatabaseOrderClause = AnyDatabaseSortBy;

class StoredBundleRowError extends Error {
  readonly name = "StoredBundleRowError";
}

const parseStoredBoolean = (value: unknown, field: string): boolean => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new StoredBundleRowError(`Invalid boolean value for ${field}.`);
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return value;
    throw error;
  }
};

const parseTargetCohorts = (value: unknown): readonly string[] | null => {
  if (value === null) return null;
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new StoredBundleRowError("Invalid target_cohorts field.");
  }
  return parsed;
};

const parseMetadata = (value: unknown) => {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isDatabaseMetadataObject(parsed)) {
    throw new StoredBundleRowError("Invalid metadata field.");
  }
  return parsed;
};

const compareOrderValues = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  if (left === right) {
    return 0;
  }
  return String(left).localeCompare(String(right));
};

const normalizeOrderBy = (
  orderBy: AnyDatabaseOrderBy | readonly AnyDatabaseSortBy[] | undefined,
): readonly AnyDatabaseOrderClause[] => {
  if (orderBy === undefined) {
    return [];
  }
  return (
    Array.isArray(orderBy) ? orderBy : [orderBy]
  ) as readonly AnyDatabaseOrderClause[];
};

export const hasNullOrderOverrides = (
  orderBy: AnyDatabaseOrderBy | readonly AnyDatabaseSortBy[] | undefined,
): boolean =>
  normalizeOrderBy(orderBy).some((clause) => clause.nulls !== undefined);

export const sortRowsByOrder = <TRow extends object>(
  rows: readonly TRow[],
  orderBy: AnyDatabaseOrderBy | readonly AnyDatabaseSortBy[] | undefined,
): TRow[] => {
  const clauses = normalizeOrderBy(orderBy);
  if (clauses.length === 0) {
    return [...rows];
  }

  return [...rows].toSorted((left, right) => {
    for (const clause of clauses) {
      const leftValue = Reflect.get(left, clause.field);
      const rightValue = Reflect.get(right, clause.field);

      if (leftValue == null || rightValue == null) {
        if (leftValue == null && rightValue == null) {
          continue;
        }
        const nulls =
          clause.nulls ?? (clause.direction === "asc" ? "last" : "first");
        const order = leftValue == null ? -1 : 1;
        return nulls === "first" ? order : -order;
      }

      const result = compareOrderValues(leftValue, rightValue);
      if (result !== 0) {
        return clause.direction === "desc" ? -result : result;
      }
    }
    return 0;
  });
};

export const fromStoredBundleRow = (row: StoredBundleRow): BundleRow => ({
  ...row,
  metadata: parseMetadata(row.metadata),
});

export const toStoredBundleRow = (
  row: BundleRow,
  provider: ORMSQLProvider,
): StoredBundleRow => {
  if (provider !== "mysql" && provider !== "sqlite") return row;
  return {
    ...row,
    metadata: JSON.stringify(row.metadata),
  };
};

export const toStoredBundleUpdate = (
  update: Partial<Omit<BundleRow, "id">>,
  provider: ORMSQLProvider,
): Partial<Omit<StoredBundleRow, "id">> => {
  if (provider !== "mysql" && provider !== "sqlite") return update;
  return {
    ...update,
    ...("metadata" in update
      ? { metadata: JSON.stringify(update.metadata) }
      : {}),
  };
};

export const fromStoredReleaseRow = (row: StoredReleaseRow): ReleaseRow => ({
  ...row,
  enabled: parseStoredBoolean(row.enabled, "enabled"),
  should_force_update: parseStoredBoolean(
    row.should_force_update,
    "should_force_update",
  ),
  target_cohorts: parseTargetCohorts(row.target_cohorts) ?? [],
});

export const toStoredReleaseRow = (
  row: ReleaseRow,
  provider: ORMSQLProvider,
): StoredReleaseRow => {
  if (provider !== "mysql" && provider !== "sqlite") return row;
  return { ...row, target_cohorts: JSON.stringify(row.target_cohorts) };
};

export const toStoredReleaseUpdate = (
  update: ReleaseRowUpdate,
  provider: ORMSQLProvider,
): Partial<Omit<StoredReleaseRow, "id">> => {
  if (provider !== "mysql" && provider !== "sqlite") return update;
  return {
    ...update,
    ...(update.target_cohorts === undefined
      ? {}
      : { target_cohorts: JSON.stringify(update.target_cohorts) }),
  };
};

export const fromStoredReleaseCatalogRow = (
  row: StoredReleaseCatalogRow,
): ReleaseCatalogRow => ({
  ...row,
  is_tombstone: parseStoredBoolean(row.is_tombstone, "is_tombstone"),
});

export const escapeLikePattern = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

export const escapeGlobPattern = (value: string): string =>
  value.replaceAll("[", "[[]").replaceAll("*", "[*]").replaceAll("?", "[?]");
