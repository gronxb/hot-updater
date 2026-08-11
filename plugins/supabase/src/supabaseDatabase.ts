import type {
  CountDatabaseImplementationInput,
  CreateDatabaseImplementationInput,
  DatabaseCommit,
  DatabaseCommitResult,
  DatabasePluginImplementation,
  DeleteDatabaseImplementationInput,
  FindManyDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  UpdateBundleDatabaseImplementationInput,
} from "@hot-updater/plugin-core";
import {
  createDatabasePlugin,
  DatabaseAtomicCommitUnsupportedError,
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
import { createSupabaseUniversalComponentDataAdapter } from "./supabaseUniversalComponentData";
import type { Database } from "./types";

export type SupabaseDatabaseConfig = SupabaseServiceRoleConfig;

const applySupabaseCommit = async (
  supabase: SupabaseClient<Database>,
  implementation: DatabasePluginImplementation,
  input: DatabaseCommit,
): Promise<DatabaseCommitResult> => {
  const bundleInsert = input.changes.find(
    (change) => change.table === "bundles" && change.operation === "insert",
  );
  const patchInserts = input.changes.filter(
    (change) =>
      change.table === "bundle_patches" && change.operation === "insert",
  );
  if (
    input.operation === "insert" &&
    bundleInsert?.table === "bundles" &&
    bundleInsert.operation === "insert" &&
    patchInserts.length > 0 &&
    input.changes.length === patchInserts.length + 1
  ) {
    const { error } = await supabase.rpc(
      "hot_updater_create_bundle_with_patches",
      {
        p_bundle: bundleInsert.row,
        p_patches: patchInserts.map((change) => change.row),
      },
    );
    throwSupabaseError("create bundle with patches", error);
    return { applied: true };
  }

  const bundleUpdate = input.changes.find(
    (change) => change.table === "bundles" && change.operation === "update",
  );
  const patchChanges = input.changes.filter(
    (change) => change.table === "bundle_patches",
  );
  if (
    input.operation === "update" &&
    patchChanges.length > 0 &&
    input.changes.every(
      (change) =>
        (change.table === "bundles" && change.operation === "update") ||
        (change.table === "bundle_patches" &&
          (change.operation === "delete" || change.operation === "insert")),
    )
  ) {
    const { data, error } = await supabase.rpc(
      "hot_updater_update_bundle_with_patches",
      {
        p_bundle_id: input.bundleId,
        p_update:
          bundleUpdate?.table === "bundles" &&
          bundleUpdate.operation === "update"
            ? bundleUpdate.update
            : {},
        p_patches: patchChanges.flatMap((change) =>
          change.operation === "insert" ? [change.row] : [],
        ),
      },
    );
    throwSupabaseError("update bundle with patches", error);
    if (data === null) {
      throw new SupabaseMissingDataError("update bundle with patches");
    }
    return { applied: data };
  }

  if (input.changes.length === 0 && input.operation === "update") {
    const row = await implementation.findOne({
      model: "bundles",
      where: [{ field: "id", value: input.bundleId }],
    });
    return { applied: row !== null };
  }
  if (input.changes.length !== 1) {
    throw new DatabaseAtomicCommitUnsupportedError("supabaseDatabase");
  }
  const change = input.changes[0];
  if (change.table === "bundles") {
    switch (change.operation) {
      case "insert":
        await implementation.create({ model: "bundles", data: change.row });
        return { applied: true };
      case "update":
        return {
          applied:
            (await implementation.update({
              model: "bundles",
              where: [{ field: "id", value: change.id }],
              update: change.update,
            })) !== null,
        };
      case "delete":
        await implementation.delete({
          model: "bundles",
          where: [{ field: "id", value: change.id }],
        });
        return { applied: true };
    }
  }
  if (change.operation === "insert") {
    await implementation.create({
      model: "bundle_patches",
      data: change.row,
    });
  } else {
    await implementation.delete({
      model: "bundle_patches",
      where: [{ field: "bundle_id", value: change.bundleId }],
    });
  }
  return { applied: true };
};

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
  };
  implementation.commit = (input) =>
    applySupabaseCommit(supabase, implementation, input);
  return implementation;
};

export const supabaseDatabase = (config: SupabaseDatabaseConfig) => {
  const supabase = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  );
  const database = createDatabasePlugin({
    name: "supabaseDatabase",
    plugin: () => createSupabaseImplementation(supabase),
  });
  return {
    ...database,
    componentData: createSupabaseUniversalComponentDataAdapter(supabase),
  };
};
