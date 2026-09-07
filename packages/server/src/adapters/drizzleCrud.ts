import {
  DatabasePluginInputError,
  type InsightsRecordInput,
} from "@hot-updater/plugin-core";
import type {
  DatabasePluginImplementation,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import { and, asc, desc, eq, lt, or, sql, type SQLWrapper } from "drizzle-orm";

import {
  isChannelDeleteReferencedError,
  translateChannelDeleteError,
} from "./databaseConstraintErrors";
import {
  fromStoredBundleRow,
  fromStoredReleaseCatalogRow,
  fromStoredReleaseRow,
  toStoredBundleRow,
  toStoredBundleUpdate,
  toStoredReleaseRow,
  toStoredReleaseUpdate,
} from "./databasePluginUtils";
import type { DrizzleProvider } from "./drizzle";
import type { DrizzleDB, DrizzleTable } from "./drizzleLazyDB";
import { buildDrizzleWhere } from "./drizzleQuery";

class MissingDrizzleTableError extends Error {
  readonly name = "MissingDrizzleTableError";

  constructor(readonly table: string) {
    super(`Drizzle schema is missing table "${table}".`);
  }
}

class DrizzleAdapterInvariantError extends Error {
  readonly name = "DrizzleAdapterInvariantError";
}

export const getDrizzleTable = (db: DrizzleDB, name: string): DrizzleTable => {
  const table = db._.fullSchema[name];
  if (table === undefined) throw new MissingDrizzleTableError(name);
  return table;
};

const isSQLWrapper = (value: unknown): value is SQLWrapper =>
  typeof value === "object" &&
  value !== null &&
  "getSQL" in value &&
  typeof value.getSQL === "function";

export const getDrizzleColumn = (
  table: DrizzleTable,
  name: string,
): SQLWrapper => {
  const value = table[name];
  if (!isSQLWrapper(value)) {
    throw new MissingDrizzleTableError(`${name} column`);
  }
  return value;
};

const executeInsert = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  table: DrizzleTable,
  data: unknown,
  onConflict: "ignore" | undefined,
): Promise<void> => {
  const builder = db.insert(table);
  const insert = builder.values(data);
  if (onConflict === undefined) {
    await insert.execute();
    return;
  }
  const ignored =
    provider === "mysql"
      ? builder.ignore?.().values(data)
      : insert.onConflictDoNothing?.();
  if (ignored === undefined) throw new DrizzleAdapterInvariantError();
  await ignored.execute();
};

export const recordDrizzleInsights = (
  db: DrizzleDB,
  provider: DrizzleProvider,
  input: InsightsRecordInput,
): void | Promise<void> => {
  if (db.resultKind !== "sync")
    return recordAsyncDrizzleInsights(db, provider, input);
  const events = getDrizzleTable(db, "bundle_events");
  const installations = getDrizzleTable(db, "bundle_installations");
  const eventInsert = db
    .insert(events)
    .values(input.event)
    .onConflictDoNothing?.()
    .returning?.({ id: getDrizzleColumn(events, "id") });
  const installationInsert = db
    .insert(installations)
    .values(input.installation)
    .onConflictDoNothing?.();
  const installationUpdate = db
    .update(installations)
    .set(input.installation)
    .where(newerInstallationWhere(installations, input.installation));
  if (
    eventInsert?.all === undefined ||
    installationInsert?.run === undefined ||
    installationUpdate.run === undefined
  )
    throw new DrizzleAdapterInvariantError();
  if (eventInsert.all().length === 0) return;
  installationInsert.run();
  installationUpdate.run();
};

const newerInstallationWhere = (
  installations: DrizzleTable,
  installation: InsightsRecordInput["installation"],
) => {
  const receivedAt = getDrizzleColumn(installations, "received_at_ms");
  return and(
    eq(getDrizzleColumn(installations, "install_id"), installation.install_id),
    or(
      lt(receivedAt, installation.received_at_ms),
      and(
        eq(receivedAt, installation.received_at_ms),
        lt(getDrizzleColumn(installations, "id"), installation.id),
      ),
    ),
  );
};

