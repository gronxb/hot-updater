import type { BundleRow } from "@hot-updater/plugin-core";
import type { Transaction } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import { createDatabasePluginCrud } from "../../plugin-core/src/databasePluginCrud";
import {
  firebaseChannelDocumentId,
  firebaseChannelIdDocumentId,
  type FirebaseDatabaseCollections,
} from "./firebaseDatabasePersistence";
import { createFirebaseReads } from "./firebaseDatabaseReads";

type Row = Record<string, unknown>;
type Document = { id: string; data(): Row; get(field: string): unknown };
type QueryState = {
  where: [string, string, unknown][];
  order: [string, "asc" | "desc"][];
  limit?: number;
  offset?: number;
  cursor?: Document;
  select?: string[];
};

// Measure returned documents AND skipped documents, which Firestore bills too.
const fixture = (stored: Row[]) => {
  const calls: (QueryState & { returned: number })[] = [];
  const gets: { id: string; fieldMask?: string[] }[] = [];
  const document = (row: Row, fields?: string[]): Document => ({
    id: String(row.id),
    data: () =>
      fields
        ? Object.fromEntries(
            fields
              .filter((field) => field in row)
              .map((field) => [field, row[field]]),
          )
        : row,
    get: (field) => row[field],
  });
  const query = (state: QueryState): unknown => ({
    where: (field: string, op: string, value: unknown) =>
      query({ ...state, where: [...state.where, [field, op, value]] }),
    orderBy: (field: string, direction: "asc" | "desc") =>
      query({ ...state, order: [...state.order, [field, direction]] }),
    limit: (limit: number) => query({ ...state, limit }),
    offset: (offset: number) => query({ ...state, offset }),
    startAfter: (cursor: Document) => query({ ...state, cursor }),
    select: (...select: string[]) => query({ ...state, select }),
    get: async () => {
      if (state.limit === undefined) throw new Error("unbounded query");
      const order = state.order.length ? state.order : [["id", "asc"] as const];
      const rows = stored
        .filter((row) =>
          state.where.every(([field, op, value]) => {
            if (op === "in") return (value as unknown[]).includes(row[field]);
            if (op === "==") return row[field] === value;
            throw new Error(`unsupported test predicate: ${op}`);
          }),
        )
        .sort((a, b) => {
          for (const [field, direction] of order) {
            const x = a[field] as string | number;
            const y = b[field] as string | number;
            const result = x === y ? 0 : x < y ? -1 : 1;
            if (result) return direction === "asc" ? result : -result;
          }
          const result = Buffer.compare(
            Buffer.from(String(a.id)),
            Buffer.from(String(b.id)),
          );
          return order.at(-1)?.[1] === "desc" ? -result : result;
        });
      const start = state.cursor
        ? rows.findIndex(({ id }) => id === state.cursor!.id) + 1
        : 0;
      const docs = rows
        .slice(
          start + (state.offset ?? 0),
          start + (state.offset ?? 0) + state.limit,
        )
        .map((row) => document(row, state.select));
      calls.push({ ...state, returned: docs.length });
      return { docs, empty: docs.length === 0 };
    },
    doc: (id: string) => ({
      id,
      firestore: {
        getAll: async (_ref: unknown, options: { fieldMask: string[] }) => {
          gets.push({ id, ...options });
          const row = stored.find((row) => row.id === id);
          return [
            { exists: !!row, ...document(row ?? { id }, options.fieldMask) },
          ];
        },
      },
      get: async () => {
        gets.push({ id });
        const row = stored.find((row) => row.id === id);
        return { exists: !!row, ...document(row ?? { id }) };
      },
    }),
  });
  const collection = query({ where: [], order: [] });
  const collections = {
    bundles: collection,
    bundlePatches: collection,
  } as FirebaseDatabaseCollections;
  const reads = createFirebaseReads(collections, async () => {});
  const unexpectedMutation = async (): Promise<never> => {
    throw new Error("Unexpected mutation in read test");
  };
  return {
    calls,
    gets,
    reads,
    validated: createDatabasePluginCrud({
      ...reads,
      create: unexpectedMutation,
      update: unexpectedMutation,
      delete: unexpectedMutation,
    }),
    billed: () =>
      calls.reduce(
        (total, call) => total + call.returned + (call.offset ?? 0),
        0,
      ),
  };
};

const bundle = (i: number): BundleRow & Row => ({
  id: String(i).padStart(5, "0"),
  platform: "ios",
  git_commit_hash: null,
  metadata: { large: "x".repeat(1000) },
  manifest_storage_uri: "storage://bundle/manifest.json",
  manifest_file_hash: "hash",
  asset_base_storage_uri: "storage://assets",
});

