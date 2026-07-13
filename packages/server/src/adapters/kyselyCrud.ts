import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseWhere,
  TransactionDatabaseAdapterImplementation,
} from "@hot-updater/plugin-core";
import { sql, type QueryExecutorProvider, type RawBuilder } from "kysely";

import type { ORMSQLProvider, RelationMode } from "../db/types";
import {
  fromStoredBundleRow,
  type StoredBundleRow,
  toStoredBundleRow,
  toStoredBundleUpdate,
} from "./databaseAdapterUtils";
import { buildKyselyWhere } from "./kyselyQuery";

class KyselyAdapterInvariantError extends Error {
  readonly name = "KyselyAdapterInvariantError";

  constructor(readonly reason: string) {
    super(`Kysely adapter invariant failed: ${reason}`);
  }
}

const empty = sql``;

const lockClause = (
  provider: Exclude<ORMSQLProvider, "mssql">,
  relationMode: RelationMode,
): RawBuilder<unknown> =>
  relationMode === "fumadb" && provider !== "sqlite" ? sql` for update` : empty;

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
  targetPredicate: RawBuilder<boolean> | undefined,
): Promise<void> => {
  const assignments = Object.entries(update)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => sql`${sql.ref(field)} = ${value}`);
  if (assignments.length === 0) return;
  await sql`update ${sql.table("bundles")} set ${sql.join(
    assignments,
  )} where ${sql.ref("id")} = ${id}${
    targetPredicate === undefined ? empty : sql` and ${targetPredicate}`
  }`.execute(executor);
};

const createBundleTargetPredicate = (
  update: Partial<BundleRow>,
): RawBuilder<boolean> | undefined => {
  if (update.target_app_version === null && update.fingerprint_hash === null) {
    throw new KyselyAdapterInvariantError("bundles.update.target");
  }
  if (
    update.target_app_version === null &&
    update.fingerprint_hash === undefined
  ) {
    return sql<boolean>`${sql.ref("fingerprint_hash")} is not null`;
  }
  if (
    update.fingerprint_hash === null &&
    update.target_app_version === undefined
  ) {
    return sql<boolean>`${sql.ref("target_app_version")} is not null`;
  }
  return undefined;
};

const assertChannelReference = async (
  executor: QueryExecutorProvider,
  channelId: string,
  channel: string,
): Promise<void> => {
  const result = await sql<{
    readonly name: string;
  }>`select ${sql.ref("name")} from ${sql.table(
    "channels",
  )} where ${sql.ref("id")} = ${channelId} limit 1`.execute(executor);
  if (result.rows[0]?.name !== channel) {
    throw new KyselyAdapterInvariantError("bundles.channel_id.foreign-key");
  }
};

const assertBundleReferences = async (
  executor: QueryExecutorProvider,
  provider: Exclude<ORMSQLProvider, "mssql">,
  relationMode: RelationMode,
  bundleId: string,
  baseBundleId: string,
): Promise<void> => {
  const ids = [...new Set([bundleId, baseBundleId])].sort((left, right) =>
    left.localeCompare(right),
  );
  const result = await sql<{
    readonly id: string;
  }>`select ${sql.ref("id")} from ${sql.table(
    "bundles",
  )} where ${sql.ref("id")} in (${sql.join(ids)}) order by ${sql.ref(
    "id",
  )}${lockClause(provider, relationMode)}`.execute(executor);
  const storedIds = new Set(result.rows.map(({ id }) => id));
  if (!storedIds.has(bundleId)) {
    throw new KyselyAdapterInvariantError(
      "bundle_patches.bundle_id.foreign-key",
    );
  }
  if (!storedIds.has(baseBundleId)) {
    throw new KyselyAdapterInvariantError(
      "bundle_patches.base_bundle_id.foreign-key",
    );
  }
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
  relationMode: RelationMode = "foreign-keys",
): TransactionDatabaseAdapterImplementation => ({
  async create(input) {
    switch (input.model) {
      case "bundles":
        await assertChannelReference(
          executor,
          input.data.channel_id,
          input.data.channel,
        );
        await insertRow(
          executor,
          "bundles",
          toStoredBundleRow(input.data, provider),
        );
        return input.data;
      case "bundle_patches":
        await assertBundleReferences(
          executor,
          provider,
          relationMode,
          input.data.bundle_id,
          input.data.base_bundle_id,
        );
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
      throw new KyselyAdapterInvariantError("bundles.update.selector");
    }
    if (
      input.update.channel_id !== undefined &&
      input.update.channel !== undefined
    ) {
      await assertChannelReference(
        executor,
        input.update.channel_id,
        input.update.channel,
      );
    }
    await updateBundle(
      executor,
      selector.value,
      toStoredBundleUpdate(input.update, provider),
      createBundleTargetPredicate(input.update),
    );
    const result = await sql<StoredBundleRow>`select * from ${sql.table(
      "bundles",
    )} where ${sql.ref("id")} = ${selector.value} limit 1`.execute(executor);
    const stored = result.rows[0];
    if (stored === undefined) return null;
    const updated = fromStoredBundleRow(stored);
    if (
      (input.update.target_app_version !== undefined &&
        updated.target_app_version !== input.update.target_app_version) ||
      (input.update.fingerprint_hash !== undefined &&
        updated.fingerprint_hash !== input.update.fingerprint_hash)
    ) {
      throw new KyselyAdapterInvariantError("bundles.update.target");
    }
    return updated;
  },
  async delete(input) {
    switch (input.model) {
      case "bundles": {
        const where = buildKyselyWhere(provider, input.where);
        if (where === undefined) {
          throw new KyselyAdapterInvariantError("bundles.delete.where");
        }
        const matchingBundles = await sql<{
          readonly id: string;
        }>`select ${sql.ref(
          "id",
        )} from ${sql.table("bundles")} where ${where} order by ${sql.ref(
          "id",
        )}${lockClause(provider, relationMode)}`.execute(executor);
        const bundleIds = matchingBundles.rows.map(({ id }) => id);
        if (bundleIds.length === 0) return;
        await sql`delete from ${sql.table("bundle_patches")} where ${sql.ref(
          "bundle_id",
        )} in (${sql.join(bundleIds)}) or ${sql.ref(
          "base_bundle_id",
        )} in (${sql.join(bundleIds)})`.execute(executor);
        await sql`delete from ${sql.table("bundles")} where ${where}`.execute(
          executor,
        );
        return;
      }
      case "bundle_patches": {
        const where = buildKyselyWhere(provider, input.where);
        if (where === undefined) {
          throw new KyselyAdapterInvariantError("bundle_patches.delete.where");
        }
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
