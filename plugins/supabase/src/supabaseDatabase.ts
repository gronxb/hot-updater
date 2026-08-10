import { attachManagedAccessKeyStore } from "@hot-updater/better-auth/managed";
import type {
  BundlePatchRow,
  BundleRow,
  BundleRowUpdate,
  CountDatabaseImplementationInput,
  CreateDatabaseImplementationInput,
  DatabasePlugin,
  DatabasePluginImplementation,
  DeleteDatabaseImplementationInput,
  FindManyDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateBundleDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import {
  attachUniversalComponentDataAdapter,
  createDatabasePlugin,
  DatabasePluginInputError,
} from "@hot-updater/plugin-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import { buildSupabaseFilter } from "./supabaseFilter";
import { createSupabaseGetUpdateInfo } from "./supabaseGetUpdateInfo";
import { createSupabaseManagedAccessKeyStoreFromClient } from "./supabaseManagedAccessKeyStore";
import { SupabaseMissingDataError, throwSupabaseError } from "./supabaseResult";
import { createSupabaseUniversalComponentDataAdapter } from "./supabaseUniversalComponentData";
import type { Database } from "./types";

export type SupabaseDatabaseConfig = SupabaseServiceRoleConfig;

const aggregateMutationsKey = Symbol.for(
  "@hot-updater/plugin-core/atomic-bundle-mutations/v1",
);

interface SupabaseAggregateMutations {
  insertBundleWithPatches(input: {
    readonly bundle: BundleRow;
    readonly patches: readonly BundlePatchRow[];
  }): Promise<void>;
  updateBundleWithPatches(input: {
    readonly bundleId: string;
    readonly update: BundleRowUpdate;
    readonly patches: readonly BundlePatchRow[];
  }): Promise<boolean>;
}

const attachSupabaseAggregateMutations = (
  plugin: DatabasePlugin,
  mutations: SupabaseAggregateMutations,
): DatabasePlugin => {
  Object.defineProperty(plugin, aggregateMutationsKey, {
    configurable: false,
    enumerable: false,
    value: mutations,
    writable: false,
  });
  return plugin;
};

const createSupabaseImplementation = (
  supabase: SupabaseClient<Database>,
): DatabasePluginImplementation => ({
  async create(input: CreateDatabaseImplementationInput) {
    switch (input.model) {
      case "bundles": {
        const { data, error } = await supabase
          .from("bundles")
          .insert(input.data)
          .select("*")
          .single();
        throwSupabaseError("create bundles", error);
        if (data === null) throw new SupabaseMissingDataError("create bundles");
        return data;
      }
      case "bundle_patches": {
        const { data, error } = await supabase
          .from("bundle_patches")
          .insert(input.data)
          .select("*")
          .single();
        throwSupabaseError("create bundle_patches", error);
        if (data === null) {
          throw new SupabaseMissingDataError("create bundle_patches");
        }
        return data;
      }
    }
  },
  async update(input: UpdateBundleDatabaseImplementationInput) {
    const filter = buildSupabaseFilter(input.where);
    let query = supabase.from("bundles").update(input.update);
    if (filter !== undefined) query = query.or(filter);
    const { data, error } = await query.select("*").maybeSingle();
    throwSupabaseError("update bundles", error);
    return data;
  },
  async delete(input: DeleteDatabaseImplementationInput) {
    const filter = buildSupabaseFilter(input.where);
    switch (input.model) {
      case "bundles": {
        let query = supabase.from("bundles").delete();
        if (filter !== undefined) query = query.or(filter);
        const { error } = await query;
        throwSupabaseError("delete bundles", error);
        return;
      }
      case "bundle_patches": {
        let query = supabase.from("bundle_patches").delete();
        if (filter !== undefined) query = query.or(filter);
        const { error } = await query;
        throwSupabaseError("delete bundle_patches", error);
      }
    }
  },
  async count(input: CountDatabaseImplementationInput) {
    if (input.distinct !== undefined) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    const filter = buildSupabaseFilter(input.where);
    switch (input.model) {
      case "bundles": {
        let query = supabase
          .from("bundles")
          .select("*", { count: "exact", head: true });
        if (filter !== undefined) query = query.or(filter);
        const { count, error } = await query;
        throwSupabaseError("count bundles", error);
        return count ?? 0;
      }
      case "bundle_patches": {
        let query = supabase
          .from("bundle_patches")
          .select("*", { count: "exact", head: true });
        if (filter !== undefined) query = query.or(filter);
        const { count, error } = await query;
        throwSupabaseError("count bundle_patches", error);
        return count ?? 0;
      }
    }
  },
  async findOne(input: FindOneDatabaseImplementationInput) {
    const filter = buildSupabaseFilter(input.where);
    switch (input.model) {
      case "bundles": {
        let query = supabase.from("bundles").select("*");
        if (filter !== undefined) query = query.or(filter);
        const { data, error } = await query.limit(1).maybeSingle();
        throwSupabaseError("findOne bundles", error);
        return data;
      }
      case "bundle_patches": {
        let query = supabase.from("bundle_patches").select("*");
        if (filter !== undefined) query = query.or(filter);
        const { data, error } = await query.limit(1).maybeSingle();
        throwSupabaseError("findOne bundle_patches", error);
        return data;
      }
    }
  },
  async findMany(input: FindManyDatabaseImplementationInput) {
    if (input.distinctOn !== undefined) {
      throw new DatabasePluginInputError("invalid-operation");
    }
    if (input.limit === 0) return [];
    const filter = buildSupabaseFilter(input.where);
    const rangeEnd = input.offset + input.limit - 1;
    const orderBy = input.orderBy ?? (input.sortBy ? [input.sortBy] : []);
    switch (input.model) {
      case "bundles": {
        let query = supabase.from("bundles").select("*");
        if (filter !== undefined) query = query.or(filter);
        for (const clause of orderBy) {
          query = query.order(clause.field, {
            ascending: clause.direction === "asc",
            ...(clause.nulls ? { nullsFirst: clause.nulls === "first" } : {}),
          });
        }
        const { data, error } = await query.range(input.offset, rangeEnd);
        throwSupabaseError("findMany bundles", error);
        return data ?? [];
      }
      case "bundle_patches": {
        let query = supabase.from("bundle_patches").select("*");
        if (filter !== undefined) query = query.or(filter);
        for (const clause of orderBy) {
          query = query.order(clause.field, {
            ascending: clause.direction === "asc",
            ...(clause.nulls ? { nullsFirst: clause.nulls === "first" } : {}),
          });
        }
        const { data, error } = await query.range(input.offset, rangeEnd);
        throwSupabaseError("findMany bundle_patches", error);
        return data ?? [];
      }
    }
  },
  async getChannels() {
    const { data, error } = await supabase.rpc("get_channels");
    throwSupabaseError("get channels", error);
    return (data ?? []).map(({ channel }) => channel);
  },
  getUpdateInfo: createSupabaseGetUpdateInfo(supabase),
});

export const supabaseDatabase = (config: SupabaseDatabaseConfig) => {
  const supabase = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  );
  const plugin = createDatabasePlugin({
    name: "supabaseDatabase",
    plugin: () => createSupabaseImplementation(supabase),
  });
  const database = attachSupabaseAggregateMutations(plugin, {
    async insertBundleWithPatches(input) {
      const { error } = await supabase.rpc(
        "hot_updater_create_bundle_with_patches",
        {
          p_bundle: input.bundle,
          p_patches: input.patches,
        },
      );
      throwSupabaseError("create bundle with patches", error);
    },
    async updateBundleWithPatches(input) {
      const { data, error } = await supabase.rpc(
        "hot_updater_update_bundle_with_patches",
        {
          p_bundle_id: input.bundleId,
          p_update: input.update,
          p_patches: input.patches,
        },
      );
      throwSupabaseError("update bundle with patches", error);
      if (data === null) {
        throw new SupabaseMissingDataError("update bundle with patches");
      }
      return data;
    },
  });
  return attachManagedAccessKeyStore(
    attachUniversalComponentDataAdapter(database, () =>
      createSupabaseUniversalComponentDataAdapter(supabase),
    ),
    () => createSupabaseManagedAccessKeyStoreFromClient(supabase),
  );
};
