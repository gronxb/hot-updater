import {
  DatabasePluginInputError,
  type InsightsRecordEventInput,
} from "@hot-updater/plugin-core";
import {
  latestInsightsWhere,
  latestInsightsCountGroups,
} from "@hot-updater/plugin-core/internal";
import type {
  DatabasePluginImplementation,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import { or, asc, desc, eq, sql, type SQLWrapper } from "drizzle-orm";

import {
  isChannelDeleteReferencedError,
  translateChannelDeleteError,
} from "./databaseConstraintErrors";
import { fromStoredBundleEventRow } from "./databasePluginUtils";
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
import {
  recordDrizzleInsightsOverview,
  recordDrizzleInsightsOverviewSync,
} from "./drizzleInsightsOverview";
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
  { event }: InsightsRecordEventInput,
): Promise<void> => {
  const events = getDrizzleTable(db, "bundle_events");
  const heads = getDrizzleTable(db, "bundle_event_heads");
  if (db.transaction === undefined) throw new DrizzleAdapterInvariantError();
  if (db.resultKind === "sync") {
    return Promise.resolve(
      db.transaction((transaction) => {
        const query = transaction.query.bundle_event_heads.findFirst({
          where: eq(getDrizzleColumn(heads, "install_id"), event.install_id),
        });
        if (query.sync === undefined) throw new DrizzleAdapterInvariantError();
        const previousHead = query.sync();
        const mutation = transaction
          .insert(events)
          .values(event)
          .onConflictDoNothing?.()
          .returning?.({ id: getDrizzleColumn(events, "id") });
        if (mutation?.all === undefined)
          throw new DrizzleAdapterInvariantError();
        if (mutation.all().length === 0) return;
        recordDrizzleInsightsOverviewSync(
          transaction,
          provider,
          event,
          previousHead,
        );
        if (
          previousHead !== undefined &&
          (event.received_at_ms < previousHead.received_at_ms ||
            (event.received_at_ms === previousHead.received_at_ms &&
              event.id <= previousHead.id))
        ) {
          return;
        }
        const head = drizzleHead(event);
        const update = transaction
          .insert(heads)
          .values(head)
          .onConflictDoUpdate?.({
            target: getDrizzleColumn(heads, "install_id"),
            set: Object.fromEntries(
              Object.keys(head)
                .filter((field) => field !== "install_id")
                .map((field) => [
                  field,
                  sql`excluded.${sql.identifier(field)}`,
                ]),
            ),
            setWhere: sql`excluded.received_at_ms > bundle_event_heads.received_at_ms OR (excluded.received_at_ms = bundle_event_heads.received_at_ms AND excluded.id > bundle_event_heads.id)`,
          });
        if (update?.run === undefined) throw new DrizzleAdapterInvariantError();
        update.run();
      }),
    ).then(() => undefined);
  }
  return db.transaction(async (transaction) => {
    const previousHead = await transaction.query.bundle_event_heads.findFirst({
      where: eq(getDrizzleColumn(heads, "install_id"), event.install_id),
    });
    let accepted = false;
    if (provider === "mysql") {
      const mutation = transaction.insert(events).ignore?.().values(event);
      if (mutation === undefined) throw new DrizzleAdapterInvariantError();
      accepted = affectedRows(await mutation.execute()) > 0;
    } else {
      const mutation = transaction
        .insert(events)
        .values(event)
        .onConflictDoNothing?.();
      const returning = mutation?.returning?.({
        id: getDrizzleColumn(events, "id"),
      });
      if (returning === undefined) throw new DrizzleAdapterInvariantError();
      const rows = await returning.execute();
      accepted = Array.isArray(rows) && rows.length > 0;
    }
    if (!accepted) return;
    await recordDrizzleInsightsOverview(
      transaction,
      provider,
      event,
      previousHead,
    );
    if (
      previousHead !== undefined &&
      (event.received_at_ms < previousHead.received_at_ms ||
        (event.received_at_ms === previousHead.received_at_ms &&
          event.id <= previousHead.id))
    ) {
      return;
    }
    const head = drizzleHead(event);
    const insert = transaction.insert(heads).values(head);
    if (provider === "mysql") {
      const update = insert.onDuplicateKeyUpdate?.({
        set: Object.fromEntries(
          Object.keys(head)
            .filter((field) => field !== "install_id")
            .map((field) => [field, sql`VALUES(${sql.identifier(field)})`]),
        ),
      });
      if (update === undefined) throw new DrizzleAdapterInvariantError();
      await update.execute();
      return;
    }
    const update = insert.onConflictDoUpdate?.({
      target: getDrizzleColumn(heads, "install_id"),
      set: Object.fromEntries(
        Object.keys(head)
          .filter((field) => field !== "install_id")
          .map((field) => [field, sql`excluded.${sql.identifier(field)}`]),
      ),
      setWhere: sql`excluded.received_at_ms > bundle_event_heads.received_at_ms OR (excluded.received_at_ms = bundle_event_heads.received_at_ms AND excluded.id > bundle_event_heads.id)`,
    });
    if (update === undefined) throw new DrizzleAdapterInvariantError();
    await update.execute();
  });
};

