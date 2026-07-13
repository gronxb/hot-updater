import type {
  BundlePatchRow,
  ChannelRow,
  DatabaseWhere,
  TransactionDatabaseAdapterImplementation,
} from "@hot-updater/plugin-core";
import { sql, type QueryExecutorProvider, type RawBuilder } from "kysely";

import type { ORMSQLProvider } from "../db/types";
import {
  fromStoredBundleRow,
  type StoredBundleRow,
  toStoredBundleRow,
  toStoredBundleUpdate,
} from "./databaseAdapterUtils";
import { buildKyselyWhere } from "./kyselyQuery";

class KyselyAdapterInvariantError extends Error {
  readonly name = "KyselyAdapterInvariantError";
}

const empty = sql``;

const whereClause = (
  where: RawBuilder<boolean> | undefined,
): RawBuilder<unknown> => (where === undefined ? empty : sql` where ${where}`);

const orderClause = (
  sortBy:
    | { readonly direction: "asc" | "desc"; readonly field: string }
    | undefined,
): RawBuilder<unknown> => {
  if (sortBy === undefined) return empty;
  const field = sql.ref(sortBy.field);
  return sortBy.direction === "asc"
    ? sql` order by ${field} asc`
    : sql` order by ${field} desc`;
};

const insertRow = async (
  executor: QueryExecutorProvider,
  table: string,
  row: object,
): Promise<void> => {
  const entries = Object.entries(row);
  await sql`insert into ${sql.table(table)} (${sql.join(
    entries.map(([field]) => sql.ref(field)),
  )}) values (${sql.join(entries.map(([, value]) => value))})`.execute(
    executor,
  );
};

const updateBundle = async (
  executor: QueryExecutorProvider,
  id: string,
  update: object,
): Promise<void> => {
  const assignments = Object.entries(update)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => sql`${sql.ref(field)} = ${value}`);
  if (assignments.length === 0) return;
  await sql`update ${sql.table("bundles")} set ${sql.join(
    assignments,
  )} where ${sql.ref("id")} = ${id}`.execute(executor);
};

export const findKyselyBundles = async (
  executor: QueryExecutorProvider,
  provider: Exclude<ORMSQLProvider, "mssql">,
  where: readonly DatabaseWhere<"bundles">[],
): Promise<StoredBundleRow[]> => {
  const result = await sql<StoredBundleRow>`select * from ${sql.table(
    "bundles",
  )}${whereClause(buildKyselyWhere(provider, where))} order by ${sql.ref(
    "id",
  )} desc`.execute(executor);
  return [...result.rows];
};

export const findKyselyChannel = async (
  executor: QueryExecutorProvider,
  provider: Exclude<ORMSQLProvider, "mssql">,
  name: string,
): Promise<ChannelRow | null> => {
  const result = await sql<ChannelRow>`select * from ${sql.table(
    "channels",
  )}${whereClause(
    buildKyselyWhere<"channels">(provider, [{ field: "name", value: name }]),
  )} limit 1`.execute(executor);
  return result.rows[0] ?? null;
};

export const findKyselyPatches = async (
  executor: QueryExecutorProvider,
  bundleIds: readonly string[],
): Promise<BundlePatchRow[]> => {
  if (bundleIds.length === 0) return [];
  const result = await sql<BundlePatchRow>`select * from ${sql.table(
    "bundle_patches",
  )} where ${sql.ref("bundle_id")} in (${sql.join(
    bundleIds,
  )}) order by ${sql.ref("order_index")} asc`.execute(executor);
  return [...result.rows];
};

export const createKyselyCrud = (
  executor: QueryExecutorProvider,
  provider: Exclude<ORMSQLProvider, "mssql">,
): TransactionDatabaseAdapterImplementation => ({
  async create(input) {
    switch (input.model) {
      case "bundles":
        await insertRow(
          executor,
          "bundles",
          toStoredBundleRow(input.data, provider),
        );
        return input.data;
      case "bundle_patches":
        await insertRow(executor, "bundle_patches", input.data);
        return input.data;
      case "channels":
        await insertRow(executor, "channels", input.data);
        return input.data;
    }
  },
  async update(input) {
    const selector = input.where[0];
    if (selector === undefined || typeof selector.value !== "string") {
      throw new KyselyAdapterInvariantError();
    }
    const currentResult = await sql<StoredBundleRow>`select * from ${sql.table(
      "bundles",
    )} where ${sql.ref("id")} = ${selector.value} limit 1`.execute(executor);
    const current = currentResult.rows[0];
    if (current === undefined) return null;
    await updateBundle(
      executor,
      selector.value,
      toStoredBundleUpdate(input.update, provider),
    );
    return { ...fromStoredBundleRow(current), ...input.update };
  },
  async delete(input) {
    switch (input.model) {
      case "bundles": {
        const where = buildKyselyWhere(provider, input.where);
        if (where === undefined) throw new KyselyAdapterInvariantError();
        await sql`delete from ${sql.table("bundles")} where ${where}`.execute(
          executor,
        );
        return;
      }
      case "bundle_patches": {
        const where = buildKyselyWhere(provider, input.where);
        if (where === undefined) throw new KyselyAdapterInvariantError();
        await sql`delete from ${sql.table(
          "bundle_patches",
        )} where ${where}`.execute(executor);
      }
    }
  },
  async count(input) {
    const result = await sql<{
      readonly total: bigint | number | string;
    }>`select count(${sql.ref(
      "id",
    )}) as ${sql.ref("total")} from ${sql.table("bundles")}${whereClause(
      buildKyselyWhere(provider, input.where ?? []),
    )}`.execute(executor);
    return Number(result.rows[0]?.total ?? 0);
  },
  async findOne(input) {
    switch (input.model) {
      case "bundles": {
        const where = whereClause(
          buildKyselyWhere(provider, input.where ?? []),
        );
        const result = await sql<StoredBundleRow>`select * from ${sql.table(
          "bundles",
        )}${where} limit 1`.execute(executor);
        const row = result.rows[0];
        return row === undefined ? null : fromStoredBundleRow(row);
      }
      case "channels": {
        const where = whereClause(
          buildKyselyWhere(provider, input.where ?? []),
        );
        const result = await sql<ChannelRow>`select * from ${sql.table(
          "channels",
        )}${where} limit 1`.execute(executor);
        return result.rows[0] ?? null;
      }
    }
  },
  async findMany(input) {
    const pagination = sql` limit ${input.limit} offset ${input.offset}`;
    switch (input.model) {
      case "bundles": {
        const where = whereClause(
          buildKyselyWhere(provider, input.where ?? []),
        );
        const order = orderClause(input.sortBy);
        const result = await sql<StoredBundleRow>`select * from ${sql.table(
          "bundles",
        )}${where}${order}${pagination}`.execute(executor);
        return result.rows.map(fromStoredBundleRow);
      }
      case "bundle_patches": {
        const where = whereClause(
          buildKyselyWhere(provider, input.where ?? []),
        );
        const order = orderClause(input.sortBy);
        const result = await sql<BundlePatchRow>`select * from ${sql.table(
          "bundle_patches",
        )}${where}${order}${pagination}`.execute(executor);
        return [...result.rows];
      }
      case "channels": {
        const where = whereClause(
          buildKyselyWhere(provider, input.where ?? []),
        );
        const order = orderClause(input.sortBy);
        const result = await sql<ChannelRow>`select * from ${sql.table(
          "channels",
        )}${where}${order}${pagination}`.execute(executor);
        return [...result.rows];
      }
    }
  },
});
