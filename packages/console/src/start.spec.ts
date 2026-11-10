// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | ((request: Request) => Response | undefined),
}));

vi.mock("virtual:hot-updater-console/request-guard", () => ({
  get default() {
    return guard.current;
  },
}));

const { startInstance } = await import("./start");

type Middleware = {
  readonly options: {
    readonly server: (context: {
      request: Request;
      pathname: string;
      handlerType: "serverFn" | "router";
      context: object;
      next: () => Promise<unknown>;
    }) => Promise<unknown>;
  };
};

const middlewares = async () =>
  ((await startInstance.getOptions()).requestMiddleware ??
    []) as unknown as readonly Middleware[];

/** What the start's request middleware answers `request` with, in order. */
const answer = async (
  request: Request,
  handlerType: "serverFn" | "router" = "serverFn",
) => {
  const next = vi.fn(async () => "handled");
  let result: unknown = "handled";
  for (const middleware of await middlewares()) {
    next.mockClear();
    result = await middleware.options.server({
      request,
      pathname: new URL(request.url).pathname,
      handlerType,
      context: {},
      next,
    });
    if (result instanceof Response) return result;
  }
  return result;
};

afterEach(() => {
  guard.current = undefined;
});

describe("the console's request middleware", () => {
  it("lists TanStack Start's same-origin check for server functions", async () => {
    expect(
      (await middlewares()).some((middleware) =>
        Object.hasOwn(middleware, Symbol.for("tanstack-start:csrf-middleware")),
      ),
    ).toBe(true);
  });

  it("refuses a form another site posts to a server function", async () => {
    const response = await answer(
      new Request("https://console.example.com/_serverFn/revokeApiKeyRpc", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "x=1",
      }),
    );

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
  });

  it("refuses a server function call that says nothing of where it came from", async () => {
    const response = await answer(
      new Request("https://console.example.com/_serverFn/revokeApiKeyRpc", {
        method: "POST",
      }),
    );

    expect((response as Response).status).toBe(403);
  });

  it("lets the console's own pages call server functions", async () => {
    await expect(
      answer(
        new Request("https://console.example.com/_serverFn/revokeApiKeyRpc", {
          method: "POST",
          headers: { "sec-fetch-site": "same-origin" },
        }),
      ),
    ).resolves.toBe("handled");
  });

  it("answers with the local console's guard when it refuses, before any page or route", async () => {
    const refusal = new Response("Open this console with the link", {
      status: 401,
    });
    guard.current = () => refusal;

    await expect(
      answer(new Request("http://localhost:1422/api-keys"), "router"),
    ).resolves.toBe(refusal);

    guard.current = () => undefined;
    await expect(
      answer(new Request("http://localhost:1422/api-keys"), "router"),
    ).resolves.toBe("handled");
  });
});
