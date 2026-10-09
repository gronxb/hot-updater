import { describe, expect, it, vi } from "vitest";

import {
  createRemoteConfigAdminClient,
  RemoteConfigAdminError,
} from "./remote-config-admin.ts";

const BASE_URL = "http://127.0.0.1:3007/hot-updater/admin/";

const fakeAdmin = (activeVersion: number) => {
  const requests: { method: string; url: string; body: unknown }[] = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const body =
        init?.body === undefined ? null : JSON.parse(String(init.body));
      requests.push({ method: init?.method ?? "GET", url: String(url), body });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer admin",
      );
      if (String(url).endsWith("/template") && init?.method === "GET") {
        return Response.json({ version: activeVersion, template: {} });
      }
      return Response.json({ version: activeVersion + 1 });
    },
  );
  return { fetch: fetch as typeof globalThis.fetch, requests };
};

describe("createRemoteConfigAdminClient", () => {
  it("publishes from the server's active version", async () => {
    const admin = fakeAdmin(4);
    const client = createRemoteConfigAdminClient({
      baseUrl: BASE_URL,
      headers: { Authorization: "Bearer admin" },
      fetch: admin.fetch,
    });

    await expect(
      client.publish({ template: { parameters: {} }, description: "E2E" }),
    ).resolves.toBe(5);
    expect(admin.requests).toEqual([
      {
        method: "GET",
        url: "http://127.0.0.1:3007/hot-updater/admin/remote-config/template",
        body: null,
      },
      {
        method: "PUT",
        url: "http://127.0.0.1:3007/hot-updater/admin/remote-config/template",
        body: {
          template: { parameters: {} },
          baseVersion: 4,
          description: "E2E",
        },
      },
    ]);
  });

  it("rolls back a version from the server's active version", async () => {
    const admin = fakeAdmin(6);
    const client = createRemoteConfigAdminClient({
      baseUrl: BASE_URL,
      headers: { Authorization: "Bearer admin" },
      fetch: admin.fetch,
    });

    await expect(client.rollback(2)).resolves.toBe(7);
    expect(admin.requests[1]).toEqual({
      method: "POST",
      url: "http://127.0.0.1:3007/hot-updater/admin/remote-config/versions/2/rollback",
      body: { baseVersion: 6 },
    });
  });

  it("reports a refused request with the server's answer", async () => {
    const client = createRemoteConfigAdminClient({
      baseUrl: BASE_URL,
      fetch: (async () =>
        Response.json(
          { error: "invalid", issues: [{ path: "x" }] },
          { status: 400 },
        )) as typeof globalThis.fetch,
    });

    await expect(client.publish({ template: {} })).rejects.toMatchObject({
      name: "RemoteConfigAdminError",
      status: 400,
      body: { error: "invalid", issues: [{ path: "x" }] },
    });
    await expect(client.rollback(1)).rejects.toBeInstanceOf(
      RemoteConfigAdminError,
    );
  });
});
