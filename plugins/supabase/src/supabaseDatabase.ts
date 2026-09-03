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
  OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
} from "@hot-updater/plugin-core/internal";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import { buildSupabaseFilter } from "./supabaseFilter";
import {
  SUPABASE_V1_FUNCTION_NAMES,
  SUPABASE_V1_TABLE_NAMES,
} from "./supabaseInfrastructureNames";
import {
  createSupabaseInsights,
  createSupabaseInsightsMaintenance,
  readSupabaseInsightsDatabaseNamespace,
} from "./supabaseInsights";
import { SupabaseMissingDataError, throwSupabaseError } from "./supabaseResult";
import type { Database } from "./types";

export type SupabaseDatabaseConfig = SupabaseServiceRoleConfig;

const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === "23503";

const createSupabaseImplementation = (
  supabase: SupabaseClient<Database>,
  databaseNamespace: string,
): DatabasePluginImplementation => {
  const implementation: DatabasePluginImplementation = {
    insights: createSupabaseInsights(supabase, databaseNamespace),
    async create(input: CreateDatabaseImplementationInput) {
      switch (input.model) {
        case "bundles": {
          const { data, error } = await supabase
            .from(SUPABASE_V1_TABLE_NAMES.bundles)
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
            .from(SUPABASE_V1_TABLE_NAMES.bundlePatches)
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
              .from(SUPABASE_V1_TABLE_NAMES.channels)
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
            .from(SUPABASE_V1_TABLE_NAMES.channels)
            .insert(input.data)
            .select("*")
            .single();
          throwSupabaseError("create channels", error);
          if (data === null) {
            throw new SupabaseMissingDataError("create channels");
          }
          return data;
        }
        case "releases": {
          const { data, error } = await supabase
            .from(SUPABASE_V1_TABLE_NAMES.releases)
            .insert(input.data)
            .select("*")
            .single();
          throwSupabaseError("create releases", error);
          if (data === null)
            throw new SupabaseMissingDataError("create releases");
          return data;
        }
        case "release_catalogs": {
          const { data, error } = await supabase
            .from(SUPABASE_V1_TABLE_NAMES.releaseCatalogs)
            .insert(input.data)
            .select("*")
            .single();
          throwSupabaseError("create release_catalogs", error);
          if (data === null) {
            throw new SupabaseMissingDataError("create release_catalogs");
          }
          return data;
        }
        case "api_keys": {
          const query =
            input.onConflict === "ignore"
              ? supabase
                  .from(SUPABASE_V1_TABLE_NAMES.apiKeys)
                  .upsert(input.data, {
                    onConflict: "hash",
                    ignoreDuplicates: true,
                  })
              : supabase
                  .from(SUPABASE_V1_TABLE_NAMES.apiKeys)
                  .insert(input.data);
          const { data, error } = await query.select("*").maybeSingle();
          throwSupabaseError("create api_keys", error);
          if (data === null && input.onConflict !== "ignore") {
            throw new SupabaseMissingDataError("create api_keys");
          }
          return data ?? input.data;
        }
      }
    },
    async update(input: UpdateDatabaseImplementationInput) {
      const filter = buildSupabaseFilter(input.where);
      if (input.model === "api_keys") {
        let query = supabase
          .from(SUPABASE_V1_TABLE_NAMES.apiKeys)
          .update(input.update);
        if (filter !== undefined) query = query.or(filter);
        const { data, error } = await query.select("*").maybeSingle();
        throwSupabaseError("update api_keys", error);
        return data;
      }
      if (input.model === "releases") {
        let query = supabase
          .from(SUPABASE_V1_TABLE_NAMES.releases)
          .update(input.update);
        if (filter !== undefined) query = query.or(filter);
        const { data, error } = await query.select("*").maybeSingle();
        throwSupabaseError("update releases", error);
        return data;
      }
      if (input.model === "release_catalogs") {
        let query = supabase
          .from(SUPABASE_V1_TABLE_NAMES.releaseCatalogs)
          .update(input.update);
        if (filter !== undefined) query = query.or(filter);
        const { data, error } = await query.select("*").maybeSingle();
        throwSupabaseError("update release_catalogs", error);
        return data;
      }
      let query = supabase
        .from(SUPABASE_V1_TABLE_NAMES.bundles)
        .update(input.update);
      if (filter !== undefined) query = query.or(filter);
      const { data, error } = await query.select("*").maybeSingle();
      throwSupabaseError("update bundles", error);
      return data;
    },
    async delete(input: DeleteDatabaseImplementationInput) {
      const filter = buildSupabaseFilter(input.where);
      switch (input.model) {
        case "bundles": {
          let query = supabase.from(SUPABASE_V1_TABLE_NAMES.bundles).delete();
          if (filter !== undefined) query = query.or(filter);
          const { error } = await query;
          throwSupabaseError("delete bundles", error);
          return;
        }
        case "bundle_patches": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.bundlePatches)
            .delete();
          if (filter !== undefined) query = query.or(filter);
          const { error } = await query;
          throwSupabaseError("delete bundle_patches", error);
          return;
        }
        case "channels": {
          let query = supabase.from(SUPABASE_V1_TABLE_NAMES.channels).delete();
          if (filter !== undefined) query = query.or(filter);
          const { error } = await query;
          if (isForeignKeyViolation(error)) {
            throw new DatabaseRowReferencedError();
          }
          throwSupabaseError("delete channels", error);
        }
        case "releases": {
          let query = supabase.from(SUPABASE_V1_TABLE_NAMES.releases).delete();
          if (filter !== undefined) query = query.or(filter);
          const { error } = await query;
          throwSupabaseError("delete releases", error);
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
            .from(SUPABASE_V1_TABLE_NAMES.bundles)
            .select("*", { count: "exact", head: true });
          if (filter !== undefined) query = query.or(filter);
          const { count, error } = await query;
          throwSupabaseError("count bundles", error);
          return count ?? 0;
        }
        case "bundle_patches": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.bundlePatches)
            .select("*", { count: "exact", head: true });
          if (filter !== undefined) query = query.or(filter);
          const { count, error } = await query;
          throwSupabaseError("count bundle_patches", error);
          return count ?? 0;
        }
        case "releases": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.releases)
            .select("*", { count: "exact", head: true });
          if (filter !== undefined) query = query.or(filter);
          const { count, error } = await query;
          throwSupabaseError("count releases", error);
          return count ?? 0;
        }
      }
    },
    async findOne(input: FindOneDatabaseImplementationInput) {
      const filter = buildSupabaseFilter(input.where);
      switch (input.model) {
        case "bundles": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.bundles)
            .select("*");
          if (filter !== undefined) query = query.or(filter);
          const { data, error } = await query.limit(1).maybeSingle();
          throwSupabaseError("findOne bundles", error);
          return data;
        }
        case "api_keys": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.apiKeys)
            .select("*");
          if (filter !== undefined) query = query.or(filter);
          const { data, error } = await query.limit(1).maybeSingle();
          throwSupabaseError("findOne api_keys", error);
          return data;
        }
        case "channels": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.channels)
            .select("*");
          if (filter !== undefined) query = query.or(filter);
          const { data, error } = await query.limit(1).maybeSingle();
          throwSupabaseError("findOne channels", error);
          return data;
        }
        case "bundle_patches": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.bundlePatches)
            .select("*");
          if (filter !== undefined) query = query.or(filter);
          const { data, error } = await query.limit(1).maybeSingle();
          throwSupabaseError("findOne bundle_patches", error);
          return data;
        }
        case "releases": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.releases)
            .select("*");
          if (filter !== undefined) query = query.or(filter);
          const { data, error } = await query.limit(1).maybeSingle();
          throwSupabaseError("findOne releases", error);
          return data;
        }
        case "release_catalogs": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.releaseCatalogs)
            .select("*");
          if (filter !== undefined) query = query.or(filter);
          const { data, error } = await query.limit(1).maybeSingle();
          throwSupabaseError("findOne release_catalogs", error);
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
      const orderBy = input.orderBy ?? [];
      switch (input.model) {
        case "bundles": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.bundles)
            .select("*");
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
        case "api_keys": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.apiKeys)
            .select("*");
          if (filter !== undefined) query = query.or(filter);
          for (const clause of orderBy) {
            query = query.order(clause.field, {
              ascending: clause.direction === "asc",
              ...(clause.nulls ? { nullsFirst: clause.nulls === "first" } : {}),
            });
          }
          const { data, error } = await query.range(input.offset, rangeEnd);
          throwSupabaseError("findMany api_keys", error);
          return data ?? [];
        }
        case "bundle_patches": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.bundlePatches)
            .select("*");
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
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.channels)
            .select("*");
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
        case "releases": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.releases)
            .select("*");
          if (filter !== undefined) query = query.or(filter);
          for (const clause of orderBy) {
            query = query.order(clause.field, {
              ascending: clause.direction === "asc",
              ...(clause.nulls ? { nullsFirst: clause.nulls === "first" } : {}),
            });
          }
          const { data, error } = await query.range(input.offset, rangeEnd);
          throwSupabaseError("findMany releases", error);
          return data ?? [];
        }
        case "release_catalogs": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.releaseCatalogs)
            .select("*");
          if (filter !== undefined) query = query.or(filter);
          for (const clause of orderBy) {
            query = query.order(clause.field, {
              ascending: clause.direction === "asc",
              ...(clause.nulls ? { nullsFirst: clause.nulls === "first" } : {}),
            });
          }
          const { data, error } = await query.range(input.offset, rangeEnd);
          throwSupabaseError("findMany release_catalogs", error);
          return data ?? [];
        }
      }
    },
    async insertChannel(input) {
      const { data: inserted, error: insertError } = await supabase
        .from(SUPABASE_V1_TABLE_NAMES.channels)
        .upsert(input.row, { onConflict: "name", ignoreDuplicates: true })
        .select("*")
        .maybeSingle();
      throwSupabaseError("insert channel", insertError);
      if (inserted !== null) return { row: inserted, inserted: true };

      const { data: existing, error: findError } = await supabase
        .from(SUPABASE_V1_TABLE_NAMES.channels)
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
      const { data, error } = await supabase.rpc(
        SUPABASE_V1_FUNCTION_NAMES.deleteChannel,
        {
          p_id: input.id,
        },
      );
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
  };
  implementation.commit = async (input) => {
    const { data, error } = await supabase.rpc(
      SUPABASE_V1_FUNCTION_NAMES.commit,
      {
        p_commit: input,
      },
    );
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
  const databaseNamespace = readSupabaseInsightsDatabaseNamespace(
    OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
  );
  const supabase = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  );
  const adapter = createDatabasePluginAdapter(
    "supabaseDatabase",
    createSupabaseImplementation(supabase, databaseNamespace),
  );
  return createDatabasePlugin({
    name: "supabaseDatabase",
    models: adapter.models,
    commit: adapter.commit,
  });
};

/**
 * Creates the provider-local bounded worker used by an external scheduler.
 * `runScheduledStep` discovers one durable source/search/report job, so callers
 * do not need to persist a job ID between invocations.
 */
export const supabaseInsightsMaintenance = (config: SupabaseDatabaseConfig) => {
  const databaseNamespace = readSupabaseInsightsDatabaseNamespace(
    OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
  );
  const supabase = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  );
  return createSupabaseInsightsMaintenance(supabase, databaseNamespace);
};
