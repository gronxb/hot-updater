import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
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

    // biome-ignore lint/suspicious/noThenProperty: this mock must be awaitable to match the Supabase query builder API.
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
    async rpc(name: string) {
      if (name !== "get_channels") {
        return { data: null, error: new Error(`Unsupported RPC: ${name}`) };
      }

      return {
        data: Array.from(
          new Set(Array.from(bundleRows.values()).map((row) => row.channel)),
        ).map((channel) => ({ channel })),
        error: null,
      };
    },
  });

  return { bundleRows, createMockSupabaseClient };
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
});
