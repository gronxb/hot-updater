import type { BundleEventRow } from "@hot-updater/plugin-core";
import {
  createDatabasePlugin,
  DatabasePluginInputError,
} from "@hot-updater/plugin-core";
import {
  insightsHourlyBucketKey,
  insightsLifetimeMarkerKey,
  insightsReleaseKey,
  recordProjectedInsightsEvent,
} from "@hot-updater/plugin-core/internal";
import {
  latestInsightsWhere,
  latestInsightsCountGroups,
} from "@hot-updater/plugin-core/internal";
import type {
  CountDatabaseImplementationInput,
  CreateDatabaseImplementationInput,
  DatabasePluginImplementation,
  DeleteDatabaseImplementationInput,
  DatabaseImplementationResult,
  FindManyDatabaseImplementationInput,
  FindOneDatabaseImplementationInput,
  InsightsProjectionBackend,
  PreparedInsightsEvent,
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
import {
  SUPABASE_V1_FUNCTION_NAMES,
  SUPABASE_V1_TABLE_NAMES,
} from "./supabaseInfrastructureNames";
import { SupabaseMissingDataError, throwSupabaseError } from "./supabaseResult";
import type { Database } from "./types";

export type SupabaseDatabaseConfig = SupabaseServiceRoleConfig;

const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "code") === "23503";

const createSupabaseInsightsProjection = (
  supabase: SupabaseClient<Database>,
): InsightsProjectionBackend => ({
  async readRecordContext({ installId, lifetimeKey }) {
    const [stateResult, markerResult] = await Promise.all([
      supabase
        .from(SUPABASE_V1_TABLE_NAMES.insightsInstallStates)
        .select("revision,state")
        .eq("install_id", installId)
        .maybeSingle(),
      lifetimeKey === null
        ? Promise.resolve({ data: null, error: null })
        : supabase
            .from(SUPABASE_V1_TABLE_NAMES.insightsLifetimeMarkers)
            .select("marker_key")
            .eq("marker_key", insightsLifetimeMarkerKey(lifetimeKey))
            .maybeSingle(),
    ]);
    throwSupabaseError("read insights state", stateResult.error);
    throwSupabaseError("read insights lifetime marker", markerResult.error);
    return {
      revision: String(stateResult.data?.revision ?? 0),
      state: stateResult.data?.state ?? null,
      lifetimeExists: markerResult.data !== null,
    };
  },
  async commitPreparedEvent(prepared: PreparedInsightsEvent) {
    const payload = {
      ...prepared,
      summaryDeltas: prepared.summaryDeltas.map((delta) => ({
        releaseKey: insightsReleaseKey(delta.release),
        ...delta,
      })),
      firstLifetime:
        prepared.firstLifetime === null
          ? null
          : {
              ...prepared.firstLifetime,
              markerKey: insightsLifetimeMarkerKey(prepared.firstLifetime),
              releaseKey: insightsReleaseKey(prepared.firstLifetime.release),
            },
      hourly:
        prepared.hourly === null
          ? null
          : {
              ...prepared.hourly,
              bucketKey: insightsHourlyBucketKey(
                prepared.hourly.release,
                prepared.hourly.hourStartMs,
              ),
              releaseKey: insightsReleaseKey(prepared.hourly.release),
            },
    };
    const { data, error } = await supabase.rpc(
      SUPABASE_V1_FUNCTION_NAMES.recordPreparedEvent,
      { p_prepared: payload },
    );
    throwSupabaseError("record prepared insights", error);
    if (data !== "committed" && data !== "duplicate" && data !== "conflict") {
      throw new SupabaseMissingDataError("record prepared insights");
    }
    return { status: data };
  },
  async getReleaseActivity(input) {
    const keys = input.releases.map(insightsReleaseKey);
    const { data, error } = await supabase.rpc(
      SUPABASE_V1_FUNCTION_NAMES.getReleaseActivity,
      {
        p_release_keys: keys,
        p_start: input.timeRange?.start ?? null,
        p_end: input.timeRange?.end ?? null,
      },
    );
    throwSupabaseError("get release activity", error);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new SupabaseMissingDataError("get release activity");
    }
    const result = data as {
      summaries?: Record<string, unknown>[];
      hourly?: Record<string, unknown>[];
    };
    const summaries = new Map(
      (result.summaries ?? []).map((row) => [String(row.release_key), row]),
    );
    const hourly = new Map<string, Record<string, unknown>[]>();
    for (const row of result.hourly ?? []) {
      const key = String(row.release_key);
      const points = hourly.get(key) ?? [];
      points.push(row);
      hourly.set(key, points);
    }
    const count = (value: unknown) => {
      const number = Number(value ?? 0);
      if (!Number.isSafeInteger(number) || number < 0) {
        throw new SupabaseMissingDataError("get release activity");
      }
      return number;
    };
    return {
      coverage: { kind: "complete" as const, sinceMs: 0 },
      data: input.releases.map((release) => {
        const key = insightsReleaseKey(release);
        const summary = summaries.get(key);
        return {
          release,
          summary: {
            activeInstallations: count(summary?.active_installations),
            pendingInstallations: count(summary?.pending_installations),
            downloadedInstallations: count(summary?.downloaded_installations),
            recoveredInstallations: count(summary?.recovered_installations),
          },
          ...(input.timeRange === undefined
            ? {}
            : {
                series: (hourly.get(key) ?? []).map((row) => ({
                  startMs: count(row.hour_start_ms),
                  downloadedReports: count(row.downloaded_reports),
                  appliedReports: count(row.applied_reports),
                  recoveredReports: count(row.recovered_reports),
                })),
              }),
          measuredAtMs: Date.now(),
        };
      }),
    };
  },
});