const recordAsyncDrizzleInsights = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  { event, installation }: InsightsRecordInput,
): Promise<void> => {
  const events = getDrizzleTable(db, "bundle_events");
  const installations = getDrizzleTable(db, "bundle_installations");
  if (provider === "mysql") {
    const existing = await db.query.bundle_events.findFirst({
      where: eq(getDrizzleColumn(events, "id"), event.id),
    });
    if (existing !== undefined) return;
    await db.insert(events).values(event).execute();
    const insertInstallation = db
      .insert(installations)
      .values(installation)
      .onDuplicateKeyUpdate?.({ set: { install_id: installation.install_id } });
    if (insertInstallation === undefined)
      throw new DrizzleAdapterInvariantError();
    await insertInstallation.execute();
  } else {
    const insert = db.insert(events).values(event).onConflictDoNothing?.();
    const returning = insert?.returning?.({
      id: getDrizzleColumn(events, "id"),
    });
    if (returning === undefined) throw new DrizzleAdapterInvariantError();
    const rows = await returning.execute();
    if (!Array.isArray(rows)) throw new DrizzleAdapterInvariantError();
    if (rows.length === 0) return;
    await executeInsert(db, provider, installations, installation, "ignore");
  }
  await db
    .update(installations)
    .set(installation)
    .where(newerInstallationWhere(installations, installation))
    .execute();
};

const toOrderBy = (
  table: DrizzleTable,
  input: {
    model?: string;
    orderBy?: readonly {
      field: string;
      direction: "asc" | "desc";
      nulls?: "first" | "last";
    }[];
  },
) => {
  const clauses = input.orderBy;
  return clauses?.flatMap((clause) => {
    const column = getDrizzleColumn(table, clause.field);
    if (
      input.model === "bundle_events" ||
      input.model === "bundle_installations"
    ) {
      return [clause.direction === "asc" ? asc(column) : desc(column)];
    }
    const nulls =
      clause.nulls ?? (clause.direction === "asc" ? "last" : "first");
    return [
      nulls === "first"
        ? sql`${column} is null desc`
        : sql`${column} is null asc`,
      clause.direction === "asc" ? asc(column) : desc(column),
    ];
  });
};

