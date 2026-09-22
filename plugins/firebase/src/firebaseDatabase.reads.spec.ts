import { beforeEach, describe, expect, it, vi } from "vitest";

const { reads, collection } = vi.hoisted(() => {
  const reads: {
    name: string;
    where: unknown[];
    limit?: number;
    offset?: number;
    count?: boolean;
  }[] = [];
  const collection = (name: string) => {
    const query = (
      where: unknown[] = [],
      limit?: number,
      offset?: number,
    ): any => ({
      where: (...args: unknown[]) => query([...where, args], limit, offset),
      orderBy: () => query(where, limit, offset),
      limit: (value: number) => query(where, value, offset),
      offset: (value: number) => query(where, limit, value),
      get: async () => {
        if (where.length === 0 && limit === undefined)
          throw new Error(`unbounded collection read: ${name}`);
        reads.push({ name, where, limit, offset });
        return { docs: [], empty: true };
      },
      count: () => ({
        get: async () => {
          reads.push({ name, where, count: true });
          return { data: () => ({ count: 7 }) };
        },
      }),
      doc: (id: string) => ({
        get: async () => ({
          id,
          exists: name.endsWith("private_settings"),
          data: () => ({ version: 4 }),
        }),
      }),
    });
    return query();
  };
  return { reads, collection };
});

vi.mock("firebase-admin/app", () => ({
  getApps: () => [{}],
  getApp: () => ({}),
}));
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection,
    runTransaction: async (
      callback: (transaction: unknown) => Promise<unknown>,
    ) =>
      callback({
        get: (target: { get(): unknown }) => target.get(),
        set: vi.fn(),
        delete: vi.fn(),
      }),
  }),
  Filter: {
    where: (...args: unknown[]) => args,
    and: (...args: unknown[]) => args,
    or: (...args: unknown[]) => args,
  },
}));

import { firebaseDatabase } from "./firebaseDatabase";
import { FIREBASE_V1_COLLECTION_NAMES as names } from "./firebaseInfrastructureNames";

describe("Firebase bounded model reads", () => {
  beforeEach(() => {
    reads.length = 0;
  });

  it("does not load unrelated collections when updating a missing bundle", async () => {
    await expect(
      firebaseDatabase({}).commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id: "missing" },
            update: { manifest_file_hash: "new-hash" },
          },
        ],
      }),
    ).resolves.toMatchObject({
      committed: false,
      conflict: { reason: "not_found" },
    });
    expect(
      reads.every(
        ({ where, limit, count }) =>
          where.length > 0 || limit !== undefined || count,
      ),
    ).toBe(true);
  });

  it("returns a missing catalog without loading any metadata collection", async () => {
    await expect(
      firebaseDatabase({}).models.releaseCatalogs.findByScopeKey(
        "missing-scope",
      ),
    ).resolves.toBeNull();
    expect(reads).toHaveLength(0);
  });

  it("looks up an unknown API key hash with a filtered single-row query", async () => {
    await expect(
      firebaseDatabase({}).models.apiKeys.findByHash("missing-hash"),
    ).resolves.toBeNull();
    expect(reads).toEqual([
      {
        name: names.apiKeys,
        where: [["hash", "==", "missing-hash"]],
        limit: 1,
        offset: 0,
      },
    ]);
  });

  it("applies bundle filters and pagination before reading rows", async () => {
    await expect(
      firebaseDatabase({}).models.bundles.findMany({
        where: { platform: "ios", id: { gt: "cursor" } },
        orderBy: { field: "id", direction: "asc" },
        limit: 2,
        offset: 0,
      }),
    ).resolves.toEqual([]);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      name: names.bundles,
      limit: 2,
      offset: 0,
    });
    expect(reads[0].where).toEqual(
      expect.arrayContaining([
        ["platform", "==", "ios"],
        ["id", ">", "cursor"],
      ]),
    );
  });

  it("counts matching bundles in Firestore without fetching their documents", async () => {
    await expect(
      firebaseDatabase({}).models.bundles.count({ platform: "ios" }),
    ).resolves.toBe(7);
    expect(reads).toEqual([
      { name: names.bundles, where: [["platform", "==", "ios"]], count: true },
    ]);
  });

  it("hydrates patches only for the requested owner", async () => {
    await expect(
      firebaseDatabase({}).models.bundlePatches.findByBundleIds(["owner"]),
    ).resolves.toEqual([]);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      name: names.bundlePatches,
      where: [["bundle_id", "in", ["owner"]]],
      limit: 100,
    });
  });
});
