import { describe, expect, it, vi } from "vitest";

import {
  createApi,
  createAdminHandler,
  testBundle,
} from "./handler.testFixtures";

describe("createHandlers admin routes", () => {
  it("routes patch children directly and never substitutes a bundle list", async () => {
    const api = createApi();
    const getBundlePatchChildren = vi.fn(async () => []);
    const response = await createAdminHandler({
      ...api,
      getBundlePatchChildren,
    })(new Request("http://localhost/bundles/base/patch-children"));
    expect(response.status).toBe(200);
    expect(getBundlePatchChildren).toHaveBeenCalledExactlyOnceWith("base");
    expect(api.getBundles).not.toHaveBeenCalled();
    const unsupported = await createAdminHandler(api)(
      new Request("http://localhost/bundles/base/patch-children"),
    );
    expect(unsupported.status).toBe(501);
    expect(api.getBundles).not.toHaveBeenCalled();
  });

  it("forwards an exact bounded offset without translating it into pages", async () => {
    const api = createApi();
    const response = await createAdminHandler(api)(
      new Request(
        "http://localhost/bundles?offset=125&limit=100&idIn=a&idIn=b&platform=ios&orderDirection=asc",
      ),
    );
    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ["a", "b"] }, platform: "ios" },
      orderBy: { field: "id", direction: "asc" },
      limit: 100,
      offset: 125,
    });
  });

  it("counts matching bundles without reading bundles or patch relations", async () => {
    const api = createApi();
    const countBundles = vi.fn(async () => 150);
    const getBundlePatchChildren = vi.fn();
    const response = await createAdminHandler({
      ...api,
      countBundles,
      getBundlePatchChildren,
    })(
      new Request(
        "http://localhost/bundles/count?platform=ios&idIn=a&idIn=b&idGte=a&idLt=z",
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { count: 150 } });
    expect(countBundles).toHaveBeenCalledExactlyOnceWith({
      platform: "ios",
      id: { in: ["a", "b"], gte: "a", lt: "z" },
    });
    expect(api.getBundleById).not.toHaveBeenCalled();
    expect(api.getBundles).not.toHaveBeenCalled();
    expect(getBundlePatchChildren).not.toHaveBeenCalled();
  });

  it("validates count filters before invoking the provider", async () => {
    const api = createApi();
    const countBundles = vi.fn();
    const response = await createAdminHandler({ ...api, countBundles })(
      new Request("http://localhost/bundles/count?platform=desktop"),
    );
    expect(response.status).toBe(400);
    expect(countBundles).not.toHaveBeenCalled();
    expect(api.getBundleById).not.toHaveBeenCalled();
    expect(api.getBundles).not.toHaveBeenCalled();
  });

  it("fails explicitly when count-only reads are unavailable", async () => {
    const api = createApi();
    const response = await createAdminHandler(api)(
      new Request("http://localhost/bundles/count"),
    );
    expect(response.status).toBe(501);
    expect(api.getBundleById).not.toHaveBeenCalled();
    expect(api.getBundles).not.toHaveBeenCalled();
  });

  it.each(["idEq", "idGt", "idGte", "idLt", "idLte"])(
    "preserves an empty %s predicate instead of broadening the query",
    async (key) => {
      const api = createApi();
      const response = await createAdminHandler(api)(
        new Request(`http://localhost/bundles?${key}=`),
      );
      expect(response.status).toBe(200);
      expect(api.getBundles).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { [key.slice(2).toLowerCase()]: "" } },
        }),
      );
    },
  );

  it("does not match client routes", async () => {
    const api = createApi();
    const handler = createAdminHandler(api);
    const response = await handler(new Request("http://localhost/version"));

    expect(response.status).toBe(404);
  });

  it("exposes the canonical Channel-row route and removes the legacy path", async () => {
    const api = createApi();
    const handler = createAdminHandler(api);

    const response = await handler(new Request("http://localhost/channels"));
    const legacyResponse = await handler(
      new Request("http://localhost/bundles/channels"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        channels: [{ id: "channel-production", name: "production" }],
      },
    });
    expect(legacyResponse.status).toBe(404);
  });

  it("returns 201 when the canonical route inserts a Channel", async () => {
    const api = createApi();
    api.insertChannel.mockResolvedValueOnce({
      row: { id: "candidate-id", name: "preview" },
      inserted: true,
    });
    const handler = createAdminHandler(api);

    const response = await handler(
      new Request("http://localhost/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          row: { id: "candidate-id", name: "preview" },
          onConflict: "returnExisting",
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      data: {
        row: { id: "candidate-id", name: "preview" },
        inserted: true,
      },
    });
  });

  it("returns the canonical row when a Channel already exists", async () => {
    const api = createApi();
    api.insertChannel.mockResolvedValueOnce({
      row: { id: "canonical-id", name: "preview" },
      inserted: false,
    });
    const handler = createAdminHandler(api);

    const response = await handler(
      new Request("http://localhost/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          row: { id: "candidate-id", name: "preview" },
          onConflict: "returnExisting",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        row: { id: "canonical-id", name: "preview" },
        inserted: false,
      },
    });
    expect(api.insertChannel).toHaveBeenCalledWith({
      row: { id: "candidate-id", name: "preview" },
      onConflict: "returnExisting",
    });
  });

  it.each([
    { row: { name: "preview" } },
    { row: { id: "", name: "preview" }, onConflict: "returnExisting" },
    { row: { id: "channel-preview", name: "" }, onConflict: "returnExisting" },
    {
      row: { id: "channel-preview", name: "x".repeat(256) },
      onConflict: "returnExisting",
    },
  ])(
    "rejects malformed Channel insert input before persistence",
    async (body) => {
      const api = createApi();
      const handler = createAdminHandler(api);

      const response = await handler(
        new Request("http://localhost/channels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

      expect(response.status).toBe(400);
      expect(api.insertChannel).not.toHaveBeenCalled();
    },
  );

  it("returns no content after deleting an empty Channel", async () => {
    const api = createApi();
    api.deleteChannel.mockResolvedValueOnce({ deleted: true });
    const handler = createAdminHandler(api);

    const response = await handler(
      new Request("http://localhost/channels/channel-preview", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");
  });

  it.each([
    [{ deleted: false, reason: "not_found" } as const, 404],
    [{ deleted: false, reason: "not_empty" } as const, 409],
  ])("maps Channel deletion result %j to HTTP %i", async (result, status) => {
    const api = createApi();
    api.deleteChannel.mockResolvedValueOnce(result);
    const handler = createAdminHandler(api);

    const response = await handler(
      new Request("http://localhost/channels/channel-preview", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ data: result });
    expect(api.deleteChannel).toHaveBeenCalledWith({ id: "channel-preview" });
  });

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
    const handler = createAdminHandler(api);
    const response = await handler(new Request("http://localhost/bundles"));

    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 50,
      page: undefined,
      where: {},
    });
  });

  it("forwards an explicit bundle id order direction", async () => {
    const api = createApi();
    const handler = createAdminHandler(api);

    const response = await handler(
      new Request("http://localhost/bundles?orderDirection=asc"),
    );

    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 50,
      orderBy: { field: "id", direction: "asc" },
      page: undefined,
      where: {},
    });
  });

  it("does not treat Release policy query parameters as Bundle filters", async () => {
    const api = createApi();
    const handler = createAdminHandler(api);

    const response = await handler(
      new Request(
        "http://localhost/bundles?channel=production&enabled=true&targetAppVersion=1.0.0&fingerprintHash=abc",
      ),
    );

    expect(response.status).toBe(200);
    expect(api.getBundles).toHaveBeenCalledWith({
      cursor: undefined,
      limit: 50,
      page: undefined,
      where: {},
    });
  });

  it("rejects an invalid bundle id order direction", async () => {
    const api = createApi();
    const handler = createAdminHandler(api);

    const response = await handler(
      new Request("http://localhost/bundles?orderDirection=random"),
    );

    expect(response.status).toBe(400);
    expect(api.getBundles).not.toHaveBeenCalled();
  });

  it.each([
    "after=bundle-2&before=bundle-4",
    "page=2&after=bundle-2",
    "page=2&before=bundle-4",
    `page=${Number.MAX_SAFE_INTEGER}`,
    "offset=-1",
    "offset=1.5",
    "offset=1&page=1",
    "offset=1&after=a",
    "offset=1&before=a",
    `offset=${Number.MAX_SAFE_INTEGER}&limit=1`,
  ])("rejects invalid pagination parameters: %s", async (query) => {
    const api = createApi();
    const handler = createAdminHandler(api);

    const response = await handler(
      new Request(`http://localhost/bundles?${query}`),
    );

    expect(response.status).toBe(400);
    expect(api.getBundles).not.toHaveBeenCalled();
  });

  it("rejects a bundle batch before mutation when atomic insertion is unavailable", async () => {
    const api = createApi();
    const handler = createAdminHandler(api);

    const response = await handler(
      new Request("http://localhost/bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([testBundle, { ...testBundle, id: "bundle-2" }]),
      }),
    );

    expect(response.status).toBe(400);
    expect(api.insertBundle).not.toHaveBeenCalled();
  });
});