export const createDrizzleCrud = (
  db: DrizzleDB,
  provider: DrizzleProvider,
): TransactionDatabasePluginImplementation &
  Pick<DatabasePluginImplementation, "deleteChannel" | "insertChannel"> => {
  const bundles = getDrizzleTable(db, "bundles");
  const patches = getDrizzleTable(db, "bundle_patches");
  const events = getDrizzleTable(db, "bundle_events");
  const installations = getDrizzleTable(db, "bundle_installations");
  const releases = getDrizzleTable(db, "releases");
  const releaseCatalogs = getDrizzleTable(db, "release_catalogs");
  const channels = getDrizzleTable(db, "channels");
  const apiKeys = getDrizzleTable(db, "api_keys");
  return {
    async deleteChannel({ id }) {
      const idPredicate = eq(getDrizzleColumn(channels, "id"), id);
      const existing = await db.query.channels.findFirst({
        where: idPredicate,
      });
      if (existing === undefined) {
        return { deleted: false, reason: "not_found" };
      }
      const referencedReleases = await db.$count(
        releases,
        eq(getDrizzleColumn(releases, "channel_id"), id),
      );
      if (referencedReleases > 0) {
        return { deleted: false, reason: "not_empty" };
      }
      try {
        await db.delete(channels).where(idPredicate).execute();
      } catch (error) {
        if (isChannelDeleteReferencedError(error)) {
          return { deleted: false, reason: "not_empty" };
        }
        throw error;
      }
      return { deleted: true };
    },
    async insertChannel(input) {
      const before = await db.query.channels.findFirst({
        where: eq(getDrizzleColumn(channels, "name"), input.row.name),
      });
      if (before !== undefined) return { row: before, inserted: false };
      await executeInsert(db, provider, channels, input.row, "ignore");
      const row = await db.query.channels.findFirst({
        where: eq(getDrizzleColumn(channels, "name"), input.row.name),
      });
      if (row === undefined) throw new DrizzleAdapterInvariantError();
      return { row, inserted: row.id === input.row.id };
    },
    async create(input) {
      switch (input.model) {
        case "bundles":
          await executeInsert(
            db,
            provider,
            bundles,
            toStoredBundleRow(input.data, provider),
            undefined,
          );
          return input.data;
        case "bundle_patches":
          await executeInsert(db, provider, patches, input.data, undefined);
          return input.data;
        case "bundle_events":
          await executeInsert(db, provider, events, input.data, undefined);
          return input.data;
        case "bundle_installations":
          await executeInsert(
            db,
            provider,
            installations,
            input.data,
            input.onConflict,
          );
          return input.data;
        case "releases":
          await executeInsert(
            db,
            provider,
            releases,
            toStoredReleaseRow(input.data, provider),
            undefined,
          );
          return input.data;
        case "release_catalogs":
          await executeInsert(
            db,
            provider,
            releaseCatalogs,
            input.data,
            undefined,
          );
          return input.data;
        case "api_keys":
          await executeInsert(
            db,
            provider,
            apiKeys,
            input.data,
            input.onConflict,
          );
          return input.data;
        case "channels":
          await executeInsert(
            db,
            provider,
            channels,
            input.data,
            input.onConflict,
          );
          return input.data;
      }
    },
    async update(input) {
      if (input.model === "bundle_installations") {
        const installId = input.where.find(
          (item) =>
            item.field === "install_id" &&
            (item.operator === undefined || item.operator === "eq") &&
            typeof item.value === "string",
        )?.value;
        if (typeof installId !== "string") {
          throw new DrizzleAdapterInvariantError();
        }
        const where = buildDrizzleWhere(provider, installations, input.where);
        if (where === undefined) throw new DrizzleAdapterInvariantError();
        await db.update(installations).set(input.update).where(where).execute();
        const row = await db.query.bundle_installations.findFirst({
          where: eq(getDrizzleColumn(installations, "install_id"), installId),
        });
        return row?.id === input.update.id &&
          row.received_at_ms === input.update.received_at_ms
          ? row
          : null;
      }
      const selector = input.where[0];
      if (selector === undefined || typeof selector.value !== "string") {
        throw new DrizzleAdapterInvariantError();
      }
      if (input.model === "api_keys") {
        const idPredicate = eq(getDrizzleColumn(apiKeys, "id"), selector.value);
        await db.update(apiKeys).set(input.update).where(idPredicate).execute();
        return (
          (await db.query.api_keys.findFirst({
            where: idPredicate,
          })) ?? null
        );
      }
      if (input.model === "releases") {
        const idPredicate = eq(
          getDrizzleColumn(releases, "id"),
          selector.value,
        );
        await db
          .update(releases)
          .set(toStoredReleaseUpdate(input.update, provider))
          .where(idPredicate)
          .execute();
        const row = await db.query.releases.findFirst({ where: idPredicate });
        return row === undefined ? null : fromStoredReleaseRow(row);
      }
      if (input.model === "release_catalogs") {
        const scopePredicate = eq(
          getDrizzleColumn(releaseCatalogs, "scope_key"),
          selector.value,
        );
        await db
          .update(releaseCatalogs)
          .set(input.update)
          .where(scopePredicate)
          .execute();
        const row = await db.query.release_catalogs.findFirst({
          where: scopePredicate,
        });
        return row === undefined ? null : fromStoredReleaseCatalogRow(row);
      }
      const idPredicate = eq(getDrizzleColumn(bundles, "id"), selector.value);
      await db
        .update(bundles)
        .set(toStoredBundleUpdate(input.update, provider))
        .where(idPredicate)
        .execute();
      const stored = await db.query.bundles.findFirst({ where: idPredicate });
      if (stored === undefined) return null;
      return fromStoredBundleRow(stored);
    },
    async delete(input) {
      switch (input.model) {
        case "bundles": {
          const where = buildDrizzleWhere(provider, bundles, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          await db.delete(bundles).where(where).execute();
          return;
        }
        case "bundle_patches": {
          const where = buildDrizzleWhere(provider, patches, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          await db.delete(patches).where(where).execute();
          return;
        }
        case "releases": {
          const where = buildDrizzleWhere(provider, releases, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          await db.delete(releases).where(where).execute();
          return;
        }
        case "channels": {
          const where = buildDrizzleWhere(provider, channels, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          try {
            await db.delete(channels).where(where).execute();
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
        case "bundle_events":
          return db.$count(
            events,
            buildDrizzleWhere(provider, events, input.where),
          );
        case "bundles":
          return db.$count(
            bundles,
            buildDrizzleWhere(provider, bundles, input.where),
          );
        case "bundle_patches":
          return db.$count(
            patches,
            buildDrizzleWhere(provider, patches, input.where),
          );
        case "releases":
          return db.$count(
            releases,
            buildDrizzleWhere(provider, releases, input.where),
          );
        case "bundle_installations":
          return db.$count(
            installations,
            buildDrizzleWhere(provider, installations, input.where),
          );
      }
    },
    async findOne(input) {
      switch (input.model) {
        case "bundles": {
          const row = await db.query.bundles.findFirst({
            where: buildDrizzleWhere(provider, bundles, input.where),
          });
          return row === undefined ? null : fromStoredBundleRow(row);
        }
        case "bundle_patches":
          return (
            (await db.query.bundle_patches.findFirst({
              where: buildDrizzleWhere(provider, patches, input.where),
            })) ?? null
          );
        case "api_keys":
          return (
            (await db.query.api_keys.findFirst({
              where: buildDrizzleWhere(provider, apiKeys, input.where),
            })) ?? null
          );
        case "channels":
          return (
            (await db.query.channels.findFirst({
              where: buildDrizzleWhere(provider, channels, input.where),
            })) ?? null
          );
        case "releases": {
          const row = await db.query.releases.findFirst({
            where: buildDrizzleWhere(provider, releases, input.where),
          });
          return row === undefined ? null : fromStoredReleaseRow(row);
        }
        case "release_catalogs": {
          const row = await db.query.release_catalogs.findFirst({
            where: buildDrizzleWhere(provider, releaseCatalogs, input.where),
          });
          return row === undefined ? null : fromStoredReleaseCatalogRow(row);
        }
        case "bundle_installations":
          return (
            (await db.query.bundle_installations.findFirst({
              where: buildDrizzleWhere(provider, installations, input.where),
            })) ?? null
          );
      }
    },
    async findMany(input) {
      if (input.distinctOn !== undefined) {
        throw new DatabasePluginInputError("invalid-operation");
      }
      switch (input.model) {
        case "bundles": {
          const rows = await db.query.bundles.findMany({
            where: buildDrizzleWhere(provider, bundles, input.where),
            orderBy: toOrderBy(bundles, input),
            limit: input.limit,
            offset: input.offset,
          });
          return rows.map(fromStoredBundleRow);
        }
        case "bundle_events":
          return db.query.bundle_events.findMany({
            where: buildDrizzleWhere(provider, events, input.where),
            orderBy: toOrderBy(events, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "bundle_installations":
          return db.query.bundle_installations.findMany({
            where: buildDrizzleWhere(provider, installations, input.where),
            orderBy: toOrderBy(installations, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "api_keys":
          return db.query.api_keys.findMany({
            where: buildDrizzleWhere(provider, apiKeys, input.where),
            orderBy: toOrderBy(apiKeys, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "bundle_patches":
          return db.query.bundle_patches.findMany({
            where: buildDrizzleWhere(provider, patches, input.where),
            orderBy: toOrderBy(patches, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "channels":
          return db.query.channels.findMany({
            where: buildDrizzleWhere(provider, channels, input.where),
            orderBy: toOrderBy(channels, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "releases": {
          const rows = await db.query.releases.findMany({
            where: buildDrizzleWhere(provider, releases, input.where),
            orderBy: toOrderBy(releases, input),
            limit: input.limit,
            offset: input.offset,
          });
          return rows.map(fromStoredReleaseRow);
        }
        case "release_catalogs": {
          const rows = await db.query.release_catalogs.findMany({
            where: buildDrizzleWhere(provider, releaseCatalogs, input.where),
            orderBy: toOrderBy(releaseCatalogs, input),
            limit: input.limit,
            offset: input.offset,
          });
          return rows.map(fromStoredReleaseCatalogRow);
        }
      }
    },
  };
};
