import { NIL_UUID, type UpdateInfo } from "@hot-updater/core";
import type {
  BundleEventListQuery,
  BundleEventPayload,
  BundlePatchListQuery,
  CursorPage,
  DatabaseBundleEvent,
  DatabaseBundlePatch,
  DatabaseBundleQueryWhere,
  DatabaseBundleRecord,
  DatabasePluginCore,
  GetBundlesArgs,
  Platform,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
  filterCompatibleAppVersions,
  toBundleReadModel,
  toDatabaseBundleRecord,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import {
  BUNDLE_SELECT_COLUMNS,
  bundleToRow,
  mapRowToBundle,
} from "./supabaseBundleMapper";
import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import type { SupabaseBundlePatchRow } from "./types";
import type { SupabaseBundleEventRow } from "./types";

export type SupabaseDatabaseConfig = SupabaseServiceRoleConfig;

type SupabaseUpdateInfoRow = {
  id: string;
  should_force_update: boolean;
  message: string | null;
  status: "UPDATE" | "ROLLBACK";
  storage_uri: string | null;
  file_hash: string | null;
};

type SupabaseTargetAppVersionRow = {
  target_app_version: string | null;
};

const createSupabaseError = (error: unknown) => {
  if (error instanceof Error) {
    return error;
  }

  if (error && typeof error === "object") {
    const properties: Record<string, unknown> = {};
    let target: object | null = error;
    while (target && target !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(target)) {
        properties[key] = (error as Record<string, unknown>)[key];
      }
      target = Object.getPrototypeOf(target);
    }

    return new Error(
      JSON.stringify({
        name: error.constructor.name,
        ...properties,
      }),
    );
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
};

const mapUpdateInfoRow = (row: SupabaseUpdateInfoRow): UpdateInfo => ({
  id: row.id,
  shouldForceUpdate: row.should_force_update,
  message: row.message,
  status: row.status,
  storageUri: row.storage_uri,
  fileHash: row.file_hash,
});

const buildBundlePatchId = (bundleId: string, baseBundleId: string) =>
  `${bundleId}:${baseBundleId}`;

const rowToDatabaseBundleRecord = (row: Parameters<typeof mapRowToBundle>[0]) =>
  toDatabaseBundleRecord(mapRowToBundle(row));

const databaseBundleRecordToRow = (bundle: DatabaseBundleRecord) =>
  bundleToRow(toBundleReadModel(bundle));

const rowToDatabaseBundlePatch = (
  row: SupabaseBundlePatchRow,
): DatabaseBundlePatch => ({
  id: row.id,
  bundleId: row.bundle_id,
  baseBundleId: row.base_bundle_id,
  baseFileHash: row.base_file_hash,
  patchFileHash: row.patch_file_hash,
  patchStorageUri: row.patch_storage_uri,
  orderIndex: row.order_index,
});

const databaseBundlePatchToRow = (
  patch: DatabaseBundlePatch,
): SupabaseBundlePatchRow => ({
  id: patch.id ?? buildBundlePatchId(patch.bundleId, patch.baseBundleId),
  bundle_id: patch.bundleId,
  base_bundle_id: patch.baseBundleId,
  base_file_hash: patch.baseFileHash,
  patch_file_hash: patch.patchFileHash,
  patch_storage_uri: patch.patchStorageUri,
  order_index: patch.orderIndex,
});

const isAppReadyPayload = (value: unknown): value is BundleEventPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Partial<Record<keyof BundleEventPayload, unknown>>;
  return (
    (payload.status === "STABLE" || payload.status === "RECOVERED") &&
    typeof payload.sdkVersion === "string" &&
    typeof payload.defaultChannel === "string" &&
    typeof payload.isChannelSwitched === "boolean"
  );
};

const parseEventPayload = (value: unknown): BundleEventPayload => {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!isAppReadyPayload(parsed)) {
    throw new Error("Invalid bundle event payload.");
  }
  return parsed;
};

const rowToDatabaseBundleEvent = (
  row: SupabaseBundleEventRow,
): DatabaseBundleEvent => {
  if (row.kind !== "APP_READY") {
    throw new Error(`Unsupported bundle event kind: ${row.kind}`);
  }
  return {
    id: row.id,
    kind: row.kind,
    installId: row.install_id,
    activeBundleId: row.active_bundle_id,
    previousActiveBundleId: row.previous_active_bundle_id,
    crashedBundleId: row.crashed_bundle_id,
    platform: row.platform,
    channel: row.channel,
    appVersion: row.app_version,
    fingerprintHash: row.fingerprint_hash,
    cohort: row.cohort,
    userId: row.user_id,
    payload: parseEventPayload(row.payload),
  };
};