describe("Firebase physical read costs", () => {
  it("pays the offset once, then traverses large results with snapshot cursors", async () => {
    const rows = Array.from({ length: 2100 }, (_, i) => bundle(i));
    const { reads, billed, calls } = fixture(rows);
    await expect(
      reads.findMany({
        model: "bundles",
        limit: 2001,
        offset: 7,
        orderBy: [{ field: "id", direction: "asc" }],
      }),
    ).resolves.toEqual(rows.slice(7, 2008));
    expect(billed()).toBe(2008);
    expect(
      calls.slice(1).every(({ cursor, offset }) => cursor && !offset),
    ).toBe(true);
  });

  it.each(["asc", "desc"] as const)(
    "merges owner shards with bounded lookahead and stable %s ties",
    async (direction) => {
      const rows = Array.from({ length: 3600 }, (_, i) => ({
        id: String(i).padStart(5, "0"),
        bundle_id: `owner-${i % 90}`,
        base_bundle_id: "base",
        base_file_hash: "base-hash",
        patch_file_hash: "patch-hash",
        patch_storage_uri: "storage://patch",
        byte_size: 1,
        order_index: 0,
      }));
      const { reads, billed } = fixture(rows);
      const ids = Array.from({ length: 90 }, (_, i) => `owner-${i}`).reverse();
      const expected = direction === "asc" ? rows : [...rows].reverse();
      const result = await reads.findMany({
        model: "bundle_patches",
        where: [
          { field: "bundle_id", operator: "in", value: [...ids, ...ids] },
        ],
        orderBy: [{ field: "order_index", direction }],
        offset: 31,
        limit: 3,
      });
      expect(result).toEqual(expected.slice(31, 34));
      // Three shard heads plus one advancement per consumed row, except the last.
      expect(billed()).toBeLessThanOrEqual(36);
    },
  );

  it("projects a list to requested fields and the cursor key", async () => {
    const { reads, calls } = fixture([bundle(1)]);
    const result = await reads.findMany({
      model: "bundles",
      limit: 1,
      offset: 0,
      select: ["id"],
      orderBy: [{ field: "id", direction: "asc" }],
    });
    expect(result).toEqual([{ id: bundle(1).id }]);
    expect(calls[0].select).toEqual(["id"]);
  });

  it("projects a keyed read without downloading bundle metadata", async () => {
    const { reads, gets } = fixture([bundle(1)]);
    await expect(
      reads.findOne({
        model: "bundles",
        where: [{ field: "id", value: bundle(1).id }],
        select: ["platform"],
      }),
    ).resolves.toEqual({ id: bundle(1).id, platform: "ios" });
    expect(gets).toEqual([{ id: bundle(1).id, fieldMask: ["platform", "id"] }]);
  });

  it("preserves absent nullable-field normalization through selected-read validation", async () => {
    const { git_commit_hash: _hash, ...stored } = bundle(1);
    const { validated, gets, calls } = fixture([stored]);
    const key = {
      model: "bundles" as const,
      where: [{ field: "id" as const, value: stored.id }],
    };
    await expect(validated.findOne(key)).resolves.toMatchObject({
      git_commit_hash: null,
    });
    await expect(
      validated.findOne({ ...key, select: ["git_commit_hash"] }),
    ).resolves.toEqual({ git_commit_hash: null });
    await expect(
      validated.findMany({ ...key, limit: 1, select: ["git_commit_hash"] }),
    ).resolves.toEqual([{ git_commit_hash: null }]);
    expect(gets.at(-1)?.fieldMask).toEqual(["git_commit_hash", "id"]);
    expect(calls[0].select).toEqual(["git_commit_hash", "id"]);
  });

  it("still rejects missing required fields in selected reads", async () => {
    const { platform: _platform, ...stored } = bundle(1);
    const { validated } = fixture([stored]);
    await expect(
      validated.findOne({
        model: "bundles",
        where: [{ field: "id", value: stored.id }],
        select: ["platform"],
      }),
    ).rejects.toMatchObject({ code: "invalid-result" });
  });

  it("reads a channel ID registry key even when absent, providing a transaction lock", async () => {
    const accessed: string[] = [];
    const collections = {
      settings: { doc: (id: string) => ({ id }) },
      channels: {
        where: () => {
          throw new Error(
            "channel ID query does not lock an absent registry key",
          );
        },
      },
    } as unknown as FirebaseDatabaseCollections;
    const transaction = {
      get: async ({ id }: { id: string }) => {
        accessed.push(id);
        return { exists: false };
      },
    } as unknown as Transaction;
    const reads = createFirebaseReads(collections, async () => {}, transaction);
    await expect(
      reads.findOne({
        model: "channels",
        where: [{ field: "id", value: "new" }],
      }),
    ).resolves.toBeNull();
    expect(accessed).toEqual([firebaseChannelIdDocumentId("new")]);
  });

  it("checks the canonical channel after resolving its ID registry", async () => {
    const channel = { id: "channel", name: "production" };
    const accessed: string[] = [];
    const collections = {
      settings: { doc: (id: string) => ({ id }) },
      channels: {
        doc: (id: string) => ({ id }),
        where: () => {
          throw new Error("unexpected query");
        },
      },
    } as unknown as FirebaseDatabaseCollections;
    const transaction = {
      get: async ({ id }: { id: string }) => {
        accessed.push(id);
        return { id, exists: true, data: () => channel };
      },
    } as unknown as Transaction;
    const reads = createFirebaseReads(collections, async () => {}, transaction);
    await expect(
      reads.findOne({
        model: "channels",
        where: [{ field: "id", value: channel.id }],
      }),
    ).resolves.toEqual(channel);
    expect(accessed).toEqual([
      firebaseChannelIdDocumentId(channel.id),
      firebaseChannelDocumentId(channel.name),
    ]);
  });
});
