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
});
