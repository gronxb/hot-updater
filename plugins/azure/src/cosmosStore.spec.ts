import type { CosmosClient } from "@azure/cosmos";
import type { KvKey, StoredRow } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  COSMOS_LIMITS,
  cosmosItemId,
  createCosmosStore,
  toItem,
} from "./cosmosStore";

/** Cosmos DB's cap on an item and on a transactional batch request. */
const COSMOS_MAX_BYTES = 2 * 1024 * 1024;

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** The bytes plugin-core's KV kit measures for a put. */
const measured = (pk: string, sk: string, row: StoredRow) =>
  new TextEncoder().encode(pk + sk + JSON.stringify(row)).length;

/** A row whose map value holds only characters JSON escapes, padded to `size` measured bytes. */
const worstRow = (pk: string, sk: string, size: number, char: string) => {
  const empty = measured(pk, sk, { _v: 1, value: { text: "" } });
  const escaped = JSON.stringify(char).length - 2;
  return {
    _v: 1,
    value: { text: char.repeat(Math.floor((size - empty) / escaped)) },
  } as StoredRow;
};

describe("COSMOS_LIMITS", () => {
  it.each(['"', "\\"])(
    "keeps an item of escaped %s within Cosmos DB's 2 MB",
    (char) => {
      const pk = "remote_config";
      const sk = "a".repeat(200);
      const row = worstRow(pk, sk, COSMOS_LIMITS.itemBytes, char);
      expect(measured(pk, sk, row)).toBeLessThanOrEqual(
        COSMOS_LIMITS.itemBytes,
      );

      expect(bytes(toItem({ pk, sk }, row, Date.now()))).toBeLessThan(
        COSMOS_MAX_BYTES,
      );
    },
  );

  it("keeps a full batch of escaped items within Cosmos DB's 2 MB request", () => {
    const items = Array.from({ length: COSMOS_LIMITS.items }, (_, index) => {
      const pk = `table_${index}`;
      const sk = `key_${index}`;
      const row = worstRow(
        pk,
        sk,
        Math.floor(COSMOS_LIMITS.bytes / COSMOS_LIMITS.items),
        '"',
      );
      return {
        operationType: "Upsert",
        ifMatch: '"00000000-0000-0000-0000-000000000000"',
        resourceBody: toItem({ pk, sk }, row, Date.now()),
      };
    });

    expect(bytes(items)).toBeLessThan(COSMOS_MAX_BYTES);
  });
});

/**
 * A container holding `rows`, answering as Cosmos DB does: a point read of a
 * missing item answers 404 from its partition, and one in a missing
 * container 404 with a substatus; a query in a missing container throws 404.
 */
const fakeContainer = (
  rows: readonly (readonly [KvKey, StoredRow])[],
  { missing = false } = {},
) => {
  const items = new Map(
    rows.map(([key, row]) => [
      cosmosItemId(key),
      { ...toItem(key, row, 0), _etag: `"etag-${key.sk}"` },
    ]),
  );
  const requests = { pointReads: 0, queries: 0, batches: [] as unknown[] };
  const container = {
    item: (id: string) => ({
      read: async () => {
        requests.pointReads += 1;
        const resource = missing ? undefined : items.get(id);
        if (resource) return { statusCode: 200, resource, headers: {} };
        return {
          statusCode: 404,
          resource: undefined,
          headers: missing
            ? { "x-ms-substatus": "0" }
            : { "x-ms-documentdb-partitionkeyrangeid": "0" },
        };
      },
    }),
    items: {
      query: (query: string) => ({
        fetchAll: async () => {
          requests.queries += 1;
          if (missing)
            throw Object.assign(new Error("Not Found"), { code: 404 });
          const ids = [...query.matchAll(/"([^"]+)"/gu)].map(([, id]) => id!);
          return {
            resources: ids.flatMap((id) => {
              const item = items.get(id);
              return item
                ? [{ ...item, etag: item._etag, v: item.row._v }]
                : [];
            }),
          };
        },
      }),
      batch: async (operations: readonly unknown[]) => {
        requests.batches.push(operations);
        return { result: operations.map(() => ({ statusCode: 200 })) };
      },
    },
  };
  const client = {
    database: () => ({ container: () => container }),
  } as unknown as CosmosClient;
  return { requests, client };
};

describe("createCosmosStore reads", () => {
  const key = (sk: string): KvKey => ({ pk: "release_catalogs", sk });
  const row = (sk: string): StoredRow => ({ _v: 1, scope_key: sk });
  const rows = ["a", "b", "c"].map((sk) => [key(sk), row(sk)] as const);
  const storeOf = (options?: { missing?: boolean }) => {
    const fake = fakeContainer(rows, options);
    const store = createCosmosStore({
      client: fake.client,
      databaseId: "hot-updater",
      containerId: "hot_updater_v1",
    });
    return { ...fake, store };
  };

  // On Strong consistency a point read costs 2 RU; a query of 1, 3, or 10
  // ids 5.9, 6.4, and 8.3 RU (measured on Azure Cosmos DB, 2026-11-14).
  it("reads one or two keys by point reads and more by one query, whichever costs fewer RU", async () => {
    const one = storeOf();
    await expect(one.store.get([key("a")])).resolves.toEqual([row("a")]);
    expect(one.requests).toMatchObject({ pointReads: 1, queries: 0 });

    const two = storeOf();
    await expect(two.store.get([key("a"), key("x")])).resolves.toEqual([
      row("a"),
      null,
    ]);
    expect(two.requests).toMatchObject({ pointReads: 2, queries: 0 });

    const three = storeOf();
    await expect(
      three.store.get([key("a"), key("b"), key("c")]),
    ).resolves.toEqual([row("a"), row("b"), row("c")]);
    expect(three.requests).toMatchObject({ pointReads: 0, queries: 1 });
  });

  it("reads a key of a missing container as a missing schema, as a query does", async () => {
    const { store } = storeOf({ missing: true });
    await expect(store.get([key("a")])).rejects.toMatchObject({
      code: "42P01",
    });
  });

  it("reads the state a write plans from by a point read", async () => {
    const { store, requests } = storeOf();
    await expect(
      store.write([
        { type: "delete", key: key("a") },
        { type: "delete", key: key("x") },
      ]),
    ).resolves.toEqual({ ok: true });
    expect(requests).toMatchObject({ pointReads: 2, queries: 0 });
    // Only the item the read found is deleted.
    expect(requests.batches).toEqual([
      [{ operationType: "Delete", id: cosmosItemId(key("a")) }],
    ]);
  });
});
