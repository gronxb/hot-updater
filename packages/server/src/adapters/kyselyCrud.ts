import {
  DatabasePluginInputError,
  type BundleEventRow,
  type BundlePatchRow,
  type ChannelRow,
  type ApiKeyRow,
  type ReleaseCatalogRow,
} from "@hot-updater/plugin-core";
import type {
  DatabaseModel,
  DatabasePluginImplementation,
  DatabaseWhere,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import { sql, type QueryExecutorProvider, type RawBuilder } from "kysely";

import type { ORMSQLProvider, RelationMode } from "../db/types";
import {
  isChannelDeleteReferencedError,
  translateChannelDeleteError,
} from "./databaseConstraintErrors";
import {
  fromStoredBundleRow,
  fromStoredReleaseCatalogRow,
  fromStoredReleaseRow,
  type StoredBundleRow,
  type StoredReleaseRow,
  toStoredBundleRow,
  toStoredBundleUpdate,
  toStoredReleaseRow,
  toStoredReleaseUpdate,
} from "./databasePluginUtils";
import { buildKyselyWhere } from "./kyselyQuery";

class KyselyAdapterInvariantError extends Error {
  readonly name = "KyselyAdapterInvariantError";

  constructor(readonly reason: string) {
    super(`Kysely plugin invariant failed: ${reason}`);
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
  input:
    | {
        readonly model: DatabaseModel;
        readonly orderBy?: readonly {
          readonly direction: "asc" | "desc";
          readonly field: string;
          readonly nulls?: "first" | "last";
        }[];
      }
    | undefined,
): RawBuilder<unknown> => {
  const clauses = input?.orderBy;
  if (clauses === undefined || clauses.length === 0) return empty;
  return sql` order by ${sql.join(
    clauses.map((clause) => {
      const field = sql.ref(clause.field);
      const valueOrder =
        clause.direction === "asc" ? sql`${field} asc` : sql`${field} desc`;
      // These NOT NULL event columns can use their index order directly.
      if (
        input?.model === "bundle_events" &&
        (clause.field === "id" || clause.field === "received_at_ms")
      ) {
        return valueOrder;
      }
      const nulls =
        clause.nulls ?? (clause.direction === "asc" ? "last" : "first");
      const nullOrder =
        nulls === "first"
          ? sql`${field} is null desc`
          : sql`${field} is null asc`;
      return sql`${nullOrder}, ${valueOrder}`;
    }),
    sql`, `,
  )}`;
};

const insertRow = async (
  executor: QueryExecutorProvider,
  table: string,
  row: object,
  provider: Exclude<ORMSQLProvider, "mssql">,
  onConflict: "ignore" | undefined = undefined,
): Promise<boolean> => {
  const entries = Object.entries(row);
  const columns = sql.join(entries.map(([field]) => sql.ref(field)));
  const values = sql.join(entries.map(([, value]) => value));
  const result =
    onConflict === undefined
      ? await sql`insert into ${sql.table(table)} (${columns}) values (${values})`.execute(
          executor,
        )
      : provider === "mysql"
        ? await sql`insert ignore into ${sql.table(table)} (${columns}) values (${values})`.execute(
            executor,
          )
        : provider === "sqlite"
          ? await sql`insert or ignore into ${sql.table(table)} (${columns}) values (${values})`.execute(
              executor,
            )
          : await sql`insert into ${sql.table(table)} (${columns}) values (${values}) on conflict do nothing`.execute(
              executor,
            );
  return Number(result.numAffectedRows ?? 0) > 0;
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

const updateApiKey = async (
  executor: QueryExecutorProvider,
  id: string,
  revokedAtMs: number | null,
): Promise<void> => {
  await sql`update ${sql.table("api_keys")} set ${sql.ref(
    "revoked_at_ms",
  )} = ${revokedAtMs} where ${sql.ref("id")} = ${id}`.execute(executor);
};

const updateRow = async (
  executor: QueryExecutorProvider,
  table: string,
  keyField: string,
  key: string,
  update: object,
): Promise<void> => {
  const assignments = Object.entries(update)
    .filter(([, value]) => value !== undefined)
    .map(([field, value]) => sql`${sql.ref(field)} = ${value}`);
  if (assignments.length === 0) return;
  await sql`update ${sql.table(table)} set ${sql.join(
    assignments,
  )} where ${sql.ref(keyField)} = ${key}`.execute(executor);
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
  const result = await sql<{ readonly id: string }>`select ${sql.ref(
    "id",
  )} from ${sql.table("bundles")} where ${sql.ref("id")} in (${sql.join(
    ids,
  )}) order by ${sql.ref("id")}${lockClause(provider, relationMode)}`.execute(
    executor,
  );
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

const countRows = async (
  executor: QueryExecutorProvider,
  table: string,
  where: RawBuilder<boolean> | undefined,
): Promise<number> => {
  const result = await sql<{
    readonly total: bigint | number | string;
  }>`select count(${sql.ref(
    "id",
  )}) as ${sql.ref("total")} from ${sql.table(table)}${whereClause(where)}`.execute(
    executor,
  );
  return Number(result.rows[0]?.total ?? 0);
};

export const createKyselyCrud = (
  executor: QueryExecutorProvider,
  provider: Exclude<ORMSQLProvider, "mssql">,
  relationMode: RelationMode = "foreign-keys",
): TransactionDatabasePluginImplementation &
  Pick<DatabasePluginImplementation, "deleteChannel" | "insertChannel"> => ({
  async deleteChannel({ id }) {
    const existing = await sql<ChannelRow>`select ${sql.ref("id")}, ${sql.ref(
      "name",
    )} from ${sql.table("channels")} where ${sql.ref(
      "id",
    )} = ${id} limit 1${lockClause(provider, relationMode)}`.execute(executor);
    if (existing.rows[0] === undefined) {
      return { deleted: false, reason: "not_found" };
    }
    const referencedReleases = await countRows(
      executor,
      "releases",
      sql<boolean>`${sql.ref("channel_id")} = ${id}`,
    );
    if (referencedReleases > 0) {
      return { deleted: false, reason: "not_empty" };
    }
    try {
      await sql`delete from ${sql.table("channels")} where ${sql.ref(
        "id",
      )} = ${id}`.execute(executor);
    } catch (error) {
      if (isChannelDeleteReferencedError(error)) {
        return { deleted: false, reason: "not_empty" };
      }
      throw error;
    }
    return { deleted: true };
  },
  async insertChannel(input) {
    const inserted = await insertRow(
      executor,
      "channels",
      input.row,
      provider,
      "ignore",
    );
    const result = await sql<ChannelRow>`select ${sql.ref("id")}, ${sql.ref(
      "name",
    )} from ${sql.table("channels")} where ${sql.ref("name")} = ${
      input.row.name
    } limit 1`.execute(executor);
    const row = result.rows[0];
    if (row === undefined) {
      throw new KyselyAdapterInvariantError("channels.insert.return-existing");
    }
    return { row, inserted };
  },
  async create(input) {
    switch (input.model) {
      case "bundles":
        await insertRow(
          executor,
          "bundles",
          toStoredBundleRow(input.data, provider),
          provider,
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
        await insertRow(executor, "bundle_patches", input.data, provider);
        return input.data;
      case "bundle_events":
        await insertRow(executor, "bundle_events", input.data, provider);
        return input.data;
      case "releases":
        await insertRow(
          executor,
          "releases",
          toStoredReleaseRow(input.data, provider),
          provider,
        );
        return input.data;
      case "release_catalogs":
        await insertRow(executor, "release_catalogs", input.data, provider);
        return input.data;
      case "api_keys":
        await insertRow(
          executor,
          "api_keys",
          input.data,
          provider,
          input.onConflict,
        );
        return input.data;
      case "channels":
        await insertRow(
          executor,
          "channels",
          input.data,
          provider,
          input.onConflict,
        );
        return input.data;
    }
  },
  async update(input) {
    const selector = input.where[0];
    if (selector === undefined || typeof selector.value !== "string") {
      throw new KyselyAdapterInvariantError(`${input.model}.update.selector`);
    }
    if (input.model === "api_keys") {
      await updateApiKey(executor, selector.value, input.update.revoked_at_ms);
      const result = await sql<ApiKeyRow>`select * from ${sql.table(
        "api_keys",
      )} where ${sql.ref("id")} = ${selector.value} limit 1`.execute(executor);
      return result.rows[0] ?? null;
    }
    if (input.model === "releases") {
      await updateRow(
        executor,
        "releases",
        "id",
        selector.value,
        toStoredReleaseUpdate(input.update, provider),
      );
      const result = await sql<StoredReleaseRow>`select * from ${sql.table(
        "releases",
      )} where ${sql.ref("id")} = ${selector.value} limit 1`.execute(executor);
      const row = result.rows[0];
      return row === undefined ? null : fromStoredReleaseRow(row);
    }
    if (input.model === "release_catalogs") {
      await updateRow(
        executor,
        "release_catalogs",
        "scope_key",
        selector.value,
        input.update,
      );
      const result = await sql<ReleaseCatalogRow>`select * from ${sql.table(
        "release_catalogs",
      )} where ${sql.ref("scope_key")} = ${selector.value} limit 1`.execute(
        executor,
      );
      const row = result.rows[0];
      return row === undefined ? null : fromStoredReleaseCatalogRow(row);
    }
    await updateBundle(
      executor,
      selector.value,
      toStoredBundleUpdate(input.update, provider),
    );
    const result = await sql<StoredBundleRow>`select * from ${sql.table(
      "bundles",
    )} where ${sql.ref("id")} = ${selector.value} limit 1`.execute(executor);
    const stored = result.rows[0];
    if (stored === undefined) return null;
    return fromStoredBundleRow(stored);
  },
  async delete(input) {
    switch (input.model) {
      case "bundles": {
        const where = buildKyselyWhere(provider, input.where);
        if (where === undefined) {
          throw new KyselyAdapterInvariantError("bundles.delete.where");
        }
        if (relationMode === "fumadb") {
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
          )} in (${sql.join(bundleIds)}) or ${sql.ref("base_bundle_id")} in (${sql.join(
            bundleIds,
          )})`.execute(executor);
        }
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
        await sql`delete from ${sql.table("bundle_patches")} where ${where}`.execute(
          executor,
        );
        return;
      }
      case "releases": {
        const where = buildKyselyWhere(provider, input.where);
        if (where === undefined) {
          throw new KyselyAdapterInvariantError("releases.delete.where");
        }
        await sql`delete from ${sql.table("releases")} where ${where}`.execute(
          executor,
        );
        return;
      }
      case "channels": {
        const where = buildKyselyWhere(provider, input.where);
        if (where === undefined) {
          throw new KyselyAdapterInvariantError("channels.delete.where");
        }
        try {
          await sql`delete from ${sql.table(
            "channels",
          )} where ${where}`.execute(executor);
        } catch (error) {
          translateChannelDeleteError(error);
        }
        return;
      }
    }
  },
  async count(input) {
    if (input.distinct !== undefined) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    switch (input.model) {
      case "bundles":
        return countRows(
          executor,
          "bundles",
          buildKyselyWhere(provider, input.where),
        );
      case "bundle_patches":
        return countRows(
          executor,
          "bundle_patches",
          buildKyselyWhere(provider, input.where),
        );
      case "releases":
        return countRows(
          executor,
          "releases",
          buildKyselyWhere(provider, input.where),
        );
    }
  },
  async findOne(input) {
    switch (input.model) {
      case "bundles": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const result = await sql<StoredBundleRow>`select * from ${sql.table(
          "bundles",
        )}${where} limit 1`.execute(executor);
        const row = result.rows[0];
        return row === undefined ? null : fromStoredBundleRow(row);
      }
      case "bundle_patches": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const result = await sql<BundlePatchRow>`select * from ${sql.table(
          "bundle_patches",
        )}${where} limit 1`.execute(executor);
        return result.rows[0] ?? null;
      }
      case "api_keys": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const result = await sql<ApiKeyRow>`select * from ${sql.table(
          "api_keys",
        )}${where} limit 1`.execute(executor);
        return result.rows[0] ?? null;
      }
      case "channels": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const result = await sql<ChannelRow>`select * from ${sql.table(
          "channels",
        )}${where} limit 1`.execute(executor);
        return result.rows[0] ?? null;
      }
      case "releases": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const result = await sql<StoredReleaseRow>`select * from ${sql.table(
          "releases",
        )}${where} limit 1`.execute(executor);
        const row = result.rows[0];
        return row === undefined ? null : fromStoredReleaseRow(row);
      }
      case "release_catalogs": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const result = await sql<ReleaseCatalogRow>`select * from ${sql.table(
          "release_catalogs",
        )}${where} limit 1`.execute(executor);
        const row = result.rows[0];
        return row === undefined ? null : fromStoredReleaseCatalogRow(row);
      }
    }
  },
  async findMany(input) {
    if (input.distinctOn !== undefined) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    const pagination = sql` limit ${input.limit} offset ${input.offset}`;
    switch (input.model) {
      case "bundles": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const order = orderClause(input);
        const result = await sql<StoredBundleRow>`select * from ${sql.table(
          "bundles",
        )}${where}${order}${pagination}`.execute(executor);
        return result.rows.map(fromStoredBundleRow);
      }
      case "bundle_patches": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const order = orderClause(input);
        const result = await sql<BundlePatchRow>`select * from ${sql.table(
          "bundle_patches",
        )}${where}${order}${pagination}`.execute(executor);
        return [...result.rows];
      }
      case "bundle_events": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const order = orderClause(input);
        const result = await sql<BundleEventRow>`select * from ${sql.table(
          "bundle_events",
        )}${where}${order}${pagination}`.execute(executor);
        return [...result.rows];
      }
      case "api_keys": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const order = orderClause(input);
        const result = await sql<ApiKeyRow>`select * from ${sql.table(
          "api_keys",
        )}${where}${order}${pagination}`.execute(executor);
        return [...result.rows];
      }
      case "channels": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const order = orderClause(input);
        const result = await sql<ChannelRow>`select * from ${sql.table(
          "channels",
        )}${where}${order}${pagination}`.execute(executor);
        return [...result.rows];
      }
      case "releases": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const order = orderClause(input);
        const result = await sql<StoredReleaseRow>`select * from ${sql.table(
          "releases",
        )}${where}${order}${pagination}`.execute(executor);
        return result.rows.map(fromStoredReleaseRow);
      }
      case "release_catalogs": {
        const where = whereClause(buildKyselyWhere(provider, input.where));
        const order = orderClause(input);
        const result = await sql<ReleaseCatalogRow>`select * from ${sql.table(
          "release_catalogs",
        )}${where}${order}${pagination}`.execute(executor);
        return result.rows.map(fromStoredReleaseCatalogRow);
      }
    }
  },
});