const databaseBundleEventToRow = (
  event: DatabaseBundleEvent,
): SupabaseBundleEventRow => ({
  id: event.id,
  kind: event.kind,
  install_id: event.installId,
  active_bundle_id: event.activeBundleId,
  previous_active_bundle_id: event.previousActiveBundleId ?? null,
  crashed_bundle_id: event.crashedBundleId ?? null,
  platform: event.platform,
  channel: event.channel,
  app_version: event.appVersion ?? null,
  fingerprint_hash: event.fingerprintHash ?? null,
  cohort: event.cohort ?? null,
  user_id: event.userId ?? null,
  payload: event.payload,
});

const eventMatchesWhere = (
  event: DatabaseBundleEvent,
  where: BundleEventListQuery["where"] | undefined,
) =>
  !where ||
  ((where.kind === undefined || event.kind === where.kind) &&
    (where.installId === undefined || event.installId === where.installId) &&
    (where.activeBundleId === undefined ||
      event.activeBundleId === where.activeBundleId) &&
    (where.previousActiveBundleId === undefined ||
      event.previousActiveBundleId === where.previousActiveBundleId) &&
    (where.crashedBundleId === undefined ||
      event.crashedBundleId === where.crashedBundleId) &&
    (where.platform === undefined || event.platform === where.platform) &&
    (where.channel === undefined || event.channel === where.channel) &&
    (where.appVersion === undefined || event.appVersion === where.appVersion) &&
    (where.fingerprintHash === undefined ||
      event.fingerprintHash === where.fingerprintHash) &&
    (where.cohort === undefined || event.cohort === where.cohort) &&
    (where.userId === undefined || event.userId === where.userId));

const paginateItems = <TItem>({
  cursor,
  getCursor,
  items,
  limit,
  page,
}: {
  readonly cursor?: { readonly after?: string; readonly before?: string };
  readonly getCursor: (item: TItem) => string;
  readonly items: readonly TItem[];
  readonly limit: number;
  readonly page?: number;
}): CursorPage<TItem> => {
  const total = items.length;
  const pageOffset = page ? (Math.max(1, page) - 1) * limit : undefined;
  let startIndex =
    pageOffset === undefined ? 0 : Math.min(pageOffset, Math.max(0, total));
  let endIndex = limit > 0 ? startIndex + limit : total;

  if (pageOffset === undefined && cursor?.after) {
    const afterIndex = items.findIndex(
      (item) => getCursor(item) === cursor.after,
    );
    startIndex = afterIndex >= 0 ? afterIndex + 1 : total;
    endIndex = limit > 0 ? startIndex + limit : total;
  } else if (pageOffset === undefined && cursor?.before) {
    const beforeIndex = items.findIndex(
      (item) => getCursor(item) === cursor.before,
    );
    endIndex = beforeIndex >= 0 ? beforeIndex : 0;
    startIndex = limit > 0 ? Math.max(0, endIndex - limit) : 0;
  }

  const data = items.slice(startIndex, endIndex);
  const pagination = calculatePagination(total, {
    limit,
    offset: startIndex,
  });

  return {
    data,
    pagination: {
      ...pagination,
      nextCursor:
        data.length > 0 && startIndex + data.length < total
          ? getCursor(data[data.length - 1]!)
          : null,
      previousCursor:
        data.length > 0 && startIndex > 0 ? getCursor(data[0]!) : null,
    },
  };
};

const hasEmptySetFilter = (where: DatabaseBundleQueryWhere | undefined) =>
  where?.targetAppVersionIn?.length === 0 || where?.id?.in?.length === 0;

