import { describe, expect, it } from "vitest";

import {
  createApi,
  createAdminHandler,
  testBundle,
} from "./handler.testFixtures";

describe("createHandlers admin routes", () => {
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
