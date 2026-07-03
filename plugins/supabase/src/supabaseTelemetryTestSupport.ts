import { vi } from "vitest";

import { createSupabaseTelemetryOperations } from "./supabaseTelemetry";

type TelemetryKeyRow = {
  active: boolean;
  created_at: string;
  id: string;
  key_hash: string;
  key_suffix: string;
  updated_at: string;
};

type AnalyticsEventRow = {
  event_type: string;
  id: string;
  observed_at: string;
  payload: Record<string, unknown>;
  received_at: string;
};

type TableName = "analytics_events" | "ingest_keys";

type QueryFilter = {
  readonly column: string;
  readonly value: unknown;
};

type QueryResult = {
  readonly data?: unknown;
  readonly error: { readonly code?: string; readonly message: string } | null;
};

const isAnalyticsEventRow = (value: unknown): value is AnalyticsEventRow =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "payload" in value &&
  typeof value.payload === "object";

const isTelemetryKeyRow = (value: unknown): value is TelemetryKeyRow =>
  typeof value === "object" &&
  value !== null &&
  "key_hash" in value &&
  typeof value.key_hash === "string";

const isTelemetryKeyPatch = (
  value: unknown,
): value is Partial<TelemetryKeyRow> =>
  typeof value === "object" && value !== null && !("event_type" in value);

const supabaseMock = vi.hoisted(() => {
  const tables = {
    telemetryKeys: new Map<string, TelemetryKeyRow>(),
    lifecycleEvents: new Map<string, never>(),
    lifecycleMetrics: new Map<string, never>(),
    analyticsEvents: new Map<string, AnalyticsEventRow>(),
  };

  const getRows = (table: TableName) => {
    switch (table) {
      case "ingest_keys":
        return Array.from(tables.telemetryKeys.values());
      case "analytics_events":
        return Array.from(tables.analyticsEvents.values());
    }
  };

  class QueryBuilder {
    private readonly filters: QueryFilter[] = [];
    private maybeSingleRow = false;

    constructor(
      private readonly table: TableName,
      private readonly mode: "select" | "insert" | "update" | "upsert",
      private readonly payload?:
        | AnalyticsEventRow
        | Partial<TelemetryKeyRow>
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
      if (this.mode === "update") return this.updateRow();
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
      if (this.table !== "analytics_events") {
        return { error: { message: `Unsupported insert: ${this.table}` } };
      }

      if (!isAnalyticsEventRow(this.payload)) {
        return { error: { message: "Invalid analytics event payload" } };
      }

      const row = this.payload;
      if (tables.analyticsEvents.has(row.id)) {
        return { error: { code: "23505", message: "duplicate event" } };
      }

      tables.analyticsEvents.set(row.id, row);
      return { error: null };
    }

    private async updateRow() {
      if (this.table !== "ingest_keys") {
        return { error: { message: `Unsupported update: ${this.table}` } };
      }

      if (!isTelemetryKeyPatch(this.payload)) {
        return { error: { message: "Invalid ingest_keys update payload" } };
      }

      for (const row of tables.telemetryKeys.values()) {
        const matches = this.filters.every((filter) => {
          const entry = Object.entries(row).find(
            ([column]) => column === filter.column,
          );
          return entry?.[1] === filter.value;
        });
        if (matches) {
          tables.telemetryKeys.set(row.id, {
            ...row,
            ...this.payload,
          });
        }
      }

      return { error: null };
    }

    private async upsertRow() {
      switch (this.table) {
        case "ingest_keys": {
          if (!isTelemetryKeyRow(this.payload)) {
            return { error: { message: "Invalid telemetry key payload" } };
          }
          const row = this.payload;
          tables.telemetryKeys.set(row.id, row);
          return { error: null };
        }
        case "analytics_events":
          return {
            error: { message: "Use insert for analytics_events" },
          };
      }
    }
  }

  const createClientMock = () => ({
    from(table: TableName) {
      return {
        insert(payload: AnalyticsEventRow) {
          return new QueryBuilder(table, "insert", payload);
        },
        select(_columns = "*") {
          return new QueryBuilder(table, "select");
        },
        update(payload: Partial<TelemetryKeyRow>) {
          return new QueryBuilder(table, "update", payload);
        },
        upsert(payload: TelemetryKeyRow) {
          return new QueryBuilder(table, "upsert", payload);
        },
      };
    },
  });

  return { createClientMock, tables };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseMock.createClientMock(),
}));

export const tables = supabaseMock.tables;

export const createSupabaseNotifyAppReadyResult = async (
  input: Parameters<
    typeof import("./supabaseTelemetry").createSupabaseNotifyAppReadyResult
  >[0],
) => {
  const { createSupabaseNotifyAppReadyResult } =
    await import("./supabaseTelemetry");
  return createSupabaseNotifyAppReadyResult(input);
};

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
