import {
  databaseAnalyticsSupport,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
import { expect, it, vi } from "vitest";

import { supabaseDatabase } from "./supabaseDatabase";

// allow: SIZE_OK — hoisted PostgREST query/filter state machine for public adapter conformance.
const { createMockClient, resetMockClient } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type TableName = "bundle_events" | "bundle_patches" | "bundles";
  type QueryError = { readonly message: string };
  type QueryResult = {
    readonly count: number | null;
    readonly data: Row | readonly Row[] | null;
    readonly error: QueryError | null;
  };

  const rows: Record<TableName, Map<string, Row>> = {
    bundle_events: new Map(),
    bundle_patches: new Map(),
    bundles: new Map(),
  };

  const splitTopLevel = (value: string): readonly string[] => {
    const parts: string[] = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
      if (!quoted && character === "(") depth += 1;
      if (!quoted && character === ")") depth -= 1;
      if (!quoted && depth === 0 && character === ",") {
        parts.push(value.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(value.slice(start));
    return parts;
  };

  const decode = (value: string): boolean | number | string => {
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
      : value;
  };

  const compare = (left: unknown, right: unknown): number => {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  };

  const matchesPredicate = (row: Row, expression: string): boolean => {
    const markers = [
      ".not.is.",
      ".not.in.",
      ".not.ilike.",
      ".ilike.",
      ".like.",
      ".neq.",
      ".gte.",
      ".lte.",
      ".is.",
      ".in.",
      ".eq.",
      ".gt.",
      ".lt.",
    ] as const;
    const marker = markers.find((candidate) => expression.includes(candidate));
    if (marker === undefined) return false;
    const markerIndex = expression.indexOf(marker);
    const field = expression.slice(0, markerIndex);
    const rawValue = expression.slice(markerIndex + marker.length);
    const rowValue = row[field];
    switch (marker) {
      case ".not.is.":
        return rowValue !== null;
      case ".is.":
        return rowValue === null;
      case ".in.":
      case ".not.in.": {
        const candidates = splitTopLevel(rawValue.slice(1, -1)).map(decode);
        const included = candidates.includes(
          typeof rowValue === "string" || typeof rowValue === "number"
            ? rowValue
            : String(rowValue),
        );
        return marker === ".in." ? included : rowValue !== null && !included;
      }
      case ".eq.":
        return rowValue === decode(rawValue);
      case ".neq.":
        return rowValue !== null && rowValue !== decode(rawValue);
      case ".gt.":
        return rowValue !== null && compare(rowValue, decode(rawValue)) > 0;
      case ".gte.":
        return rowValue !== null && compare(rowValue, decode(rawValue)) >= 0;
      case ".lt.":
        return rowValue !== null && compare(rowValue, decode(rawValue)) < 0;
      case ".lte.":
        return rowValue !== null && compare(rowValue, decode(rawValue)) <= 0;
      case ".like.":
      case ".not.ilike.":
      case ".ilike.": {
        const pattern = String(decode(rawValue));
        const actual = String(rowValue);
        const insensitive = marker === ".ilike." || marker === ".not.ilike.";
        const left = insensitive ? actual.toLowerCase() : actual;
        const right = insensitive ? pattern.toLowerCase() : pattern;
        const matched =
          right.startsWith("*") && right.endsWith("*")
            ? left.includes(right.slice(1, -1))
            : right.startsWith("*")
              ? left.endsWith(right.slice(1))
              : right.endsWith("*")
                ? left.startsWith(right.slice(0, -1))
                : left === right;
        return marker === ".not.ilike."
          ? rowValue !== null && !matched
          : matched;
      }
    }
  };

  const matches = (row: Row, expression: string): boolean => {
    if (
      (expression.startsWith("and(") || expression.startsWith("or(")) &&
      expression.endsWith(")")
    ) {
      const isAnd = expression.startsWith("and(");
      const expressions = splitTopLevel(expression.slice(isAnd ? 4 : 3, -1));
      return isAnd
        ? expressions.every((part) => matches(row, part))
        : expressions.some((part) => matches(row, part));
    }
    return matchesPredicate(row, expression);
  };

  class QueryBuilder {
    private filter: string | undefined;
    private head = false;
    private limitValue: number | undefined;
    private mode: "delete" | "insert" | "select" | "update" = "select";
    private readonly orderClauses: {
      readonly field: string;
      readonly ascending: boolean;
    }[] = [];
    private payload: Row | undefined;
    private rangeStart = 0;
    private rangeEnd: number | undefined;
    private singleRow = false;

    constructor(private readonly table: TableName) {}

    insert(payload: Row) {
      this.mode = "insert";
      this.payload = payload;
      return this;
    }
    update(payload: Row) {
      this.mode = "update";
      this.payload = payload;
      return this;
    }
    delete() {
      this.mode = "delete";
      return this;
    }
    select(_columns = "*", options?: { readonly head?: boolean }) {
      this.head = options?.head ?? false;
      return this;
    }
    or(filter: string) {
      this.filter = filter;
      return this;
    }
    order(field: string, options?: { readonly ascending?: boolean }) {
      this.orderClauses.push({
        field,
        ascending: options?.ascending ?? true,
      });
      return this;
    }
    limit(value: number) {
      this.limitValue = value;
      return this;
    }
    range(start: number, end: number) {
      this.rangeStart = start;
      this.rangeEnd = end;
      return this;
    }
    single() {
      this.singleRow = true;
      return this;
    }
    maybeSingle() {
      this.singleRow = true;
      return this;
    }
    then<TResult1 = QueryResult, TResult2 = never>(
      onfulfilled?:
        | ((value: QueryResult) => PromiseLike<TResult1> | TResult1)
        | null,
      onrejected?:
        | ((reason: unknown) => PromiseLike<TResult2> | TResult2)
        | null,
    ) {
      return this.execute().then(onfulfilled, onrejected);
    }

    private selectedRows(): Row[] {
      return [...rows[this.table].values()]
        .filter((row) => this.filter === undefined || matches(row, this.filter))
        .sort((left, right) => {
          const clauses = this.orderClauses.length
            ? this.orderClauses
            : [{ field: "id", ascending: true }];
          for (const clause of clauses) {
            const result = compare(left[clause.field], right[clause.field]);
            if (result !== 0) return clause.ascending ? result : -result;
          }
          return 0;
        });
    }

    private async execute(): Promise<QueryResult> {
      if (this.mode === "insert") return this.executeInsert();
      const selected = this.selectedRows();
      if (this.mode === "update") {
        for (const row of selected) Object.assign(row, this.payload);
      }
      if (this.mode === "delete") {
        for (const row of selected) {
          const id = String(row.id);
          rows[this.table].delete(id);
          if (this.table === "bundles") {
            for (const patch of rows.bundle_patches.values()) {
              if (patch.bundle_id === id || patch.base_bundle_id === id) {
                rows.bundle_patches.delete(String(patch.id));
              }
            }
          }
        }
        return { count: null, data: null, error: null };
      }
      const end =
        this.rangeEnd ??
        (this.limitValue === undefined
          ? undefined
          : this.rangeStart + this.limitValue - 1);
      const data =
        end === undefined ? selected : selected.slice(this.rangeStart, end + 1);
      return {
        count: selected.length,
        data: this.head ? null : this.singleRow ? (data[0] ?? null) : data,
        error: null,
      };
    }

    private async executeInsert(): Promise<QueryResult> {
      const payload = this.payload;
      if (payload === undefined) {
        return {
          count: null,
          data: null,
          error: { message: "missing payload" },
        };
      }
      const id = String(payload.id);
      if (rows[this.table].has(id)) {
        return { count: null, data: null, error: { message: "duplicate id" } };
      }
      if (
        this.table === "bundle_patches" &&
        (!rows.bundles.has(String(payload.bundle_id)) ||
          !rows.bundles.has(String(payload.base_bundle_id)))
      ) {
        return { count: null, data: null, error: { message: "foreign key" } };
      }
      rows[this.table].set(id, payload);
      return { count: 1, data: payload, error: null };
    }
  }

  return {
    createMockClient: () => ({
      from: (table: TableName) => new QueryBuilder(table),
      rpc: async (name: string) => {
        const bundles = [...rows.bundles.values()];
        if (name === "get_target_app_version_list") {
          return {
            data: bundles.map((bundle) => ({
              target_app_version: bundle.target_app_version,
            })),
            error: null,
          };
        }
        if (name === "get_channels") {
          return {
            data: [...new Set(bundles.map((bundle) => String(bundle.channel)))]
              .sort()
              .map((channel) => ({ channel })),
            error: null,
          };
        }
        const bundle = bundles.toSorted((left, right) =>
          String(right.id).localeCompare(String(left.id)),
        )[0];
        return {
          data:
            bundle === undefined
              ? []
              : [
                  {
                    id: bundle.id,
                    should_force_update: bundle.should_force_update,
                    message: bundle.message,
                    status: "UPDATE",
                    storage_uri: bundle.storage_uri,
                    file_hash: bundle.file_hash,
                  },
                ],
          error: null,
        };
      },
    }),
    resetMockClient: () => {
      rows.bundle_events.clear();
      rows.bundle_patches.clear();
      rows.bundles.clear();
    },
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => createMockClient(),
}));

const bundleEvent = (id: string, receivedAtMs: number): BundleEventRow => ({
  id,
  type: "UNCHANGED",
  install_id: "install-1",
  user_id: null,
  username: null,
  from_bundle_id: null,
  to_bundle_id: "bundle-1",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "stable",
  update_strategy: null,
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

it("advertises Analytics support", () => {
  // Given / When
  const adapter = supabaseDatabase({
    supabaseUrl: "https://test.supabase.invalid",
    supabaseServiceRoleKey: "test-service-role-key",
  });

  // Then
  expect(adapter[databaseAnalyticsSupport]).toBe(true);
});

it("applies compound ordering to bundle event pages", async () => {
  resetMockClient();
  const adapter = supabaseDatabase({
    supabaseUrl: "https://test.supabase.invalid",
    supabaseServiceRoleKey: "test-service-role-key",
  });
  await Promise.all(
    [bundleEvent("b", 100), bundleEvent("c", 50), bundleEvent("a", 100)].map(
      (data) => adapter.create({ model: "bundle_events", data }),
    ),
  );

  const result = await adapter.findMany({
    model: "bundle_events",
    orderBy: [
      { field: "received_at_ms", direction: "asc" },
      { field: "id", direction: "asc" },
    ],
    limit: 10,
    offset: 0,
  });

  expect(result.map(({ id }) => id)).toEqual(["c", "a", "b"]);
});

setupDatabasePluginTestSuite({
  name: "supabase fixed-model database plugin",
  migrate: () => undefined,
  createPlugin: () =>
    supabaseDatabase({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseServiceRoleKey: "test-service-role-key",
    }),
  reset: () => resetMockClient(),
  dispose: () => undefined,
});
