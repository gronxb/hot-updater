import type {
  Bundle,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
import type { Kysely, Transaction } from "kysely";

import {
  bundleToPatchRows,
  bundleToRow,
  type BundlePatchRow,
  type BundleRow,
  rowToBundle,
} from "../db/bundleRows";
import { createKyselyMigrator } from "../db/fixedMigrator";
import type {
  DatabasePluginFactory,
  ORMSQLProvider,
  RelationMode,
} from "../db/types";

export type { RelationMode, ORMSQLProvider as SQLProvider };

interface Database {
  readonly bundles: BundleRow;
  readonly bundle_patches: BundlePatchRow;
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

export interface KyselyAdapterConfig<TDatabase extends object = Database> {
  readonly db: Kysely<TDatabase>;
  readonly provider: ORMSQLProvider;
  readonly relationMode?: RelationMode;
}

const applyWhere = <T extends object>(
  query: T,
  where: DatabaseBundleQueryWhere | undefined,
): T => {
  let next = query as {
    where: (column: string, op: string, value?: unknown) => unknown;
  };
  if (where?.channel !== undefined)
    next = next.where("channel", "=", where.channel) as typeof next;
  if (where?.platform !== undefined)
    next = next.where("platform", "=", where.platform) as typeof next;
  if (where?.enabled !== undefined)
    next = next.where("enabled", "=", where.enabled) as typeof next;
  if (where?.fingerprintHash !== undefined) {
    next =
      where.fingerprintHash === null
        ? (next.where("fingerprint_hash", "is", null) as typeof next)
        : (next.where(
            "fingerprint_hash",
            "=",
            where.fingerprintHash,
          ) as typeof next);
  }
  if (where?.targetAppVersion !== undefined) {
    next =
      where.targetAppVersion === null
        ? (next.where("target_app_version", "is", null) as typeof next)
        : (next.where(
            "target_app_version",
            "=",
            where.targetAppVersion,
          ) as typeof next);
  }
  if (where?.targetAppVersionIn) {
    next = next.where(
      "target_app_version",
      "in",
      where.targetAppVersionIn,
    ) as typeof next;
  }
  if (where?.targetAppVersionNotNull) {
    next = next.where("target_app_version", "is not", null) as typeof next;
  }
  if (where?.id?.eq) next = next.where("id", "=", where.id.eq) as typeof next;
  if (where?.id?.gt) next = next.where("id", ">", where.id.gt) as typeof next;
  if (where?.id?.gte)
    next = next.where("id", ">=", where.id.gte) as typeof next;
  if (where?.id?.lt) next = next.where("id", "<", where.id.lt) as typeof next;
  if (where?.id?.lte)
    next = next.where("id", "<=", where.id.lte) as typeof next;
  if (where?.id?.in) next = next.where("id", "in", where.id.in) as typeof next;
  return next as T;
};

const toProviderBundleRow = (
  row: BundleRow,
  provider: ORMSQLProvider,
): BundleRow => {
  if (provider !== "mysql") return row;
  return {
    ...row,
    metadata: JSON.stringify(row.metadata ?? {}),
    target_cohorts:
      row.target_cohorts === null || row.target_cohorts === undefined
        ? null
        : JSON.stringify(row.target_cohorts),
  };
};

const createKyselyPlugin = createDatabasePlugin<KyselyAdapterConfig<Database>>({
  name: "kysely",
  factory: ({ db, provider }) => {
    const fetchPatchMap = async (bundleIds: readonly string[]) => {
      const patchMap = new Map<string, BundlePatchRow[]>();
      if (bundleIds.length === 0) return patchMap;
      const rows = await db
        .selectFrom("bundle_patches")
        .selectAll()
        .where("bundle_id", "in", [...bundleIds])
        .orderBy("order_index", "asc")
        .execute();
      for (const row of rows) {
        const current = patchMap.get(row.bundle_id) ?? [];
        current.push(row);
        patchMap.set(row.bundle_id, current);
      }
      return patchMap;
    };

    const upsertBundle = async (
      executor: Kysely<Database> | Transaction<Database>,
      bundle: Bundle,
    ) => {
      const row = toProviderBundleRow(bundleToRow(bundle), provider);
      const { id: _id, ...updateRow } = row;
      if (provider === "mysql") {
        await executor
          .insertInto("bundles")
          .values(row)
          .onDuplicateKeyUpdate(updateRow)
          .execute();
      } else {
        await executor
          .insertInto("bundles")
          .values(row)
          .onConflict((oc) => oc.column("id").doUpdateSet(updateRow))
          .execute();
      }
      await executor
        .deleteFrom("bundle_patches")
        .where("bundle_id", "=", bundle.id)
        .execute();
      const patches = bundleToPatchRows(bundle);
      if (patches.length > 0) {
        await executor.insertInto("bundle_patches").values(patches).execute();
      }
    };

    return {
      async getBundleById(bundleId) {
        const row = await db
          .selectFrom("bundles")
          .selectAll()
          .where("id", "=", bundleId)
          .executeTakeFirst();
        if (!row) return null;
        const patchMap = await fetchPatchMap([bundleId]);
        return rowToBundle(row, patchMap.get(bundleId) ?? []);
      },
      async getBundles(
        options: DatabaseBundleQueryOptions & { offset?: number },
      ) {
        const offset = options.offset ?? 0;
        const orderBy = options.orderBy ?? { field: "id", direction: "desc" };
        const countRow = await applyWhere(
          db.selectFrom("bundles"),
          options.where,
        )
          .select(db.fn.count<number>("id").as("total"))
          .executeTakeFirst();
        const total = Number(countRow?.total ?? 0);
        const rows = await applyWhere(
          db.selectFrom("bundles").selectAll(),
          options.where,
        )
          .orderBy("id", orderBy.direction)
          .limit(options.limit)
          .offset(offset)
          .execute();
        const patchMap = await fetchPatchMap(rows.map((row) => row.id));
        return {
          data: rows.map((row) => rowToBundle(row, patchMap.get(row.id) ?? [])),
          pagination: calculatePagination(total, {
            limit: options.limit,
            offset,
          }),
        };
      },
      async getChannels() {
        const rows = await db
          .selectFrom("bundles")
          .select("channel")
          .orderBy("channel", "asc")
          .execute();
        return Array.from(new Set(rows.map((row) => row.channel)));
      },
      async commitBundle({ changedSets }) {
        await db.transaction().execute(async (tx) => {
          for (const change of changedSets) {
            if (change.operation === "delete") {
              await tx
                .deleteFrom("bundle_patches")
                .where("bundle_id", "=", change.data.id)
                .execute();
              await tx
                .deleteFrom("bundle_patches")
                .where("base_bundle_id", "=", change.data.id)
                .execute();
              await tx
                .deleteFrom("bundles")
                .where("id", "=", change.data.id)
                .execute();
              continue;
            }
            await upsertBundle(tx, change.data);
          }
        });
      },
    };
  },
});

export const kyselyAdapter = <TDatabase extends object>(
  config: KyselyAdapterConfig<TDatabase>,
): DatabasePluginFactory => {
  return Object.assign(
    createKyselyPlugin(config as unknown as KyselyAdapterConfig<Database>),
    {
      adapterName: "kysely",
      provider: config.provider,
      createMigrator: () =>
        createKyselyMigrator({
          db: config.db as unknown as Kysely<{
            private_hot_updater_settings: {
              key: string;
              value: string;
            };
          }>,
          provider: config.provider,
          relationMode: config.relationMode,
        }),
    },
  );
};
