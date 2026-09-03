import { setupDatabasePluginTestSuite } from "@hot-updater/test-utils";
import { describe, expect, it, vi } from "vitest";

import { supabaseDatabase as supabaseEdgeDatabase } from "./edge";
import { supabaseDatabase } from "./supabaseDatabase";

// allow: SIZE_OK — hoisted PostgREST query/filter state machine for public plugin conformance.
const supabaseMock = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type TableName =
    | "bundle_events"
    | "bundle_patches"
    | "bundles"
    | "channels"
    | "api_keys"
    | "release_catalogs"
    | "releases";
  type QueryError = { readonly message: string };
  type QueryResult = {
    readonly count: number | null;
    readonly data: Row | readonly Row[] | null;
    readonly error: QueryError | null;
  };
  const physicalTableNames: Record<string, TableName> = {
    hot_updater_v1_api_keys: "api_keys",
    hot_updater_v1_bundle_events: "bundle_events",
    hot_updater_v1_bundle_patches: "bundle_patches",
    hot_updater_v1_bundles: "bundles",
    hot_updater_v1_channels: "channels",
    hot_updater_v1_release_catalogs: "release_catalogs",
    hot_updater_v1_releases: "releases",
  };

  const rows: Record<TableName, Map<string, Row>> = {
    bundle_events: new Map(),
    bundle_patches: new Map(),
    bundles: new Map(),
    channels: new Map(),
    api_keys: new Map(),
    release_catalogs: new Map(),
    releases: new Map(),
  };
  const tableReadCounts: Record<TableName, number> = {
    bundle_events: 0,
    bundle_patches: 0,
    bundles: 0,
    channels: 0,
    api_keys: 0,
    release_catalogs: 0,
    releases: 0,
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
    private mode: "delete" | "insert" | "select" | "update" | "upsert" =
      "select";
    private readonly orderClauses: {
      readonly field: string;
      readonly ascending: boolean;
      readonly nullsFirst: boolean | undefined;
    }[] = [];
    private payload: Row | undefined;
    private upsertOptions:
      | {
          readonly ignoreDuplicates?: boolean;
          readonly onConflict?: string;
        }
      | undefined;
    private rangeStart = 0;
    private rangeEnd: number | undefined;
    private singleRow = false;

    constructor(private readonly table: TableName) {}

    insert(payload: Row) {
      this.mode = "insert";
      this.payload = payload;
      return this;
    }
    upsert(
      payload: Row,
      options?: {
        readonly ignoreDuplicates?: boolean;
        readonly onConflict?: string;
      },
    ) {
      this.mode = "upsert";
      this.payload = payload;
      this.upsertOptions = options;
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
    eq(field: string, value: unknown) {
      const encoded =
        typeof value === "string"
          ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
          : String(value);
      this.filter = `${field}.eq.${encoded}`;
      return this;
    }
    order(
      field: string,
      options?: {
        readonly ascending?: boolean;
        readonly nullsFirst?: boolean;
      },
    ) {
      this.orderClauses.push({
        field,
        ascending: options?.ascending ?? true,
        nullsFirst: options?.nullsFirst,
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
            : [
                {
                  field: "id",
                  ascending: true,
                  nullsFirst: undefined,
                },
              ];
          for (const clause of clauses) {
            const leftValue = left[clause.field];
            const rightValue = right[clause.field];
            if (leftValue == null || rightValue == null) {
              if (leftValue == null && rightValue == null) continue;
              const nullsFirst = clause.nullsFirst ?? !clause.ascending;
              const order = leftValue == null ? -1 : 1;
              return nullsFirst ? order : -order;
            }
            const result = compare(leftValue, rightValue);
            if (result !== 0) return clause.ascending ? result : -result;
          }
          return 0;
        });
    }

    private async execute(): Promise<QueryResult> {
      if (this.mode === "insert" || this.mode === "upsert") {
        return this.executeInsert();
      }
      if (this.mode === "select") tableReadCounts[this.table] += 1;
      const selected = this.selectedRows();
      if (this.mode === "update") {
        for (const row of selected) Object.assign(row, this.payload);
      }
      if (this.mode === "delete") {
        for (const row of selected) {
          const id = String(
            this.table === "release_catalogs" ? row.scope_key : row.id,
          );
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
      const id = String(
        this.table === "release_catalogs" ? payload.scope_key : payload.id,
      );
      const conflictField = this.upsertOptions?.onConflict;
      const uniqueField =
        conflictField ??
        (this.table === "channels"
          ? "name"
          : this.table === "api_keys"
            ? "hash"
            : undefined);
      const conflictingEntry =
        uniqueField === undefined
          ? undefined
          : [...rows[this.table]].find(
              ([, row]) => row[uniqueField] === payload[uniqueField],
            );
      if (
        this.mode === "upsert" &&
        conflictingEntry !== undefined &&
        this.upsertOptions?.ignoreDuplicates
      ) {
        return { count: 0, data: null, error: null };
      }
      if (rows[this.table].has(id) || conflictingEntry !== undefined) {
        return {
          count: null,
          data: null,
          error: { message: "duplicate id" },
        };
      }
      if (
        this.table === "bundle_patches" &&
        (!rows.bundles.has(String(payload.bundle_id)) ||
          !rows.bundles.has(String(payload.base_bundle_id)))
      ) {
        return { count: null, data: null, error: { message: "foreign key" } };
      }
      if (
        this.table === "releases" &&
        (!rows.channels.has(String(payload.channel_id)) ||
          (payload.kind === "BUNDLE" &&
            !rows.bundles.has(String(payload.bundle_id))) ||
          (payload.source_release_id !== null &&
            !rows.releases.has(String(payload.source_release_id))))
      ) {
        return { count: null, data: null, error: { message: "foreign key" } };
      }
      if (
        this.table === "release_catalogs" &&
        !rows.channels.has(String(payload.channel_id))
      ) {
        return { count: null, data: null, error: { message: "foreign key" } };
      }
      rows[this.table].set(id, payload);
      return { count: 1, data: payload, error: null };
    }
  }

  return {
    createMockClient: () => ({
      from: (table: string) => {
        const logicalTable = physicalTableNames[table];
        if (!logicalTable)
          throw new Error(`Unexpected Supabase table: ${table}`);
        return new QueryBuilder(logicalTable);
      },
      rpc: async (name: string, args?: Record<string, unknown>) => {
        const bundles = [...rows.bundles.values()];
        if (name === "hot_updater_v1_delete_channel") {
          const id = String(args?.p_id);
          if (!rows.channels.has(id)) {
            return {
              data: { deleted: false, reason: "not_found" },
              error: null,
            };
          }
          if (
            [...rows.releases.values()].some(
              (release) => release.channel_id === id,
            ) ||
            [...rows.release_catalogs.values()].some(
              (catalog) => catalog.channel_id === id,
            )
          ) {
            return {
              data: { deleted: false, reason: "not_empty" },
              error: null,
            };
          }
          rows.channels.delete(id);
          return { data: { deleted: true }, error: null };
        }
        if (name === "hot_updater_v1_commit") {
          const staged = {
            bundle_events: new Map(rows.bundle_events),
            bundle_patches: new Map(rows.bundle_patches),
            bundles: new Map(rows.bundles),
            channels: new Map(rows.channels),
            api_keys: new Map(rows.api_keys),
            release_catalogs: new Map(rows.release_catalogs),
            releases: new Map(rows.releases),
          };
          const commit = (args?.p_commit ?? {}) as Row;
          const expectations = (commit.expectations ?? []) as readonly Row[];
          for (const expectation of expectations) {
            const model = String(expectation.model);
            const isRelease = model === "releases";
            const key = String(
              isRelease ? expectation.id : expectation.scopeKey,
            );
            const expectedVersion = isRelease
              ? expectation.revision
              : expectation.generation;
            const actualVersion = isRelease
              ? (staged.releases.get(key)?.revision ?? null)
              : (staged.release_catalogs.get(key)?.generation ?? null);
            if (actualVersion !== expectedVersion) {
              return {
                data: {
                  committed: false,
                  conflict: {
                    actualVersion,
                    changeIndex: -1,
                    expectedVersion,
                    key,
                    model,
                    reason: "version_conflict",
                  },
                },
                error: null,
              };
            }
          }
          const changes = (commit.changes ?? []) as readonly Row[];
          for (const [changeIndex, change] of changes.entries()) {
            const operation = String(change.operation);
            const model = String(change.model);
            if (model === "channels") {
              if (operation === "insert") {
                const channel = change.row as Row;
                const existing = [...staged.channels.values()].find(
                  (row) => row.name === channel.name,
                );
                if (existing === undefined) {
                  staged.channels.set(String(channel.id), channel);
                }
              } else if (operation === "delete") {
                const where = change.where as Row;
                const id = String(where.id);
                if (
                  [...staged.releases.values()].some(
                    (release) => release.channel_id === id,
                  ) ||
                  [...staged.release_catalogs.values()].some(
                    (catalog) => catalog.channel_id === id,
                  )
                ) {
                  return {
                    data: {
                      committed: false,
                      conflict: { changeIndex, reason: "referenced" },
                    },
                    error: null,
                  };
                }
                staged.channels.delete(id);
              }
              continue;
            }
            if (model === "bundles") {
              const where = change.where as Row | undefined;
              const bundle = change.row as Row | undefined;
              const id = String(where?.id ?? bundle?.id);
              if (operation === "insert" && bundle !== undefined) {
                if (staged.bundles.has(id)) {
                  return { data: null, error: { message: "constraint" } };
                }
                staged.bundles.set(id, bundle);
              } else if (operation === "update") {
                const current = staged.bundles.get(id);
                if (current === undefined) {
                  return {
                    data: {
                      committed: false,
                      conflict: { changeIndex, reason: "not_found" },
                    },
                    error: null,
                  };
                }
                const updated = { ...current, ...(change.update as Row) };
                staged.bundles.set(id, updated);
              } else if (operation === "delete") {
                if (
                  [...staged.releases.values()].some(
                    (release) => release.bundle_id === id,
                  )
                ) {
                  return {
                    data: {
                      committed: false,
                      conflict: { changeIndex, reason: "referenced" },
                    },
                    error: null,
                  };
                }
                if (!staged.bundles.delete(id)) {
                  return {
                    data: {
                      committed: false,
                      conflict: { changeIndex, reason: "not_found" },
                    },
                    error: null,
                  };
                }
                for (const [patchId, patch] of staged.bundle_patches) {
                  if (patch.bundle_id === id || patch.base_bundle_id === id) {
                    staged.bundle_patches.delete(patchId);
                  }
                }
              }
              continue;
            }
            if (model === "releases") {
              const where = change.where as Row | undefined;
              const release = change.row as Row | undefined;
              const id = String(where?.id ?? release?.id);
              if (operation === "insert" && release !== undefined) {
                if (
                  staged.releases.has(id) ||
                  !staged.channels.has(String(release.channel_id)) ||
                  (release.kind === "BUNDLE" &&
                    !staged.bundles.has(String(release.bundle_id))) ||
                  (release.source_release_id !== null &&
                    !staged.releases.has(String(release.source_release_id)))
                ) {
                  return { data: null, error: { message: "constraint" } };
                }
                staged.releases.set(id, release);
              } else if (operation === "update") {
                const current = staged.releases.get(id);
                if (current === undefined) {
                  return {
                    data: {
                      committed: false,
                      conflict: { changeIndex, reason: "not_found" },
                    },
                    error: null,
                  };
                }
                const updated = { ...current, ...(change.update as Row) };
                if (
                  !staged.channels.has(String(updated.channel_id)) ||
                  (updated.kind === "BUNDLE" &&
                    !staged.bundles.has(String(updated.bundle_id))) ||
                  (updated.source_release_id !== null &&
                    !staged.releases.has(String(updated.source_release_id)))
                ) {
                  return { data: null, error: { message: "constraint" } };
                }
                staged.releases.set(id, updated);
              } else if (!staged.releases.delete(id)) {
                return {
                  data: {
                    committed: false,
                    conflict: { changeIndex, reason: "not_found" },
                  },
                  error: null,
                };
              }
              continue;
            }
            if (model === "releaseCatalogs" && operation === "put") {
              const catalog = change.row as Row;
              if (!staged.channels.has(String(catalog.channel_id))) {
                return { data: null, error: { message: "constraint" } };
              }
              staged.release_catalogs.set(String(catalog.scope_key), catalog);
              continue;
            }
            if (model === "bundlePatches") {
              if (operation === "delete") {
                const where = change.where as Row;
                for (const [patchId, patch] of staged.bundle_patches) {
                  if (patch.bundle_id === where.bundleId) {
                    staged.bundle_patches.delete(patchId);
                  }
                }
                continue;
              }
              const patch = change.row as Row;
              if (
                !staged.bundles.has(String(patch.bundle_id)) ||
                !staged.bundles.has(String(patch.base_bundle_id))
              ) {
                return { data: null, error: { message: "foreign key" } };
              }
              staged.bundle_patches.set(String(patch.id), patch);
              continue;
            }
            if (model === "insights" && operation === "insert") {
              const event = change.row as Row;
              if (staged.bundle_events.has(String(event.id))) {
                return { data: null, error: { message: "duplicate id" } };
              }
              staged.bundle_events.set(String(event.id), event);
              continue;
            }
            if (model === "apiKeys") {
              const key = change.row as Row | undefined;
              if (operation === "insert" && key !== undefined) {
                const existing = [...staged.api_keys.values()].find(
                  (row) => row.hash === key.hash,
                );
                if (existing === undefined) {
                  staged.api_keys.set(String(key.id), key);
                }
              } else if (operation === "update") {
                const where = change.where as Row;
                const current = staged.api_keys.get(String(where.id));
                if (current === undefined) {
                  return {
                    data: {
                      committed: false,
                      conflict: { changeIndex, reason: "not_found" },
                    },
                    error: null,
                  };
                }
                const update = change.update as Row;
                current.revoked_at_ms = update.revokedAtMs;
              }
            }
          }
          rows.bundle_events = staged.bundle_events;
          rows.bundles = staged.bundles;
          rows.bundle_patches = staged.bundle_patches;
          rows.channels = staged.channels;
          rows.api_keys = staged.api_keys;
          rows.release_catalogs = staged.release_catalogs;
          rows.releases = staged.releases;
          return { data: { committed: true }, error: null };
        }
        if (name === "get_target_app_version_list") {
          return {
            data: bundles.map((bundle) => ({
              target_app_version: bundle.target_app_version,
            })),
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
    getTableReadCount: (table: TableName) => tableReadCounts[table],
    resetMockClient: () => {
      rows.bundle_events.clear();
      rows.bundle_patches.clear();
      rows.bundles.clear();
      rows.channels.clear();
      rows.api_keys.clear();
      rows.release_catalogs.clear();
      rows.releases.clear();
      for (const table of Object.keys(tableReadCounts) as TableName[]) {
        tableReadCounts[table] = 0;
      }
    },
  };
});
const { createMockClient, getTableReadCount, resetMockClient } = supabaseMock;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => createMockClient(),
}));

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

describe("supabase edge database", () => {
  it("exposes the same nested database contract as the root entrypoint", () => {
    const database = supabaseEdgeDatabase({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseServiceRoleKey: "test-service-role-key",
    });

    expect(Object.keys(database).sort()).toEqual(["commit", "models", "name"]);
    expect(Object.keys(database.models).sort()).toEqual([
      "apiKeys",
      "bundlePatches",
      "bundles",
      "channels",
      "insights",
      "releaseCatalogs",
      "releases",
    ]);
  });
});

describe("supabase Channel model", () => {
  it("lists the normalized channels table without reading bundles", async () => {
    resetMockClient();
    const database = supabaseDatabase({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseServiceRoleKey: "test-service-role-key",
    });
    const channel = {
      id: "00000000-0000-0000-0000-000000000001",
      name: "production",
    };
    await database.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });

    await expect(database.models.channels.list({})).resolves.toEqual({
      channels: [channel],
    });
    expect(getTableReadCount("channels")).toBe(1);
    expect(getTableReadCount("bundles")).toBe(0);
  });

  it("deletes only an empty channel and reports missing channels", async () => {
    resetMockClient();
    const database = supabaseDatabase({
      supabaseUrl: "https://test.supabase.invalid",
      supabaseServiceRoleKey: "test-service-role-key",
    });
    const channel = {
      id: "00000000-0000-0000-0000-000000000002",
      name: "empty",
    };
    await database.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });

    await expect(
      database.models.channels.delete({ id: channel.id }),
    ).resolves.toEqual({ deleted: true });
    await expect(
      database.models.channels.delete({ id: channel.id }),
    ).resolves.toEqual({ deleted: false, reason: "not_found" });
  });

  it.each(["id", "name"] as const)(
    "rejects an overlong Channel %s before calling Supabase",
    async (field) => {
      resetMockClient();
      const database = supabaseDatabase({
        supabaseUrl: "https://test.supabase.invalid",
        supabaseServiceRoleKey: "test-service-role-key",
      });
      const row = {
        id: "valid-channel-id",
        name: "valid-channel-name",
        [field]: "😀".repeat(256),
      };

      await expect(
        database.models.channels.insert({
          row,
          onConflict: "returnExisting",
        }),
      ).rejects.toMatchObject({ code: "invalid-data" });
      expect(getTableReadCount("channels")).toBe(0);
    },
  );
});
