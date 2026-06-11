import { NIL_UUID, type UpdateInfo } from "@hot-updater/core";
import type {
  Bundle,
  GetBundlesArgs,
  Platform,
} from "@hot-updater/plugin-core";
import {
  calculatePagination,
  createDatabasePlugin,
  filterCompatibleAppVersions,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import {
  BUNDLE_SELECT_COLUMNS,
  bundleToPatchRows,
  bundleToRow,
  mapRowToBundle,
} from "./supabaseBundleMapper";
import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import type { SupabaseBundlePatchRow } from "./types";

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

type UpdateInfoWithAttachedBundle = UpdateInfo & {
  readonly __hotUpdaterCurrentBundle?: Bundle | null;
  readonly __hotUpdaterBundle?: Bundle;
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

const attachBundleProperty = (
  info: UpdateInfoWithAttachedBundle,
  propertyName: "__hotUpdaterBundle" | "__hotUpdaterCurrentBundle",
  bundle: Bundle | null,
) => {
  Object.defineProperty(info, propertyName, {
    configurable: true,
    enumerable: false,
    value: bundle,
  });
};

const attachBundlesToUpdateInfo = ({
  currentBundle,
  info,
  targetBundle,
}: {
  readonly currentBundle: Bundle | null;
  readonly info: UpdateInfo;
  readonly targetBundle: Bundle;
}): UpdateInfo => {
  const updateInfo: UpdateInfoWithAttachedBundle = info;
  attachBundleProperty(updateInfo, "__hotUpdaterBundle", targetBundle);
  attachBundleProperty(updateInfo, "__hotUpdaterCurrentBundle", currentBundle);
  return updateInfo;
};

export const supabaseDatabase = createDatabasePlugin<SupabaseDatabaseConfig>({
  name: "supabaseDatabase",
  factory: (config) => {
    const supabase = createClient(
      config.supabaseUrl,
      resolveSupabaseServiceRoleKey(config),
    );
    const fetchPatchMap = async (bundleIds: string[]) => {
      const patchMap = new Map<string, SupabaseBundlePatchRow[]>();

      if (bundleIds.length === 0) {
        return patchMap;
      }

      const { data, error } = await supabase
        .from("bundle_patches")
        .select("*")
        .in("bundle_id", bundleIds)
        .order("order_index", { ascending: true });

      if (error) {
        throw createSupabaseError(error);
      }

      for (const row of data ?? []) {
        const current = patchMap.get(row.bundle_id) ?? [];
        current.push(row);
        patchMap.set(row.bundle_id, current);
      }

      return patchMap;
    };

    const fetchBundlesByIds = async (bundleIds: readonly string[]) => {
      const uniqueBundleIds = Array.from(
        new Set(bundleIds.filter((bundleId) => bundleId !== NIL_UUID)),
      );
      const bundles = new Map<string, Bundle>();

      if (uniqueBundleIds.length === 0) {
        return bundles;
      }

      const [{ data, error }, patchMap] = await Promise.all([
        supabase
          .from("bundles")
          .select(BUNDLE_SELECT_COLUMNS)
          .in("id", uniqueBundleIds),
        fetchPatchMap(uniqueBundleIds),
      ]);

      if (error) {
        throw createSupabaseError(error);
      }

      for (const row of data ?? []) {
        bundles.set(row.id, mapRowToBundle(row, patchMap.get(row.id) ?? []));
      }

      return bundles;
    };

    const attachMatchingBundles = async (
      updateInfoRow: SupabaseUpdateInfoRow | null,
      currentBundleId: string,
    ) => {
      if (!updateInfoRow) {
        return null;
      }

      const info = mapUpdateInfoRow(updateInfoRow);
      const bundles = await fetchBundlesByIds([info.id, currentBundleId]);
      const targetBundle = bundles.get(info.id);

      if (!targetBundle) {
        return info;
      }

      return attachBundlesToUpdateInfo({
        currentBundle: bundles.get(currentBundleId) ?? null,
        info,
        targetBundle,
      });
    };

    return {
      async getUpdateInfo(args: GetBundlesArgs) {
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

          const updateInfo = (data?.[0] ??
            null) as SupabaseUpdateInfoRow | null;
          return attachMatchingBundles(updateInfo, args.bundleId);
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
        return attachMatchingBundles(updateInfo, args.bundleId);
      },

      async getBundleById(bundleId) {
        const [{ data, error }, patchMap] = await Promise.all([
          supabase
            .from("bundles")
            .select(BUNDLE_SELECT_COLUMNS)
            .eq("id", bundleId)
            .single(),
          fetchPatchMap([bundleId]),
        ]);

        if (!data || error) {
          return null;
        }
        return mapRowToBundle(data, patchMap.get(bundleId) ?? []);
      },

      async getBundles(options) {
        const { where, limit, orderBy } = options ?? {};
        const offset =
          ((options && "offset" in options ? options.offset : undefined) as
            | number
            | undefined) ?? 0;

        if (
          (where?.targetAppVersionIn &&
            where.targetAppVersionIn.length === 0) ||
          (where?.id?.in && where.id.in.length === 0)
        ) {
          return {
            data: [],
            pagination: calculatePagination(0, { limit, offset }),
          };
        }

        let countQuery = supabase
          .from("bundles")
          .select("*", { count: "exact", head: true });

        if (where?.channel) {
          countQuery = countQuery.eq("channel", where.channel);
        }
        if (where?.platform) {
          countQuery = countQuery.eq("platform", where.platform as Platform);
        }
        if (where?.enabled !== undefined) {
          countQuery = countQuery.eq("enabled", where.enabled);
        }
        if (where?.fingerprintHash !== undefined) {
          countQuery =
            where.fingerprintHash === null
              ? countQuery.is("fingerprint_hash", null)
              : countQuery.eq("fingerprint_hash", where.fingerprintHash);
        }
        if (where?.targetAppVersion !== undefined) {
          countQuery =
            where.targetAppVersion === null
              ? countQuery.is("target_app_version", null)
              : countQuery.eq("target_app_version", where.targetAppVersion);
        }
        if (where?.targetAppVersionIn) {
          countQuery = countQuery.in(
            "target_app_version",
            where.targetAppVersionIn,
          );
        }
        if (where?.targetAppVersionNotNull) {
          countQuery = countQuery.not("target_app_version", "is", null);
        }
        if (where?.id?.eq) {
          countQuery = countQuery.eq("id", where.id.eq);
        }
        if (where?.id?.gt) {
          countQuery = countQuery.gt("id", where.id.gt);
        }
        if (where?.id?.gte) {
          countQuery = countQuery.gte("id", where.id.gte);
        }
        if (where?.id?.lt) {
          countQuery = countQuery.lt("id", where.id.lt);
        }
        if (where?.id?.lte) {
          countQuery = countQuery.lte("id", where.id.lte);
        }
        if (where?.id?.in) {
          countQuery = countQuery.in("id", where.id.in);
        }

        const { count: total = 0 } = await countQuery;

        let query = supabase
          .from("bundles")
          .select(BUNDLE_SELECT_COLUMNS)
          .order("id", { ascending: orderBy?.direction === "asc" });

        if (where?.channel) {
          query = query.eq("channel", where.channel);
        }

        if (where?.platform) {
          query = query.eq("platform", where.platform as Platform);
        }
        if (where?.enabled !== undefined) {
          query = query.eq("enabled", where.enabled);
        }
        if (where?.fingerprintHash !== undefined) {
          query =
            where.fingerprintHash === null
              ? query.is("fingerprint_hash", null)
              : query.eq("fingerprint_hash", where.fingerprintHash);
        }
        if (where?.targetAppVersion !== undefined) {
          query =
            where.targetAppVersion === null
              ? query.is("target_app_version", null)
              : query.eq("target_app_version", where.targetAppVersion);
        }
        if (where?.targetAppVersionIn) {
          query = query.in("target_app_version", where.targetAppVersionIn);
        }
        if (where?.targetAppVersionNotNull) {
          query = query.not("target_app_version", "is", null);
        }
        if (where?.id?.eq) {
          query = query.eq("id", where.id.eq);
        }
        if (where?.id?.gt) {
          query = query.gt("id", where.id.gt);
        }
        if (where?.id?.gte) {
          query = query.gte("id", where.id.gte);
        }
        if (where?.id?.lt) {
          query = query.lt("id", where.id.lt);
        }
        if (where?.id?.lte) {
          query = query.lte("id", where.id.lte);
        }
        if (where?.id?.in) {
          query = query.in("id", where.id.in);
        }

        if (limit) {
          query = query.limit(limit);
        }

        if (offset) {
          query = query.range(offset, offset + (limit || 20) - 1);
        }

        const { data } = await query;

        const patchMap = await fetchPatchMap(
          (data ?? []).map((bundle) => bundle.id),
        );
        const bundles = (data ?? []).map((bundle) =>
          mapRowToBundle(bundle, patchMap.get(bundle.id) ?? []),
        );

        const pagination = calculatePagination(total ?? 0, { limit, offset });

        return {
          data: bundles,
          pagination,
        };
      },

      async getChannels() {
        const { data, error } = await supabase.rpc("get_channels");
        if (error) {
          throw error;
        }
        return data.map((bundle: { channel: string }) => bundle.channel);
      },

      async commitBundle({ changedSets }) {
        if (changedSets.length === 0) {
          return;
        }

        // Process each operation sequentially
        for (const op of changedSets) {
          if (op.operation === "delete") {
            // Handle delete operation
            const { error: patchDeleteError } = await supabase
              .from("bundle_patches")
              .delete()
              .eq("bundle_id", op.data.id);

            if (patchDeleteError) {
              throw new Error(
                `Failed to delete bundle patches: ${patchDeleteError.message}`,
              );
            }

            const { error: basePatchDeleteError } = await supabase
              .from("bundle_patches")
              .delete()
              .eq("base_bundle_id", op.data.id);

            if (basePatchDeleteError) {
              throw new Error(
                `Failed to delete base bundle patches: ${basePatchDeleteError.message}`,
              );
            }

            const { error } = await supabase
              .from("bundles")
              .delete()
              .eq("id", op.data.id);

            if (error) {
              throw new Error(`Failed to delete bundle: ${error.message}`);
            }
          } else if (op.operation === "insert" || op.operation === "update") {
            // Handle insert and update operations
            const bundle = op.data;
            const patchRows = bundleToPatchRows(bundle);
            const { error } = await supabase
              .from("bundles")
              .upsert(bundleToRow(bundle), { onConflict: "id" });

            if (error) {
              throw error;
            }

            const { error: patchDeleteError } = await supabase
              .from("bundle_patches")
              .delete()
              .eq("bundle_id", bundle.id);

            if (patchDeleteError) {
              throw patchDeleteError;
            }

            if (patchRows.length > 0) {
              const { error: patchInsertError } = await supabase
                .from("bundle_patches")
                .upsert(patchRows, { onConflict: "id" });

              if (patchInsertError) {
                throw patchInsertError;
              }
            }
          }
        }
      },
    };
  },
});
