import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { standaloneRepository } from "./standaloneRepository";

const BASE_URL = "http://localhost/hot-updater/admin";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("standaloneRepository", () => {
  it("is a remote database: core over admin API protocol 2 and fetchAdmin", () => {
    const repository = standaloneRepository({ baseUrl: BASE_URL });

    expect(Object.keys(repository).sort()).toEqual([
      "core",
      "fetchAdmin",
      "name",
    ]);
    expect(repository.name).toBe("standalone-repository");
    expect(repository.core.deploy).toBeTypeOf("function");
    expect(Object.isFrozen(repository)).toBe(true);
  });

  it("reaches admin routes core does not cover with the repository's headers", async () => {
    let authorization: string | null = null;
    let url = "";
    server.use(
      http.get(`${BASE_URL}/events`, ({ request }) => {
        authorization = request.headers.get("authorization");
        url = request.url;
        return new HttpResponse(null, {
          status: 204,
          headers: { "x-hot-updater-insights": "disabled" },
        });
      }),
    );
    const repository = standaloneRepository({
      baseUrl: `${BASE_URL}/`,
      commonHeaders: { Authorization: "Bearer token" },
    });

    const response = await repository.fetchAdmin("/events?limit=1");

    expect(response.status).toBe(204);
    expect(response.headers.get("x-hot-updater-insights")).toBe("disabled");
    expect(authorization).toBe("Bearer token");
    expect(url).toBe(`${BASE_URL}/events?limit=1`);
  });

  it("sends a plugin's admin DELETE with its method and body, and the repository's headers", async () => {
    let request: Request | undefined;
    server.use(
      http.delete(`${BASE_URL}/installations/install-1`, async (info) => {
        request = info.request;
        return HttpResponse.json({ deleted: { installations: 1, events: 2 } });
      }),
    );

    const response = await standaloneRepository({
      baseUrl: BASE_URL,
      commonHeaders: { Authorization: "Bearer token" },
    }).fetchAdmin("/installations/install-1", {
      method: "DELETE",
      body: "{}",
    });

    await expect(response.json()).resolves.toEqual({
      deleted: { installations: 1, events: 2 },
    });
    expect(request?.method).toBe("DELETE");
    expect(request?.headers.get("authorization")).toBe("Bearer token");
    expect(request?.headers.get("cache-control")).toBeNull();
    await expect(request?.text()).resolves.toBe("{}");
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
    }).fetchAdmin("/version");

    await expect(response.json()).resolves.toMatchObject({
      plugins: ["apiKeys", "insights"],
    });
    expect(cacheControl).toBe("no-cache");
  });
});
