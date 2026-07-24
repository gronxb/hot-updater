import { withAnalyticsProvider } from "@hot-updater/analytics/provider";
import type {
  CountDatabaseImplementationInput,
  CreateDatabaseImplementationInput,
  DatabasePluginImplementation,
  DeleteDatabaseImplementationInput,
  FindManyDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateBundleDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import {
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
import { SupabaseMissingDataError, throwSupabaseError } from "./supabaseResult";
import type { Database } from "./types";

export type SupabaseDatabaseConfig = SupabaseServiceRoleConfig;

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
      case "bundle_events": {
        const { data, error } = await supabase
          .from("bundle_events")
          .insert(input.data)
          .select("*")
          .single();
        throwSupabaseError("create bundle_events", error);
        if (data === null) {
          throw new SupabaseMissingDataError("create bundle_events");
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
      case "bundle_events": {
        let query = supabase
          .from("bundle_events")
          .select("*", { count: "exact", head: true });
        if (filter !== undefined) query = query.or(filter);
        const { count, error } = await query;
        throwSupabaseError("count bundle_events", error);
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
      case "bundle_events": {
        let query = supabase.from("bundle_events").select("*");
        if (filter !== undefined) query = query.or(filter);
        const { data, error } = await query.limit(1).maybeSingle();
        throwSupabaseError("findOne bundle_events", error);
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
      case "bundle_events": {
        let query = supabase.from("bundle_events").select("*");
        if (filter !== undefined) query = query.or(filter);
        for (const clause of orderBy) {
          query = query.order(clause.field, {
            ascending: clause.direction === "asc",
            ...(clause.nulls ? { nullsFirst: clause.nulls === "first" } : {}),
          });
        }
        const { data, error } = await query.range(input.offset, rangeEnd);
        throwSupabaseError("findMany bundle_events", error);
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

export const supabaseDatabase = (config: SupabaseDatabaseConfig) =>
  withAnalyticsProvider(
    createDatabasePlugin({
      name: "supabaseDatabase",
      plugin: () =>
        createSupabaseImplementation(
          createClient<Database>(
            config.supabaseUrl,
            resolveSupabaseServiceRoleKey(config),
          ),
        ),
    }),
  );