export const supabaseDatabase = createDatabasePlugin({
  name: "supabaseDatabase",
  connect: (config: SupabaseDatabaseConfig): DatabasePluginCore => {
    const supabase = createClient(
      config.supabaseUrl,
      resolveSupabaseServiceRoleKey(config),
    );

    const getUpdateInfo = async (args: GetBundlesArgs) => {
      const channel = args.channel ?? "production";
      const minBundleId = args.minBundleId ?? NIL_UUID;

      if (args._updateStrategy === "appVersion") {
        const { data: targetAppVersionRows, error: targetAppVersionError } =
          await supabase.rpc("get_target_app_version_list", {
            app_platform: args.platform,
            min_bundle_id: minBundleId,
          });

        if (targetAppVersionError) {
          throw createSupabaseError(targetAppVersionError);
        }

        const targetAppVersionList = filterCompatibleAppVersions(
          ((targetAppVersionRows ?? []) as SupabaseTargetAppVersionRow[])
            .map((row) => row.target_app_version)
            .filter((version): version is string => Boolean(version)),
          args.appVersion,
        );

        const { data, error } = await supabase.rpc(
          "get_update_info_by_app_version",
          {
            app_platform: args.platform,
            app_version: args.appVersion,
            bundle_id: args.bundleId,
            min_bundle_id: minBundleId,
            target_channel: channel,
            target_app_version_list: targetAppVersionList,
            cohort: args.cohort ?? null,
          },
        );

        if (error) {
          throw createSupabaseError(error);
        }

        const updateInfo = (data?.[0] ?? null) as SupabaseUpdateInfoRow | null;
        return updateInfo ? mapUpdateInfoRow(updateInfo) : null;
      }

      const { data, error } = await supabase.rpc(
        "get_update_info_by_fingerprint_hash",
        {
          app_platform: args.platform,
          bundle_id: args.bundleId,
          min_bundle_id: minBundleId,
          target_channel: channel,
          target_fingerprint_hash: args.fingerprintHash,
          cohort: args.cohort ?? null,
        },
      );

      if (error) {
        throw createSupabaseError(error);
      }

      const updateInfo = (data?.[0] ?? null) as SupabaseUpdateInfoRow | null;
      return updateInfo ? mapUpdateInfoRow(updateInfo) : null;
    };

    const applyBundleWhere = <TQuery extends object>(
      query: TQuery,
      where: DatabaseBundleQueryWhere | undefined,
    ): TQuery => {
      let next = query as {
        eq: (column: string, value: unknown) => unknown;
        gt: (column: string, value: unknown) => unknown;
        gte: (column: string, value: unknown) => unknown;
        in: (column: string, values: readonly unknown[]) => unknown;
        is: (column: string, value: null) => unknown;
        lt: (column: string, value: unknown) => unknown;
        lte: (column: string, value: unknown) => unknown;
        not: (column: string, operator: string, value: unknown) => unknown;
      };
      if (where?.channel !== undefined) {
        next = next.eq("channel", where.channel) as typeof next;
      }
      if (where?.platform !== undefined) {
        next = next.eq("platform", where.platform as Platform) as typeof next;
      }
      if (where?.enabled !== undefined) {
        next = next.eq("enabled", where.enabled) as typeof next;
      }
      if (where?.fingerprintHash !== undefined) {
        next =
          where.fingerprintHash === null
            ? (next.is("fingerprint_hash", null) as typeof next)
            : (next.eq(
                "fingerprint_hash",
                where.fingerprintHash,
              ) as typeof next);
      }
      if (where?.targetAppVersion !== undefined) {
        next =
          where.targetAppVersion === null
            ? (next.is("target_app_version", null) as typeof next)
            : (next.eq(
                "target_app_version",
                where.targetAppVersion,
              ) as typeof next);
      }
      if (where?.targetAppVersionIn) {
        next = next.in(
          "target_app_version",
          where.targetAppVersionIn,
        ) as typeof next;
      }
      if (where?.targetAppVersionNotNull) {
        next = next.not("target_app_version", "is", null) as typeof next;
      }
      if (where?.id?.eq) {
        next = next.eq("id", where.id.eq) as typeof next;
      }
      if (where?.id?.gt) {
        next = next.gt("id", where.id.gt) as typeof next;
      }
      if (where?.id?.gte) {
        next = next.gte("id", where.id.gte) as typeof next;
      }
      if (where?.id?.lt) {
        next = next.lt("id", where.id.lt) as typeof next;
      }
      if (where?.id?.lte) {
        next = next.lte("id", where.id.lte) as typeof next;
      }
      if (where?.id?.in) {
        next = next.in("id", where.id.in) as typeof next;
      }
      return next as TQuery;
    };

    return {
      bundles: {
        async getById({ bundleId }) {
          const { data, error } = await supabase
            .from("bundles")
            .select(BUNDLE_SELECT_COLUMNS)
            .eq("id", bundleId)
            .single();

          if (!data || error) {
            return null;
          }
          return rowToDatabaseBundleRecord(data);
        },

        async list(options) {
          if (hasEmptySetFilter(options.where)) {
            return paginateItems({
              items: [] as DatabaseBundleRecord[],
              limit: options.limit,
              cursor: options.cursor,
              getCursor: (bundle) => bundle.id,
            });
          }

          const orderBy = options.orderBy ?? { field: "id", direction: "desc" };
          const query = applyBundleWhere(
            supabase
              .from("bundles")
              .select(BUNDLE_SELECT_COLUMNS)
              .order("id", { ascending: orderBy.direction === "asc" }),
            options.where,
          );
          const { data, error } = await query;
          if (error) {
            throw createSupabaseError(error);
          }

          const page = paginateItems({
            items: data ?? [],
            limit: options.limit,
            cursor: options.cursor,
            page: options.page,
            getCursor: (row) => row.id,
          });

          return {
            ...page,
            data: page.data.map(rowToDatabaseBundleRecord),
          };
        },

        async insert({ bundle }) {
          const { error } = await supabase
            .from("bundles")
            .upsert(databaseBundleRecordToRow(bundle), { onConflict: "id" });
          if (error) {
            throw createSupabaseError(error);
          }
        },

        async update({ bundleId, patch }) {
          const { data, error } = await supabase
            .from("bundles")
            .select(BUNDLE_SELECT_COLUMNS)
            .eq("id", bundleId)
            .single();
          if (!data || error) {
            throw new Error("targetBundleId not found");
          }
          const { error: updateError } = await supabase.from("bundles").upsert(
            databaseBundleRecordToRow({
              ...rowToDatabaseBundleRecord(data),
              ...patch,
              id: bundleId,
            }),
            { onConflict: "id" },
          );
          if (updateError) {
            throw createSupabaseError(updateError);
          }
        },

        async delete({ bundleId }) {
          const { error } = await supabase
            .from("bundles")
            .delete()
            .eq("id", bundleId);
          if (error) {
            throw createSupabaseError(error);
          }
        },
      },

      bundlePatches: {
        async list(options: BundlePatchListQuery) {
          const { data, error } = await supabase
            .from("bundle_patches")
            .select("*")
            .order("order_index", { ascending: true });
          if (error) {
            throw createSupabaseError(error);
          }

          const patches = (data ?? [])
            .map(rowToDatabaseBundlePatch)
            .filter((patch) => {
              const where = options.where;
              return (
                !where ||
                ((where.bundleId === undefined ||
                  patch.bundleId === where.bundleId) &&
                  (where.baseBundleId === undefined ||
                    patch.baseBundleId === where.baseBundleId) &&
                  (where.bundleIdIn === undefined ||
                    where.bundleIdIn.includes(patch.bundleId)) &&
                  (where.baseBundleIdIn === undefined ||
                    where.baseBundleIdIn.includes(patch.baseBundleId)))
              );
            })
            .sort((left, right) => {
              const direction = options.orderBy?.direction ?? "asc";
              const field = options.orderBy?.field ?? "orderIndex";
              const result =
                field === "orderIndex"
                  ? left.orderIndex - right.orderIndex
                  : left[field].localeCompare(right[field]);
              return direction === "asc" ? result : -result;
            });

          return paginateItems({
            items: patches,
            limit: options.limit,
            cursor: options.cursor,
            getCursor: (patch) =>
              patch.id ??
              buildBundlePatchId(patch.bundleId, patch.baseBundleId),
          });
        },

        async replaceForBundle({ bundleId, patches }) {
          const { error: patchDeleteError } = await supabase
            .from("bundle_patches")
            .delete()
            .eq("bundle_id", bundleId);
          if (patchDeleteError) {
            throw createSupabaseError(patchDeleteError);
          }

          if (patches.length > 0) {
            const { error: patchInsertError } = await supabase
              .from("bundle_patches")
              .upsert(patches.map(databaseBundlePatchToRow), {
                onConflict: "id",
              });
            if (patchInsertError) {
              throw createSupabaseError(patchInsertError);
            }
          }
        },

        async deleteForBundle({ bundleId }) {
          const { error } = await supabase
            .from("bundle_patches")
            .delete()
            .eq("bundle_id", bundleId);
          if (error) {
            throw createSupabaseError(error);
          }
        },

        async deleteForBaseBundle({ baseBundleId }) {
          const { error } = await supabase
            .from("bundle_patches")
            .delete()
            .eq("base_bundle_id", baseBundleId);
          if (error) {
            throw createSupabaseError(error);
          }
        },
      },

      bundleEvents: {
        async list(options: BundleEventListQuery) {
          const { data, error } = await supabase
            .from("bundle_events")
            .select("*")
            .order("id", { ascending: options.orderBy?.direction === "asc" });
          if (error) {
            throw createSupabaseError(error);
          }

          const events = (data ?? [])
            .map(rowToDatabaseBundleEvent)
            .filter((event) => eventMatchesWhere(event, options.where));

          return paginateItems({
            items: events,
            limit: options.limit,
            cursor: options.cursor,
            getCursor: (event) => event.id,
          });
        },

        async append({ event }) {
          const { error } = await supabase
            .from("bundle_events")
            .insert(databaseBundleEventToRow(event));
          if (error) {
            throw createSupabaseError(error);
          }
        },
      },

      updateInfo: {
        get: getUpdateInfo,
      },
    };
  },
});
