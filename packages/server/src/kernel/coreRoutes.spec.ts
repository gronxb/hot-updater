import { describe, expect, it, vi } from "vitest";

import { createHandler } from "../handler";
import { createApi, testBundle } from "../handler.testFixtures";
import { createCoreServerRoutes } from "./coreRoutes";
import { executeKernelRequest } from "./execute";
import { compileRoutes } from "./routeCompiler";

describe("createCoreServerRoutes", () => {
  it("keeps every enabled route compatible with the legacy handler", async () => {
    const api = createApi();
    api.getBundleById.mockResolvedValue(testBundle);
    api.getBundles.mockResolvedValue({
      data: [],
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        total: 0,
        totalPages: 0,
      },
    });
    const enabledRoutes = { bundles: true, updateCheck: true } as const;
    const legacyHandler = createHandler(api, {
      basePath: "/hot-updater",
      routes: enabledRoutes,
    });
    const routes = createCoreServerRoutes({
      handler: legacyHandler,
      routes: enabledRoutes,
    });
    const router = compileRoutes(routes);

    const responses = await Promise.all(
      routes.map(async (route) => {
        const path = route.path.replaceAll(/:[^/]+/g, "fixture");
        const url = `https://example.com/hot-updater${path}`;
        const init: RequestInit = {
          method: route.method,
          ...(route.method === "PATCH" || route.method === "POST"
            ? {
                body: JSON.stringify({}),
                headers: { "content-type": "application/json" },
              }
            : {}),
        };
        return {
          direct: await legacyHandler(new Request(url, init)),
          id: route.id,
          throughKernel: await executeKernelRequest({
            basePath: "/hot-updater",
            request: new Request(url, init),
            router,
          }),
        };
      }),
    );

    expect(routes.every(({ access }) => access.kind === "public")).toBe(true);
    for (const { direct, id, throughKernel } of responses) {
      expect(direct.status, id).not.toBe(404);
      expect(direct.status, id).not.toBe(500);
      expect(throughKernel.status, id).toBe(direct.status);
      expect(await throughKernel.text(), id).toBe(await direct.text());
    }
  });

  it("defaults update checks on and bundle routes off", () => {
    const routes = createCoreServerRoutes({
      handler: async () => new Response(),
    });

    expect(routes).toHaveLength(5);
    expect(routes[0]?.id).toBe("core.version");
    expect(routes.some(({ id }) => id.startsWith("core.bundles."))).toBe(false);
  });

  it("delegates route execution to the legacy handler with platform context", async () => {
    const response = new Response('{"version":"legacy"}', {
      headers: { "content-type": "application/json" },
    });
    const handler = vi.fn(async () => response);
    const routes = createCoreServerRoutes({ handler });
    const request = new Request("https://example.com/api/version");
    const version = routes[0];
    if (version === undefined)
      throw new Error("Missing version route fixture.");

    const actual = await version.handle(
      {
        headers: new Headers(),
        principal: undefined,
        route: {
          access: { kind: "public" },
          id: version.id,
          method: version.method,
          params: {},
          pattern: version.path,
        },
        signal: request.signal,
        url: new URL(request.url),
      },
      request,
    );

    expect(actual).toBe(response);
    expect(handler).toHaveBeenCalledWith(request, undefined);
  });

  it("keeps the legacy version response byte-compatible through the kernel", async () => {
    const legacyHandler = createHandler(createApi(), {
      basePath: "/hot-updater",
    });
    const router = compileRoutes(
      createCoreServerRoutes({ handler: legacyHandler }),
    );

    const direct = await legacyHandler(
      new Request("https://example.com/hot-updater/version"),
    );
    const throughKernel = await executeKernelRequest({
      basePath: "/hot-updater",
      request: new Request("https://example.com/hot-updater/version"),
      router,
    });

    expect(throughKernel.status).toBe(direct.status);
    expect(Object.fromEntries(throughKernel.headers)).toEqual(
      Object.fromEntries(direct.headers),
    );
    expect(await throughKernel.text()).toBe(await direct.text());
  });
});
