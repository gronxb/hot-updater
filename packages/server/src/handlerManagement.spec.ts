import { describe, expect, it } from "vitest";

import {
  createApi,
  createManagementHandler,
  testBundle,
} from "./handler.testFixtures";

describe("createHandler management routes", () => {
  it("mounts bundle routes when explicitly enabled", async () => {
    const api = createApi();
    api.getBundles.mockResolvedValueOnce({
      data: [],
      pagination: {
        total: 0,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 0,
      },
    });
    const handler = createManagementHandler(api);
    const response = await handler(
      new Request("http://localhost/hot-updater/api/bundles"),
    );

    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledWith(
      { cursor: undefined, limit: 50, page: undefined, where: {} },
      undefined,
    );
  });

  it("forwards an explicit bundle id order direction", async () => {
    const api = createApi();
    const handler = createManagementHandler(api);

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles?orderDirection=asc",
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledWith(
      {
        cursor: undefined,
        limit: 50,
        orderBy: { field: "id", direction: "asc" },
        page: undefined,
        where: {},
      },
      undefined,
    );
  });

  it("rejects an invalid bundle id order direction", async () => {
    const api = createApi();
    const handler = createManagementHandler(api);

    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles?orderDirection=random",
      ),
    );

    expect(response.status).toBe(400);
    expect(api.getBundles).not.toHaveBeenCalled();
  });

  it.each([
    "after=bundle-2&before=bundle-4",
    "page=2&after=bundle-2",
    "page=2&before=bundle-4",
    `page=${Number.MAX_SAFE_INTEGER}`,
  ])("rejects invalid pagination parameters: %s", async (query) => {
    const api = createApi();
    const handler = createManagementHandler(api);

    const response = await handler(
      new Request(`http://localhost/hot-updater/api/bundles?${query}`),
    );

    expect(response.status).toBe(400);
    expect(api.getBundles).not.toHaveBeenCalled();
  });

  it("rejects a bundle batch before mutation when atomic insertion is unavailable", async () => {
    const api = createApi();
    const handler = createManagementHandler(api);

    const response = await handler(
      new Request("http://localhost/hot-updater/api/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([testBundle, { ...testBundle, id: "bundle-2" }]),
      }),
    );

    expect(response.status).toBe(400);
    expect(api.insertBundle).not.toHaveBeenCalled();
  });
});
