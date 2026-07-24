import type { Bundle } from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBlobDatabasePlugin } from "./createBlobDatabasePlugin";
import { createDatabaseClient } from "./databaseClient";
import type { DatabaseClient } from "./databaseClient";
import type { DatabasePlugin } from "./types";

const createBundle = (id: string): Bundle => ({
  id,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  message: id,
  channel: "production",
  storageUri: `storage://${id}`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
});

const createFixture = (): {
  readonly client: DatabaseClient;
  readonly plugin: DatabasePlugin;
} => {
  const store = new Map<string, unknown>();
  const plugin = createBlobDatabasePlugin({
    name: "pagination-semantics",
    plugin: () => ({
      apiBasePath: "/api/check-update",
      listObjects: async (prefix) =>
        [...store.keys()].filter((key) => key.startsWith(prefix)),
      loadObject: async (key) => store.get(key) ?? null,
      uploadObject: async (key, value) => void store.set(key, value),
      compareAndSwapObject: async (key, expected, value) => {
        if (
          JSON.stringify(store.get(key) ?? null) !== JSON.stringify(expected)
        ) {
          return false;
        }
        store.set(key, value);
        return true;
      },
      invalidatePaths: async () => undefined,
    }),
  });
  return { client: createDatabaseClient(plugin), plugin };
};

describe("database client pagination semantics", () => {
  let client: DatabaseClient;
  let plugin: DatabasePlugin;

  beforeEach(async () => {
    ({ client, plugin } = createFixture());
    for (const id of ["001", "002", "003", "004", "005"]) {
      await client.insertBundle(createBundle(id));
    }
  });

  it("pushes an ascending page offset into the owner query", async () => {
    // Given
    const findMany = vi.spyOn(plugin, "findMany");

    // When
    const page = await client.getBundles({
      limit: 2,
      page: 2,
      orderBy: { field: "id", direction: "asc" },
    });

    // Then
    expect(page.data.map(({ id }) => id)).toEqual(["003", "004"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "bundles",
        limit: 2,
        offset: 2,
        orderBy: [{ field: "id", direction: "asc" }],
      }),
    );
  });

  it("pushes an after cursor into a descending owner query", async () => {
    // Given
    const findMany = vi.spyOn(plugin, "findMany");

    // When
    const page = await client.getBundles({
      limit: 2,
      cursor: { after: "004" },
      orderBy: { field: "id", direction: "desc" },
    });

    // Then
    expect(page.data.map(({ id }) => id)).toEqual(["003", "002"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "bundles",
        limit: 3,
        offset: 0,
        where: [{ field: "id", operator: "lt", value: "004" }],
        orderBy: [{ field: "id", direction: "desc" }],
      }),
    );
  });

  it("reverses a before query back into descending response order", async () => {
    // Given
    const findMany = vi.spyOn(plugin, "findMany");

    // When
    const page = await client.getBundles({
      limit: 2,
      cursor: { before: "003" },
      orderBy: { field: "id", direction: "desc" },
    });

    // Then
    expect(page.data.map(({ id }) => id)).toEqual(["005", "004"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "bundles",
        limit: 3,
        offset: 0,
        where: [{ field: "id", operator: "gt", value: "003" }],
        orderBy: [{ field: "id", direction: "asc" }],
      }),
    );
  });

  it("does not expose a next page after an exactly full terminal window", async () => {
    // Given
    const options = {
      limit: 2,
      cursor: { after: "003" },
      orderBy: { field: "id", direction: "desc" },
    } as const;

    // When
    const page = await client.getBundles(options);

    // Then
    expect(page.data.map(({ id }) => id)).toEqual(["002", "001"]);
    expect(page.pagination).toEqual(
      expect.objectContaining({
        hasNextPage: false,
        hasPreviousPage: true,
        previousCursor: "002",
      }),
    );
    expect(page.pagination.nextCursor).toBeUndefined();
  });

  it("does not expose a previous page before an exactly full terminal window", async () => {
    // Given
    const options = {
      limit: 2,
      cursor: { before: "003" },
      orderBy: { field: "id", direction: "desc" },
    } as const;

    // When
    const page = await client.getBundles(options);

    // Then
    expect(page.data.map(({ id }) => id)).toEqual(["005", "004"]);
    expect(page.pagination).toEqual(
      expect.objectContaining({
        hasNextPage: true,
        hasPreviousPage: false,
        nextCursor: "004",
      }),
    );
    expect(page.pagination.previousCursor).toBeUndefined();
  });
});
