import { createStorageAdapter } from "@hot-updater/plugin-core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { standaloneRepository } from "./standaloneRepository";

const BASE_URL = "http://localhost/hot-updater/admin";
const server = setupServer();
const storage = [createStorageAdapter({ name: "s3", protocol: "s3" })];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("standaloneRepository", () => {
  it("is a remote server: core over admin API protocol 2, fetchAdmin, and its storage", () => {
    const repository = standaloneRepository({ baseUrl: BASE_URL, storage });

    expect(Object.keys(repository).sort()).toEqual([
      "core",
      "fetchAdmin",
      "name",
      "storage",
      "url",
    ]);
    expect(repository.name).toBe("standalone-repository");
    expect(repository.url).toBe(BASE_URL);
    expect(repository.core.deploy).toBeTypeOf("function");
    expect(repository.storage).toEqual(storage);
    expect(Object.isFrozen(repository)).toBe(true);
  });

  it("needs the storage the CLI uploads to", () => {
    expect(() =>
      standaloneRepository({ baseUrl: BASE_URL, storage: [] }),
    ).toThrow("standaloneRepository needs storage");
  });

  it("reaches admin routes core does not cover with the repository's headers", async () => {
    let authorization: string | null = null;
    let url = "";
    server.use(
      http.get(`${BASE_URL}/events`, ({ request }) => {
        authorization = request.headers.get("authorization");
        url = request.url;
        return HttpResponse.json({ data: [], nextCursor: null });
      }),
    );
    const repository = standaloneRepository({
      baseUrl: `${BASE_URL}/`,
      commonHeaders: { Authorization: "Bearer token" },
      storage,
    });

    const response = await repository.fetchAdmin("/events?limit=1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [],
      nextCursor: null,
    });
    expect(authorization).toBe("Bearer token");
    expect(url).toBe(`${BASE_URL}/events?limit=1`);
  });

  it("reads the plugins the server runs from its admin /version, fresh each time", async () => {
    let cacheControl: string | null = null;
    server.use(
      http.get(`${BASE_URL}/version`, ({ request }) => {
        cacheControl = request.headers.get("cache-control");
        return HttpResponse.json({
          adminProtocol: 2,
          plugins: ["apiKeys", "insights"],
        });
      }),
    );

    const response = await standaloneRepository({
      baseUrl: BASE_URL,
      storage,
    }).fetchAdmin("/version");

    await expect(response.json()).resolves.toMatchObject({
      plugins: ["apiKeys", "insights"],
    });
    expect(cacheControl).toBe("no-cache");
  });
});
