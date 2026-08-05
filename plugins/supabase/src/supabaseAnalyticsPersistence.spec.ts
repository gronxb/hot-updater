import type { BundleEventPersistenceRow } from "@hot-updater/analytics/provider";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMockClient, marker, rows, schema } = vi.hoisted(() => {
  const rows: unknown[] = [];
  const marker: { value: string | null } = { value: "2" };
  const schema = { bundleEventsAvailable: true };
  type QueryError = {
    readonly code: string;
    readonly details: string;
    readonly hint: string;
    readonly message: string;
  };
  type QueryResult = {
    readonly data: unknown;
    readonly error: QueryError | null;
  };

  const compare = (left: unknown, right: unknown): number => {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    if (typeof left === "string" && typeof right === "string") {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    return 0;
  };

  class Query {
    private readonly filters: readonly {
      readonly field: string;
      readonly operator: "eq" | "gt" | "lt";
      readonly value: string | number;
    }[];
    private readonly orders: readonly {
      readonly ascending: boolean;
      readonly field: string;
    }[];
    private readonly rowLimit: number | undefined;
    private readonly inserted: unknown;
    private readonly single: boolean;
    private readonly table: string;

    constructor(
      table: string,
      options?: {
        readonly filters?: Query["filters"];
        readonly inserted?: unknown;
        readonly orders?: Query["orders"];
        readonly rowLimit?: number;
        readonly single?: boolean;
      },
    ) {
      this.filters = options?.filters ?? [];
      this.inserted = options?.inserted;
      this.orders = options?.orders ?? [];
      this.rowLimit = options?.rowLimit;
      this.single = options?.single ?? false;
      this.table = table;
    }

    insert(inserted: unknown) {
      return new Query(this.table, { inserted });
    }

    select() {
      return this;
    }

    eq(field: string, value: string | number) {
      return this.filter(field, "eq", value);
    }

    gt(field: string, value: string | number) {
      return this.filter(field, "gt", value);
    }

    lt(field: string, value: string | number) {
      return this.filter(field, "lt", value);
    }

    order(field: string, options: { readonly ascending: boolean }) {
      return new Query(this.table, {
        filters: this.filters,
        orders: [...this.orders, { field, ascending: options.ascending }],
        ...(this.rowLimit === undefined ? {} : { rowLimit: this.rowLimit }),
      });
    }

    limit(rowLimit: number) {
      return new Query(this.table, {
        filters: this.filters,
        orders: this.orders,
        rowLimit,
      });
    }

    maybeSingle() {
      return new Query(this.table, {
        filters: this.filters,
        orders: this.orders,
        ...(this.rowLimit === undefined ? {} : { rowLimit: this.rowLimit }),
        single: true,
      });
    }

    then<TResult1 = QueryResult, TResult2 = never>(
      resolve?:
        | ((result: QueryResult) => PromiseLike<TResult1> | TResult1)
        | null,
      reject?: ((reason: unknown) => PromiseLike<TResult2> | TResult2) | null,
    ) {
      if (this.table === "private_hot_updater_settings") {
        const data = marker.value === null ? null : { value: marker.value };
        return Promise.resolve<QueryResult>({ data, error: null }).then(
          resolve,
          reject,
        );
      }
      if (!schema.bundleEventsAvailable) {
        return Promise.resolve<QueryResult>({
          data: null,
          error: {
            code: "42P01",
            details: "",
            hint: "",
            message: "bundle_events is unavailable",
          },
        }).then(resolve, reject);
      }
      if (this.inserted !== undefined) {
        rows.push(this.inserted);
        return Promise.resolve<QueryResult>({ data: null, error: null }).then(
          resolve,
          reject,
        );
      }
      const filtered = rows.filter((row) =>
        this.filters.every(({ field, operator, value }) => {
          const candidate = Reflect.get(Object(row), field);
          switch (operator) {
            case "eq":
              return candidate === value;
            case "gt":
              return compare(candidate, value) > 0;
            case "lt":
              return compare(candidate, value) < 0;
          }
        }),
      );
      filtered.sort((left, right) => {
        for (const { ascending, field } of this.orders) {
          const leftValue = Reflect.get(Object(left), field);
          const rightValue = Reflect.get(Object(right), field);
          if (leftValue === rightValue) continue;
          const comparison = compare(leftValue, rightValue);
          return ascending ? comparison : -comparison;
        }
        return 0;
      });
      const selected = filtered.slice(0, this.rowLimit);
      return Promise.resolve<QueryResult>({
        data: this.single ? (selected[0] ?? null) : selected,
        error: null,
      }).then(resolve, reject);
    }

    private filter(
      field: string,
      operator: "eq" | "gt" | "lt",
      value: string | number,
    ) {
      return new Query(this.table, {
        filters: [...this.filters, { field, operator, value }],
        orders: this.orders,
        ...(this.rowLimit === undefined ? {} : { rowLimit: this.rowLimit }),
      });
    }
  }

  return {
    createMockClient: vi.fn(() => ({
      from: vi.fn((table: string) => new Query(table)),
    })),
    marker,
    rows,
    schema,
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: createMockClient }));

import { createSupabaseAnalyticsPersistence } from "./supabaseAnalyticsPersistence";
import { supabaseDatabase } from "./supabaseDatabase";
import type { Database } from "./types";

const readinessRevocations: readonly {
  readonly marker: string | null;
  readonly state: string;
}[] = [
  { marker: "3", state: "future" },
  { marker: null, state: "missing" },
];

const event = (
  id: string,
  receivedAtMs: number,
): BundleEventPersistenceRow => ({
  id,
  type: "UPDATE_APPLIED",
  install_id: `install-${id}`,
  user_id: null,
  username: null,
  from_bundle_id: "00000000-0000-0000-0000-000000000010",
  to_bundle_id: "00000000-0000-0000-0000-000000000020",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

beforeEach(() => {
  rows.length = 0;
  marker.value = "2";
  schema.bundleEventsAvailable = true;
  createMockClient.mockClear();
});

describe("Supabase Analytics persistence", () => {
  it("advertises the explicit Analytics provider capability", () => {
    const database = supabaseDatabase({
      supabaseServiceRoleKey: "service-role-key",
      supabaseUrl: "https://example.test",
    });

    expect(
      getCapabilityContributions(database).map(({ token }) => token.id),
    ).toContain("hot-updater.analytics.provider@1");
  });

  it("rejects writes until the Analytics component marker is ready", async () => {
    marker.value = "3";
    const client = createClient<Database>("https://example.test", "key");
    const persistence = createSupabaseAnalyticsPersistence(client);

    await expect(
      persistence.append(event("00000000-0000-0000-0000-000000000100", 10)),
    ).rejects.toMatchObject({
      inspection: { componentVersion: "3" },
      name: "AnalyticsSchemaNotReadyError",
    });
    expect(rows).toEqual([]);

    marker.value = "2";
    await persistence.append(event("00000000-0000-0000-0000-000000000100", 10));
    expect(rows).toHaveLength(1);
  });

  it.each(readinessRevocations)(
    "revokes a warm persistence instance when the marker becomes $state",
    async ({ marker: nextMarker }) => {
      const client = createClient<Database>("https://example.test", "key");
      const persistence = createSupabaseAnalyticsPersistence(client);
      await persistence.append(
        event("00000000-0000-0000-0000-000000000100", 10),
      );

      marker.value = nextMarker;

      await expect(
        persistence.append(event("00000000-0000-0000-0000-000000000101", 20)),
      ).rejects.toMatchObject({
        inspection: { componentVersion: nextMarker },
        name: "AnalyticsSchemaNotReadyError",
      });
      expect(rows).toHaveLength(1);
    },
  );

  it("fails closed when the physical schema drifts after a successful write", async () => {
    const client = createClient<Database>("https://example.test", "key");
    const persistence = createSupabaseAnalyticsPersistence(client);
    await persistence.append(event("00000000-0000-0000-0000-000000000100", 10));

    schema.bundleEventsAvailable = false;

    await expect(
      persistence.append(event("00000000-0000-0000-0000-000000000101", 20)),
    ).rejects.toMatchObject({
      name: "SupabaseDatabaseError",
      operation: "append bundle event",
    });
    expect(rows).toHaveLength(1);
  });

  it("merges the equal-timestamp cursor branch into global row order", async () => {
    const client = createClient<Database>("https://example.test", "key");
    const persistence = createSupabaseAnalyticsPersistence(client);
    const firstId = "00000000-0000-0000-0000-000000000101";
    const secondId = "00000000-0000-0000-0000-000000000102";
    const thirdId = "00000000-0000-0000-0000-000000000103";
    await persistence.append(event(thirdId, 20));
    await persistence.append(event(secondId, 10));
    await persistence.append(event(firstId, 10));
    await persistence.append(event("00000000-0000-0000-0000-000000000104", 30));

    const result = await persistence.scan({
      after: { id: firstId, receivedAtMs: 10 },
      beforeReceivedAtMs: 30,
      limit: 2,
    });

    expect(result.map(({ id }) => id)).toEqual([secondId, thirdId]);
  });
});
