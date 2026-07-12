import type { BundleRow } from "@hot-updater/plugin-core";

import type { ORMSQLProvider } from "../db/types";

export type StoredBundleRow = Omit<BundleRow, "metadata" | "target_cohorts"> & {
  readonly metadata: unknown;
  readonly target_cohorts: unknown;
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
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((item): item is string => typeof item === "string");
};

export const fromStoredBundleRow = (row: StoredBundleRow): BundleRow => ({
  ...row,
  metadata:
    typeof row.metadata === "string" ? parseJson(row.metadata) : row.metadata,
  target_cohorts: parseTargetCohorts(row.target_cohorts),
});

export const toStoredBundleRow = (
  row: BundleRow,
  provider: ORMSQLProvider,
): StoredBundleRow => {
  if (provider !== "mysql" && provider !== "sqlite") return row;
  return {
    ...row,
    metadata: JSON.stringify(row.metadata ?? {}),
    target_cohorts:
      row.target_cohorts === null ? null : JSON.stringify(row.target_cohorts),
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
      ? { metadata: JSON.stringify(update.metadata ?? {}) }
      : {}),
    ...(update.target_cohorts !== undefined
      ? {
          target_cohorts:
            update.target_cohorts === null
              ? null
              : JSON.stringify(update.target_cohorts),
        }
      : {}),
  };
};

export const escapeLikePattern = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

export const escapeGlobPattern = (value: string): string =>
  value.replaceAll("[", "[[]").replaceAll("*", "[*]").replaceAll("?", "[?]");
