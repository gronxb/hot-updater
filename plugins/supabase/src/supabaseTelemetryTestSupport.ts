import { vi } from "vitest";

import { createSupabaseTelemetryOperations } from "./supabaseTelemetry";

type TelemetryKeyRow = {
  id: string;
  key_hash: string;
  key_suffix: string;
  updated_at: string;
};

type LifecycleEventRow = {
  bundle_id: string;
  channel: string;
  crashed_bundle_id: string | null;
  event_id: string;
  install_id: string;
  observed_at: string;
  platform: "ios" | "android";
  received_at: string;
  status: "ACTIVE" | "RECOVERED";
};

type LifecycleMetricRow = {
  active_count: number;
  bucket_start: string;
  bundle_id: string;
  channel: string;
  last_seen_at: string;
  platform: "ios" | "android";
  recovered_count: number;
};

type IncrementLifecycleMetricArgs = {
  readonly p_active_delta: number;
  readonly p_bucket_start: string;
  readonly p_bundle_id: string;
  readonly p_channel: string;
  readonly p_observed_at: string;
  readonly p_platform: "ios" | "android";
  readonly p_recovered_delta: number;
};

type TableName =
  | "bundle_lifecycle_events"
  | "bundle_lifecycle_metrics"
  | "telemetry_keys";

type QueryFilter = {
  readonly column: string;
  readonly value: unknown;
};

type QueryResult = {
  readonly data?: unknown;
  readonly error: { readonly code?: string; readonly message: string } | null;
};

const isLifecycleEventRow = (value: unknown): value is LifecycleEventRow =>
  typeof value === "object" &&
  value !== null &&
  "event_id" in value &&
  typeof value.event_id === "string";

const isTelemetryKeyRow = (value: unknown): value is TelemetryKeyRow =>
  typeof value === "object" &&
  value !== null &&
  "key_hash" in value &&
  typeof value.key_hash === "string";

