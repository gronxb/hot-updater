import type { Bundle } from "@hot-updater/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabaseClient } from "./databaseClient";
import type { DatabaseClient } from "./databaseClient";
import { DatabasePluginInputError } from "./databasePluginCrud";
import { createMemoryDatabasePlugin } from "./databasePluginMemory.testFixtures";
import type { DatabasePlugin } from "./types";

const createBundle = (id: string): Bundle => ({
  id,
  platform: "ios",
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  storageUri: `storage://${id}`,
});

const createFixture = (): {
  readonly client: DatabaseClient;
  readonly plugin: DatabasePlugin;
} => {
  const plugin = createMemoryDatabasePlugin();
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
    const findMany = vi.spyOn(plugin.models.bundles, "findMany");

    const page = await client.getBundles({
      limit: 2,
      page: 2,
      orderBy: { field: "id", direction: "asc" },
    });

    expect(page.data.map(({ id }) => id)).toEqual(["003", "004"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 2,
        offset: 2,
        orderBy: { field: "id", direction: "asc" },
      }),
    );
  });

  it("pushes an after cursor into a descending owner query", async () => {
    const findMany = vi.spyOn(plugin.models.bundles, "findMany");

    const page = await client.getBundles({
      limit: 2,
      cursor: { after: "004" },
      orderBy: { field: "id", direction: "desc" },
    });

    expect(page.data.map(({ id }) => id)).toEqual(["003", "002"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 3,
        offset: 0,
        where: { id: { lt: "004" } },
        orderBy: { field: "id", direction: "desc" },
      }),
    );
  });

  it("reverses a before query back into descending response order", async () => {
    const findMany = vi.spyOn(plugin.models.bundles, "findMany");

    const page = await client.getBundles({
      limit: 2,
      cursor: { before: "003" },
      orderBy: { field: "id", direction: "desc" },
    });

    expect(page.data.map(({ id }) => id)).toEqual(["005", "004"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 3,
        offset: 0,
        where: { id: { gt: "003" } },
        orderBy: { field: "id", direction: "asc" },
      }),
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid aggregate limit %s before querying the provider",
    async (limit) => {
      const findMany = vi.spyOn(plugin.models.bundles, "findMany").mockClear();
      const count = vi.spyOn(plugin.models.bundles, "count").mockClear();

      const result = Reflect.apply(client.getBundles, client, [{ limit }]);

      await expect(result).rejects.toEqual(
        new DatabasePluginInputError("invalid-pagination"),
      );
      expect(findMany).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    },
  );

  it("rejects an unsafe page offset before querying the provider", async () => {
    const findMany = vi.spyOn(plugin.models.bundles, "findMany").mockClear();
    const count = vi.spyOn(plugin.models.bundles, "count").mockClear();

    const result = client.getBundles({
      limit: 2,
      page: Number.MAX_SAFE_INTEGER,
    });

    await expect(result).rejects.toEqual(
      new DatabasePluginInputError("invalid-pagination"),
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("rejects an unsafe cursor lookahead before querying the provider", async () => {
    const findMany = vi.spyOn(plugin.models.bundles, "findMany").mockClear();
    const count = vi.spyOn(plugin.models.bundles, "count").mockClear();

    const result = client.getBundles({
      limit: Number.MAX_SAFE_INTEGER,
      cursor: { after: "004" },
    });

    await expect(result).rejects.toEqual(
      new DatabasePluginInputError("invalid-pagination"),
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid aggregate page %s before querying the provider",
    async (page) => {
      const findMany = vi.spyOn(plugin.models.bundles, "findMany").mockClear();
      const count = vi.spyOn(plugin.models.bundles, "count").mockClear();

      const result = Reflect.apply(client.getBundles, client, [
        { limit: 2, page },
      ]);

      await expect(result).rejects.toEqual(
        new DatabasePluginInputError("invalid-pagination"),
      );
      expect(findMany).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    },
  );

  it("rejects competing cursors before querying the provider", async () => {
    const findMany = vi.spyOn(plugin.models.bundles, "findMany").mockClear();
    const count = vi.spyOn(plugin.models.bundles, "count").mockClear();

    const result = Reflect.apply(client.getBundles, client, [
      { limit: 2, cursor: { after: "004", before: "002" } },
    ]);

    await expect(result).rejects.toEqual(
      new DatabasePluginInputError("invalid-pagination"),
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it.each([
    { name: "empty", cursor: {} },
    { name: "null", cursor: null },
    { name: "string", cursor: "004" },
    { name: "empty after", cursor: { after: "" } },
    { name: "empty before", cursor: { before: "" } },
    { name: "non-string after", cursor: { after: 4 } },
    { name: "non-string before", cursor: { before: false } },
  ])(
    "rejects a malformed $name cursor before querying the provider",
    async ({ cursor }) => {
      const findMany = vi.spyOn(plugin.models.bundles, "findMany").mockClear();
      const count = vi.spyOn(plugin.models.bundles, "count").mockClear();

      const result = Reflect.apply(client.getBundles, client, [
        { limit: 2, cursor },
      ]);

      await expect(result).rejects.toEqual(
        new DatabasePluginInputError("invalid-pagination"),
      );
      expect(findMany).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    },
  );

  it("rejects a page combined with a cursor before querying the provider", async () => {
    const findMany = vi.spyOn(plugin.models.bundles, "findMany").mockClear();
    const count = vi.spyOn(plugin.models.bundles, "count").mockClear();

    const result = Reflect.apply(client.getBundles, client, [
      { limit: 2, page: 1, cursor: { after: "004" } },
    ]);

    await expect(result).rejects.toEqual(
      new DatabasePluginInputError("invalid-pagination"),
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("does not expose a next page after an exactly full terminal window", async () => {
    const options = {
      limit: 2,
      cursor: { after: "003" },
      orderBy: { field: "id", direction: "desc" },
    } as const;

    const page = await client.getBundles(options);

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
    const options = {
      limit: 2,
      cursor: { before: "003" },
      orderBy: { field: "id", direction: "desc" },
    } as const;

    const page = await client.getBundles(options);

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
