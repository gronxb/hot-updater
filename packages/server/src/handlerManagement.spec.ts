import { describe, expect, it } from "vitest";

import { createHandler } from "./handler";
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
    // Given
    const api = createApi();
    const handler = createManagementHandler(api);

    // When
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles?orderDirection=asc",
      ),
    );

    // Then
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
    // Given
    const api = createApi();
    const handler = createManagementHandler(api);

    // When
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles?orderDirection=random",
      ),
    );

    // Then
    expect(response.status).toBe(400);
    expect(api.getBundles).not.toHaveBeenCalled();
  });

  it("rejects a bundle batch before mutation when atomic insertion is unavailable", async () => {
    // Given
    const api = createApi();
    const handler = createManagementHandler(api);

    // When
    const response = await handler(
      new Request("http://localhost/hot-updater/api/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([testBundle, { ...testBundle, id: "bundle-2" }]),
      }),
    );

    // Then
    expect(response.status).toBe(400);
    expect(api.insertBundle).not.toHaveBeenCalled();
  });

  it("does not mount feature-owned routes with bundle management", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/hot-updater",
      coreRoutes: {
        updateCheck: true,
        bundles: { access: { kind: "public" } },
      },
    });

    // When
    const response = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles/bundle-1/events/summary",
      ),
    );

    // Then
    expect(response.status).toBe(404);
  });
});
