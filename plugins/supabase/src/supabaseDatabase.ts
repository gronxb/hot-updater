import {
  createDatabasePlugin,
  DatabasePluginInputError,
} from "@hot-updater/plugin-core";
import type {
  CountDatabaseImplementationInput,
  CreateDatabaseImplementationInput,
  DatabasePluginImplementation,
  DeleteDatabaseImplementationInput,
  FindManyDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateDatabaseImplementationInput,
} from "@hot-updater/plugin-core/internal";
import {
  createDatabasePluginAdapter,
  DatabaseRowReferencedError,
} from "@hot-updater/plugin-core/internal";
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

const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === "23503";

const createSupabaseImplementation = (
  supabase: SupabaseClient<Database>,
): DatabasePluginImplementation => {
  const implementation: DatabasePluginImplementation = {
    async create(input: CreateDatabaseImplementationInput) {
      switch (input.model) {
        case "bundles": {
          const { data, error } = await supabase
            .from("bundles")
            .insert(input.data)
            .select("*")
            .single();
          throwSupabaseError("create bundles", error);
          if (data === null)
            throw new SupabaseMissingDataError("create bundles");
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
        case "channels": {
          if (input.onConflict === "ignore") {
            const { data, error } = await supabase
              .from("channels")
              .upsert(input.data, {
                onConflict: "name",
                ignoreDuplicates: true,
              })
              .select("*")
              .maybeSingle();
            throwSupabaseError("create channels", error);
            return data ?? input.data;
          }
          const { data, error } = await supabase
            .from("channels")
            .insert(input.data)
            .select("*")
            .single();
          throwSupabaseError("create channels", error);
          if (data === null) {
            throw new SupabaseMissingDataError("create channels");
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
        case "client_access_keys": {
          const query =
            input.onConflict === "ignore"
              ? supabase.from("client_access_keys").upsert(input.data, {
                  onConflict: "hash",
                  ignoreDuplicates: true,
                })
              : supabase.from("client_access_keys").insert(input.data);
          const { data, error } = await query.select("*").maybeSingle();
          throwSupabaseError("create client_access_keys", error);
          if (data === null && input.onConflict !== "ignore") {
            throw new SupabaseMissingDataError("create client_access_keys");
          }
          return data ?? input.data;
        }
      }
    },
    async update(input: UpdateDatabaseImplementationInput) {
      const filter = buildSupabaseFilter(input.where);
      if (input.model === "client_access_keys") {
        let query = supabase.from("client_access_keys").update(input.update);
        if (filter !== undefined) query = query.or(filter);
        const { data, error } = await query.select("*").maybeSingle();
        throwSupabaseError("update client_access_keys", error);
        return data;
      }
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
          return;
        }
        case "channels": {
          let query = supabase.from("channels").delete();
          if (filter !== undefined) query = query.or(filter);
          const { error } = await query;
          if (isForeignKeyViolation(error)) {
            throw new DatabaseRowReferencedError();
          }
          throwSupabaseError("delete channels", error);
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
        case "client_access_keys": {
          let query = supabase.from("client_access_keys").select("*");
          if (filter !== undefined) query = query.or(filter);
          const { data, error } = await query.limit(1).maybeSingle();
          throwSupabaseError("findOne client_access_keys", error);
          return data;
        }
        case "channels": {
          let query = supabase.from("channels").select("*");
          if (filter !== undefined) query = query.or(filter);
          const { data, error } = await query.limit(1).maybeSingle();
          throwSupabaseError("findOne channels", error);
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
        case "client_access_keys": {
          let query = supabase.from("client_access_keys").select("*");
          if (filter !== undefined) query = query.or(filter);
          for (const clause of orderBy) {
            query = query.order(clause.field, {
              ascending: clause.direction === "asc",
              ...(clause.nulls ? { nullsFirst: clause.nulls === "first" } : {}),
            });
          }
          const { data, error } = await query.range(input.offset, rangeEnd);
          throwSupabaseError("findMany client_access_keys", error);
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
        case "channels": {
          let query = supabase.from("channels").select("*");
          if (filter !== undefined) query = query.or(filter);
          for (const clause of orderBy) {
            query = query.order(clause.field, {
              ascending: clause.direction === "asc",
              ...(clause.nulls ? { nullsFirst: clause.nulls === "first" } : {}),
            });
          }
          const { data, error } = await query.range(input.offset, rangeEnd);
          throwSupabaseError("findMany channels", error);
          return data ?? [];
        }
      }
    },
    async insertChannel(input) {
      const { data: inserted, error: insertError } = await supabase
        .from("channels")
        .upsert(input.row, { onConflict: "name", ignoreDuplicates: true })
        .select("*")
        .maybeSingle();
      throwSupabaseError("insert channel", insertError);
      if (inserted !== null) return { row: inserted, inserted: true };

      const { data: existing, error: findError } = await supabase
        .from("channels")
        .select("*")
        .eq("name", input.row.name)
        .single();
      throwSupabaseError("find canonical channel", findError);
      if (existing === null) {
        throw new SupabaseMissingDataError("find canonical channel");
      }
      return { row: existing, inserted: false };
    },
    async deleteChannel(input) {
      const { data, error } = await supabase.rpc("hot_updater_delete_channel", {
        p_id: input.id,
      });
      throwSupabaseError("delete channel", error);
      if (
        data === null ||
        typeof data !== "object" ||
        !("deleted" in data) ||
        typeof data.deleted !== "boolean"
      ) {
        throw new SupabaseMissingDataError("delete channel");
      }
      return data;
    },
    getUpdateInfo: createSupabaseGetUpdateInfo(supabase),
  };
  implementation.commit = async (input) => {
    const { data, error } = await supabase.rpc("hot_updater_commit", {
      p_commit: input,
    });
    throwSupabaseError("commit database changes", error);
    if (
      data === null ||
      typeof data !== "object" ||
      !("committed" in data) ||
      typeof data.committed !== "boolean"
    ) {
      throw new SupabaseMissingDataError("commit database changes");
    }
    return data;
  };
  return implementation;
};

export const supabaseDatabase = (config: SupabaseDatabaseConfig) => {
  const supabase = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  );
  const adapter = createDatabasePluginAdapter(
    "supabaseDatabase",
    createSupabaseImplementation(supabase),
  );
  return createDatabasePlugin({
    name: "supabaseDatabase",
    models: adapter.models,
    queries: adapter.queries,
    commit: adapter.commit,
  });
};