const createSupabaseImplementation = (
  supabase: SupabaseClient<Database>,
): DatabasePluginImplementation => {
  const insightsProjection = createSupabaseInsightsProjection(supabase);
  const implementation: DatabasePluginImplementation = {
    recordInsights: (input) =>
      recordProjectedInsightsEvent(insightsProjection, input),
    getReleaseActivity: (input) => insightsProjection.getReleaseActivity(input),
    async findLatestInsightsEvents(input) {
      const limit = "installId" in input ? 1 : input.limit;
      const heads: Pick<BundleEventRow, "id" | "install_id">[] = [];
      const filter = buildSupabaseFilter(latestInsightsWhere(input));
      while (heads.length < limit) {
        let query = supabase
          .from(SUPABASE_V1_TABLE_NAMES.bundleEventHeads)
          .select("id,install_id");
        if (filter !== undefined) query = query.or(filter);
        const { data, error } = await query
          .order("install_id", { ascending: true })
          .range(heads.length, limit - 1);
        throwSupabaseError("find latest insights events", error);
        if (data === null)
          throw new SupabaseMissingDataError("find latest insights events");
        if (data.length === 0) break;
        heads.push(...data);
      }
      const rows: BundleEventRow[] = [];
      while (rows.length < heads.length) {
        const { data, error } = await supabase
          .from(SUPABASE_V1_TABLE_NAMES.bundleEvents)
          .select("*")
          .in(
            "id",
            heads.map(({ id }) => id),
          )
          .order("id", { ascending: true })
          .range(rows.length, heads.length - 1);
        throwSupabaseError("find latest insights events", error);
        if (data === null || data.length === 0)
          throw new SupabaseMissingDataError("find latest insights events");
        rows.push(...data);
      }
      const eventsById = new Map(rows.map((event) => [event.id, event]));
      return heads.map(({ id }) => {
        const event = eventsById.get(id);
        if (event === undefined)
          throw new SupabaseMissingDataError("find latest insights events");
        return event;
      });
    },
    async countLatestInsightsEvents(input) {
      let query = supabase
        .from(SUPABASE_V1_TABLE_NAMES.bundleEventHeads)
        .select("*", { count: "exact", head: true });
      const filter = latestInsightsCountGroups(input)
        .map(buildSupabaseFilter)
        .join(",");
      if (filter !== undefined) query = query.or(filter);
      const { count, error } = await query;
      throwSupabaseError("count latest insights events", error);
      if (count === null)
        throw new SupabaseMissingDataError("count latest insights events");
      return count;
    },
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
        case "bundle_events": {
          const { data, error } = await supabase
            .from(SUPABASE_V1_TABLE_NAMES.bundleEvents)
            .insert(input.data)
            .select("*")
            .single();
          throwSupabaseError("create bundle_events", error);
          if (data === null) {
            throw new SupabaseMissingDataError("create bundle_events");
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
        case "bundle_events": {
          let query = supabase
            .from(SUPABASE_V1_TABLE_NAMES.bundleEvents)
            .select("*", { count: "exact", head: true });
          if (filter !== undefined) query = query.or(filter);
          const { count, error } = await query;
          throwSupabaseError(`count ${input.model}`, error);
          if (count === null)
            throw new SupabaseMissingDataError(`count ${input.model}`);
          return count;
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
        case "bundle_events": {
          const rows: DatabaseImplementationResult[] = [];
          // PostgREST's max_rows can shorten a successful response. Only a
          // successful empty query proves that a short prefix is exhausted.
          while (rows.length < input.limit) {
            let query = supabase
              .from(SUPABASE_V1_TABLE_NAMES.bundleEvents)
              .select("*");
            if (filter !== undefined) query = query.or(filter);
            for (const clause of orderBy) {
              query = query.order(clause.field, {
                ascending: clause.direction === "asc",
                ...(clause.nulls
                  ? { nullsFirst: clause.nulls === "first" }
                  : {}),
              });
            }
            const { data, error } = await query.range(
              input.offset + rows.length,
              rangeEnd,
            );
            throwSupabaseError(`findMany ${input.model}`, error);
            if (data === null)
              throw new SupabaseMissingDataError(`findMany ${input.model}`);
            if (data.length === 0) break;
            rows.push(...data);
          }
          return rows;
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
    commit: adapter.commit,
  });
};