const drizzleHead = (event: InsightsRecordEventInput["event"]) => ({
  install_id: event.install_id,
  id: event.id,
  received_at_ms: event.received_at_ms,
  user_id: event.user_id,
  platform: event.platform,
  channel: event.channel,
  type: event.type,
  from_bundle_id: event.from_bundle_id,
  to_bundle_id: event.to_bundle_id,
  current_release_id:
    event.type === "UPDATE_DOWNLOADED"
      ? event.from_release_id
      : event.to_release_id,
  app_version: event.app_version,
});

const affectedRows = (value: unknown): number => {
  if (typeof value !== "object" || value === null) return 0;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + affectedRows(item), 0);
  }
  const count = Reflect.get(value, "affectedRows");
  return typeof count === "number" ? count : 0;
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
    if (input.model === "bundle_events") {
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
  Pick<
    DatabasePluginImplementation,
    | "deleteChannel"
    | "insertChannel"
    | "findLatestInsightsEvents"
    | "countLatestInsightsEvents"
  > => {
  const bundles = getDrizzleTable(db, "bundles");
  const patches = getDrizzleTable(db, "bundle_patches");
  const events = getDrizzleTable(db, "bundle_events");
  const heads = getDrizzleTable(db, "bundle_event_heads");
  const releases = getDrizzleTable(db, "releases");
  const releaseCatalogs = getDrizzleTable(db, "release_catalogs");
  const channels = getDrizzleTable(db, "channels");
  const apiKeys = getDrizzleTable(db, "api_keys");
  return {
    async findLatestInsightsEvents(input) {
      const where = sql.join(
        latestInsightsWhere(input).map((condition) =>
          condition.operator === "gt"
            ? sql`${sql.identifier(condition.field)} > ${condition.value}`
            : sql`${sql.identifier(condition.field)} = ${condition.value}`,
        ),
        sql` AND `,
      );
      const rows = await db.query.bundle_events.findMany({
        where: sql`${getDrizzleColumn(events, "id")} IN (SELECT id FROM (SELECT id FROM bundle_event_heads WHERE ${where} ORDER BY install_id ASC LIMIT ${"installId" in input ? 1 : input.limit}) AS latest)`,
        orderBy: [asc(getDrizzleColumn(events, "install_id"))],
        limit: "installId" in input ? 1 : input.limit,
      });
      return rows.map(fromStoredBundleEventRow);
    },
    async countLatestInsightsEvents(input) {
      const groups = latestInsightsCountGroups(input).map((where) =>
        buildDrizzleWhere(heads, where),
      );
      if (provider === "mysql" && groups.length === 2) {
        const native = db.resolve === undefined ? db : await db.resolve();
        if (!native.select) throw new DrizzleAdapterInvariantError();
        // Separate index ranges in one snapshot, excluding overlap including NULL.
        const result = await native
          .select({
            count: sql`(SELECT COUNT(*) FROM bundle_event_heads WHERE ${groups[0]}) + (SELECT COUNT(*) FROM bundle_event_heads WHERE ${groups[1]} AND (${groups[0]}) IS NOT TRUE)`,
          })
          .from(sql`(SELECT 1) AS counted`)
          .execute();
        const row = result[0];
        const count =
          typeof row === "object" && row !== null
            ? Reflect.get(row, "count")
            : undefined;
        if (
          typeof count !== "number" &&
          typeof count !== "string" &&
          typeof count !== "bigint"
        ) {
          throw new DrizzleAdapterInvariantError();
        }
        return Number(count);
      }
      return db.$count(heads, or(...groups));
    },
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
          const where = buildDrizzleWhere(bundles, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          await db.delete(bundles).where(where).execute();
          return;
        }
        case "bundle_patches": {
          const where = buildDrizzleWhere(patches, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          await db.delete(patches).where(where).execute();
          return;
        }
        case "releases": {
          const where = buildDrizzleWhere(releases, input.where);
          if (where === undefined) throw new DrizzleAdapterInvariantError();
          await db.delete(releases).where(where).execute();
          return;
        }
        case "channels": {
          const where = buildDrizzleWhere(channels, input.where);
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
          return db.$count(events, buildDrizzleWhere(events, input.where));
        case "bundles":
          return db.$count(bundles, buildDrizzleWhere(bundles, input.where));
        case "bundle_patches":
          return db.$count(patches, buildDrizzleWhere(patches, input.where));
        case "releases":
          return db.$count(releases, buildDrizzleWhere(releases, input.where));
      }
    },
    async findOne(input) {
      switch (input.model) {
        case "bundles": {
          const row = await db.query.bundles.findFirst({
            where: buildDrizzleWhere(bundles, input.where),
          });
          return row === undefined ? null : fromStoredBundleRow(row);
        }
        case "bundle_patches":
          return (
            (await db.query.bundle_patches.findFirst({
              where: buildDrizzleWhere(patches, input.where),
            })) ?? null
          );
        case "api_keys":
          return (
            (await db.query.api_keys.findFirst({
              where: buildDrizzleWhere(apiKeys, input.where),
            })) ?? null
          );
        case "channels":
          return (
            (await db.query.channels.findFirst({
              where: buildDrizzleWhere(channels, input.where),
            })) ?? null
          );
        case "releases": {
          const row = await db.query.releases.findFirst({
            where: buildDrizzleWhere(releases, input.where),
          });
          return row === undefined ? null : fromStoredReleaseRow(row);
        }
        case "release_catalogs": {
          const row = await db.query.release_catalogs.findFirst({
            where: buildDrizzleWhere(releaseCatalogs, input.where),
          });
          return row === undefined ? null : fromStoredReleaseCatalogRow(row);
        }
      }
    },
    async findMany(input) {
      switch (input.model) {
        case "bundles": {
          const rows = await db.query.bundles.findMany({
            where: buildDrizzleWhere(bundles, input.where),
            orderBy: toOrderBy(bundles, input),
            limit: input.limit,
            offset: input.offset,
          });
          return rows.map(fromStoredBundleRow);
        }
        case "bundle_events":
          return (
            await db.query.bundle_events.findMany({
              where: buildDrizzleWhere(events, input.where),
              orderBy: toOrderBy(events, input),
              limit: input.limit,
              offset: input.offset,
            })
          ).map(fromStoredBundleEventRow);

        case "api_keys":
          return db.query.api_keys.findMany({
            where: buildDrizzleWhere(apiKeys, input.where),
            orderBy: toOrderBy(apiKeys, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "bundle_patches":
          return db.query.bundle_patches.findMany({
            where: buildDrizzleWhere(patches, input.where),
            orderBy: toOrderBy(patches, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "channels":
          return db.query.channels.findMany({
            where: buildDrizzleWhere(channels, input.where),
            orderBy: toOrderBy(channels, input),
            limit: input.limit,
            offset: input.offset,
          });
        case "releases": {
          const rows = await db.query.releases.findMany({
            where: buildDrizzleWhere(releases, input.where),
            orderBy: toOrderBy(releases, input),
            limit: input.limit,
            offset: input.offset,
          });
          return rows.map(fromStoredReleaseRow);
        }
        case "release_catalogs": {
          const rows = await db.query.release_catalogs.findMany({
            where: buildDrizzleWhere(releaseCatalogs, input.where),
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
