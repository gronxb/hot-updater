import type { GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { getUpdateInfo as getUpdateInfoJS } from "@hot-updater/js";
import type { DatabasePlugin } from "@hot-updater/plugin-core";
import {
  setupBundleMethodsTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { beforeEach, describe, vi } from "vitest";

import { supabaseDatabase } from "./supabaseDatabase";

type SupabaseBundleRow = {
  id: string;
  channel: string;
  enabled: boolean;
  should_force_update: boolean;
  file_hash: string;
  git_commit_hash: string | null;
  message: string | null;
  platform: "ios" | "android";
  target_app_version: string | null;
  fingerprint_hash: string | null;
  storage_uri: string;
  metadata: Record<string, unknown> | null;
  rollout_cohort_count: number | null;
  target_cohorts: string[] | null;
};

const { bundleRows, createMockSupabaseClient } = vi.hoisted(() => {
  const bundleRows = new Map<string, SupabaseBundleRow>();

  type QueryFilter =
    | {
        type: "eq" | "gt" | "gte" | "lt" | "lte" | "is";
        column: string;
        value: unknown;
      }
    | {
        type: "in";
        column: string;
        values: unknown[];
      }
    | {
        type: "not";
        column: string;
        operator: string;
        value: unknown;
      };

  const compareValues = (left: unknown, right: unknown) => {
    if (typeof left === "string" && typeof right === "string") {
      return left.localeCompare(right);
    }

    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }

    if (typeof left === "boolean" && typeof right === "boolean") {
      return Number(left) - Number(right);
    }

    return String(left).localeCompare(String(right));
  };

  class QueryBuilder {
    private readonly filters: QueryFilter[] = [];
    private ascending = true;
    private limitValue: number | undefined;
    private rangeStart: number | undefined;
    private rangeEnd: number | undefined;
    private singleRow = false;

    constructor(
      private readonly mode: "select" | "delete",
      private readonly options?: { count?: string; head?: boolean },
    ) {}

    eq(column: string, value: unknown) {
      this.filters.push({ type: "eq", column, value });
      return this;
    }

    gt(column: string, value: unknown) {
      this.filters.push({ type: "gt", column, value });
      return this;
    }

    gte(column: string, value: unknown) {
      this.filters.push({ type: "gte", column, value });
      return this;
    }

    lt(column: string, value: unknown) {
      this.filters.push({ type: "lt", column, value });
      return this;
    }

    lte(column: string, value: unknown) {
      this.filters.push({ type: "lte", column, value });
      return this;
    }

    in(column: string, values: unknown[]) {
      this.filters.push({ type: "in", column, values });
      return this;
    }

    is(column: string, value: unknown) {
      this.filters.push({ type: "is", column, value });
      return this;
    }

    not(column: string, operator: string, value: unknown) {
      this.filters.push({ type: "not", column, operator, value });
      return this;
    }

    order(_column: string, options?: { ascending?: boolean }) {
      this.ascending = options?.ascending ?? true;
      return this;
    }

    limit(value: number) {
      this.limitValue = value;
      return this;
    }

    range(from: number, to: number) {
      this.rangeStart = from;
      this.rangeEnd = to;
      return this;
    }

    single() {
      this.singleRow = true;
      return this;
    }

    // This mock must be awaitable to match the Supabase query builder API.
    then<TResult1 = any, TResult2 = never>(
      onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return this.execute().then(onfulfilled, onrejected);
    }

    private async execute() {
      if (this.mode === "delete") {
        const filteredRows = this.getFilteredRows();
        for (const row of filteredRows) {
          bundleRows.delete(row.id);
        }
        return { error: null };
      }

      let filteredRows = this.getFilteredRows();
      filteredRows = filteredRows.sort((a, b) =>
        this.ascending ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id),
      );

      const total = filteredRows.length;

      if (this.singleRow) {
        const data = filteredRows[0] ?? null;
        return {
          data,
          error: data ? null : { message: "Row not found" },
        };
      }

      if (this.options?.head) {
        return {
          data: null,
          count: total,
          error: null,
        };
      }

      if (this.rangeStart !== undefined && this.rangeEnd !== undefined) {
        filteredRows = filteredRows.slice(this.rangeStart, this.rangeEnd + 1);
      } else if (this.limitValue !== undefined) {
        filteredRows = filteredRows.slice(0, this.limitValue);
      }

      return {
        data: filteredRows,
        count: total,
        error: null,
      };
    }

    private getFilteredRows() {
      let filteredRows = Array.from(bundleRows.values());

      for (const filter of this.filters) {
        filteredRows = filteredRows.filter((row) => {
          const rowValue = row[filter.column as keyof SupabaseBundleRow];

          switch (filter.type) {
            case "eq":
              return rowValue === filter.value;
            case "gt":
              return compareValues(rowValue, filter.value) > 0;
            case "gte":
              return compareValues(rowValue, filter.value) >= 0;
            case "lt":
              return compareValues(rowValue, filter.value) < 0;
            case "lte":
              return compareValues(rowValue, filter.value) <= 0;
            case "in":
              return filter.values.includes(rowValue);
            case "is":
              return rowValue === filter.value;
            case "not":
              if (filter.operator === "is") {
                return rowValue !== filter.value;
              }

              throw new Error(
                `Unsupported not operator in Supabase mock: ${filter.operator}`,
              );
          }

          return false;
        });
      }

      return filteredRows;
    }
  }

  const createMockSupabaseClient = () => ({
    from(table: string) {
      if (table !== "bundles") {
        throw new Error(`Unsupported table in Supabase mock: ${table}`);
      }

      return {
        select(_columns: string, options?: { count?: string; head?: boolean }) {
          return new QueryBuilder("select", options);
        },
        delete() {
          return new QueryBuilder("delete");
        },
        async upsert(payload: SupabaseBundleRow) {
          bundleRows.set(payload.id, payload);
          return { error: null };
        },
      };
    },
    async rpc(name: string, params?: Record<string, unknown>) {
      if (name === "get_channels") {
        return {
          data: Array.from(
            new Set(Array.from(bundleRows.values()).map((row) => row.channel)),
          ).map((channel) => ({ channel })),
          error: null,
        };
      }

      if (name === "get_target_app_version_list") {
        const platform = params?.app_platform as SupabaseBundleRow["platform"];
        const minBundleId = params?.min_bundle_id as string;

        const data = Array.from(
          new Set(
            Array.from(bundleRows.values())
              .filter(
                (row) =>
                  row.platform === platform &&
                  row.id.localeCompare(minBundleId) >= 0 &&
                  row.target_app_version,
              )
              .map((row) => row.target_app_version),
          ),
        ).map((targetAppVersion) => ({
          target_app_version: targetAppVersion,
        }));

        return { data, error: null };
      }

      if (name === "get_update_info_by_app_version") {
        const platform = params?.app_platform as SupabaseBundleRow["platform"];
        const appVersion = params?.app_version as string;
        const bundleId = params?.bundle_id as string;
        const minBundleId = params?.min_bundle_id as string;
        const channel = params?.target_channel as string;
        const targetAppVersionList = (params?.target_app_version_list ??
          []) as string[];
        const cohort = (params?.cohort as string | null) ?? undefined;

        const bundles = Array.from(bundleRows.values())
          .filter(
            (row) =>
              row.enabled &&
              row.platform === platform &&
              row.channel === channel &&
              row.id.localeCompare(minBundleId) >= 0 &&
              targetAppVersionList.includes(row.target_app_version ?? ""),
          )
          .map(toBundle);

        const updateInfo = (await getUpdateInfoJS(bundles, {
          _updateStrategy: "appVersion",
          appVersion,
          bundleId,
          minBundleId,
          channel,
          cohort,
          platform,
        })) as UpdateInfo | null;

        return {
          data: updateInfo ? [toUpdateInfoRow(updateInfo)] : [],
          error: null,
        };
      }

      if (name === "get_update_info_by_fingerprint_hash") {
        const platform = params?.app_platform as SupabaseBundleRow["platform"];
        const bundleId = params?.bundle_id as string;
        const minBundleId = params?.min_bundle_id as string;
        const channel = params?.target_channel as string;
        const fingerprintHash = params?.target_fingerprint_hash as string;
        const cohort = (params?.cohort as string | null) ?? undefined;

        const bundles = Array.from(bundleRows.values())
          .filter(
            (row) =>
              row.enabled &&
              row.platform === platform &&
              row.channel === channel &&
              row.id.localeCompare(minBundleId) >= 0 &&
              row.fingerprint_hash === fingerprintHash,
          )
          .map(toBundle);

        const updateInfo = (await getUpdateInfoJS(bundles, {
          _updateStrategy: "fingerprint",
          fingerprintHash,
          bundleId,
          minBundleId,
          channel,
          cohort,
          platform,
        })) as UpdateInfo | null;

        return {
          data: updateInfo ? [toUpdateInfoRow(updateInfo)] : [],
          error: null,
        };
      }

      return { data: null, error: new Error(`Unsupported RPC: ${name}`) };
    },
  });

  return { bundleRows, createMockSupabaseClient };
});