const supabaseMock = vi.hoisted(() => {
  const tables = {
    telemetryKeys: new Map<string, TelemetryKeyRow>(),
    lifecycleEvents: new Map<string, LifecycleEventRow>(),
    lifecycleMetrics: new Map<string, LifecycleMetricRow>(),
  };

  const getRows = (table: TableName) => {
    switch (table) {
      case "telemetry_keys":
        return Array.from(tables.telemetryKeys.values());
      case "bundle_lifecycle_events":
        return Array.from(tables.lifecycleEvents.values());
      case "bundle_lifecycle_metrics":
        return Array.from(tables.lifecycleMetrics.values());
    }
  };

  const incrementMetric = (params: IncrementLifecycleMetricArgs) => {
    const metricKey = `${params.p_bundle_id}:${params.p_bucket_start}`;
    const current = tables.lifecycleMetrics.get(metricKey);
    tables.lifecycleMetrics.set(metricKey, {
      active_count: (current?.active_count ?? 0) + params.p_active_delta,
      bucket_start: params.p_bucket_start,
      bundle_id: params.p_bundle_id,
      channel: params.p_channel,
      last_seen_at:
        current?.last_seen_at && current.last_seen_at > params.p_observed_at
          ? current.last_seen_at
          : params.p_observed_at,
      platform: params.p_platform,
      recovered_count:
        (current?.recovered_count ?? 0) + params.p_recovered_delta,
    });
  };

  class QueryBuilder {
    private readonly filters: QueryFilter[] = [];
    private maybeSingleRow = false;

    constructor(
      private readonly table: TableName,
      private readonly mode: "select" | "insert" | "upsert",
      private readonly payload?:
        | LifecycleEventRow
        | LifecycleMetricRow
        | TelemetryKeyRow,
    ) {}

    eq(column: string, value: unknown) {
      this.filters.push({ column, value });
      return this;
    }

    order(_column: string, _options?: { readonly ascending?: boolean }) {
      return this;
    }

    maybeSingle() {
      this.maybeSingleRow = true;
      return this;
    }

    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?:
        | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ) {
      return this.execute().then(onfulfilled, onrejected);
    }

    private async execute(): Promise<QueryResult> {
      if (this.mode === "insert") return this.insertRow();
      if (this.mode === "upsert") return this.upsertRow();

      const rows = getRows(this.table).filter((row) =>
        this.filters.every((filter) => {
          const entry = Object.entries(row).find(
            ([column]) => column === filter.column,
          );
          return entry?.[1] === filter.value;
        }),
      );

      if (this.maybeSingleRow) return { data: rows[0] ?? null, error: null };

      return { data: rows, error: null };
    }

    private async insertRow() {
      if (this.table !== "bundle_lifecycle_events") {
        return { error: { message: `Unsupported insert: ${this.table}` } };
      }

      if (!isLifecycleEventRow(this.payload)) {
        return { error: { message: "Invalid lifecycle event payload" } };
      }

      const row = this.payload;
      if (tables.lifecycleEvents.has(row.event_id)) {
        return { error: { code: "23505", message: "duplicate event" } };
      }

      tables.lifecycleEvents.set(row.event_id, row);
      return { error: null };
    }

    private async upsertRow() {
      switch (this.table) {
        case "telemetry_keys": {
          if (!isTelemetryKeyRow(this.payload)) {
            return { error: { message: "Invalid telemetry key payload" } };
          }
          const row = this.payload;
          tables.telemetryKeys.set(row.id, row);
          return { error: null };
        }
        case "bundle_lifecycle_metrics":
          return { error: { message: "Use rpc for bundle_lifecycle_metrics" } };
        case "bundle_lifecycle_events":
          return {
            error: { message: "Use insert for bundle_lifecycle_events" },
          };
      }
    }
  }

  const createClientMock = () => ({
    from(table: TableName) {
      return {
        insert(payload: LifecycleEventRow) {
          return new QueryBuilder(table, "insert", payload);
        },
        select(_columns = "*") {
          return new QueryBuilder(table, "select");
        },
        upsert(payload: LifecycleMetricRow | TelemetryKeyRow) {
          return new QueryBuilder(table, "upsert", payload);
        },
      };
    },
    async rpc(
      name: "increment_bundle_lifecycle_metric",
      params: IncrementLifecycleMetricArgs,
    ) {
      if (name !== "increment_bundle_lifecycle_metric") {
        return { error: { message: `Unsupported rpc: ${name}` } };
      }

      incrementMetric(params);
      return { error: null };
    },
  });

  return { createClientMock, tables };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseMock.createClientMock(),
}));

export const tables = supabaseMock.tables;

export const createOperations = () =>
  createSupabaseTelemetryOperations({
    supabaseAnonKey: "test-anon-key",
    supabaseUrl: "https://test.supabase.invalid",
  });

export const notifyPayload = {
  bundleId: "018f0000-0000-7000-8000-000000000001",
  channel: "production",
  eventId: "event-active",
  installId: "install-active",
  platform: "ios",
  status: "ACTIVE",
} as const;

export const recoveredPayload = {
  bundleId: "018f0000-0000-7000-8000-000000000002",
  channel: "production",
  crashedBundleId: "018f0000-0000-7000-8000-000000000001",
  eventId: "event-recovered",
  installId: "install-recovered",
  platform: "ios",
  status: "RECOVERED",
} as const;

export const createNotifyRequest = (
  telemetryKey: string | null,
  payload: Readonly<Record<string, unknown>> = notifyPayload,
  init?: RequestInit,
): Request => {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (telemetryKey !== null) {
    headers.set("x-hot-updater-telemetry-key", telemetryKey);
  }

  return new Request("https://runtime.example.com/api/notify-app-ready", {
    ...init,
    body: JSON.stringify(payload),
    headers,
    method: "POST",
  });
};