const toBundle = (row: SupabaseBundleRow) => ({
  channel: row.channel,
  enabled: row.enabled,
  shouldForceUpdate: row.should_force_update,
  fileHash: row.file_hash,
  gitCommitHash: row.git_commit_hash,
  id: row.id,
  message: row.message,
  platform: row.platform,
  targetAppVersion: row.target_app_version,
  fingerprintHash: row.fingerprint_hash,
  storageUri: row.storage_uri,
  metadata: row.metadata ?? {},
  rolloutCohortCount: row.rollout_cohort_count ?? 1000,
  targetCohorts: row.target_cohorts ?? null,
});

const toUpdateInfoRow = (updateInfo: UpdateInfo) => ({
  id: updateInfo.id,
  should_force_update: updateInfo.shouldForceUpdate,
  message: updateInfo.message,
  status: updateInfo.status,
  storage_uri: updateInfo.storageUri,
  file_hash: updateInfo.fileHash,
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => createMockSupabaseClient(),
}));

describe("supabaseDatabase plugin", () => {
  let plugin: DatabasePlugin;

  beforeEach(() => {
    bundleRows.clear();
    plugin = supabaseDatabase({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseAnonKey: "test-anon-key",
    })();
  });

  setupBundleMethodsTestSuite({
    getBundleById: (id) => plugin.getBundleById(id),
    getChannels: () => plugin.getChannels(),
    insertBundle: async (bundle) => {
      await plugin.appendBundle(bundle);
      await plugin.commitBundle();
    },
    getBundles: (options) => plugin.getBundles(options),
    updateBundleById: async (bundleId, newBundle) => {
      await plugin.updateBundle(bundleId, newBundle);
      await plugin.commitBundle();
    },
    deleteBundleById: async (bundleId) => {
      const bundle = await plugin.getBundleById(bundleId);
      if (!bundle) {
        return;
      }
      await plugin.deleteBundle(bundle);
      await plugin.commitBundle();
    },
  });

  setupGetUpdateInfoTestSuite({
    getUpdateInfo: async (bundles, args: GetBundlesArgs) => {
      bundleRows.clear();

      for (const bundle of bundles) {
        await plugin.appendBundle(bundle);
      }
      await plugin.commitBundle();

      return plugin.getUpdateInfo?.(args) ?? null;
    },
  });
});
