import { describe, expect, it, vi } from "vitest";

import { createHandler } from "../handler";
import { createApi } from "../handler.testFixtures";
import { createCoreServerRoutes } from "./coreRoutes";
import { executeKernelRequest } from "./execute";
import { compileRoutes } from "./routeCompiler";

describe("createCoreServerRoutes", () => {
  it("mirrors the legacy route table and keeps every route public", () => {
    // Given / When
    const routes = createCoreServerRoutes({
      handler: async () => new Response(),
      routes: { bundles: true, updateCheck: true },
    });

    // Then
    expect(routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /version",
      "GET /fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
      "GET /fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:cohort",
      "GET /app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
      "GET /app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId/:cohort",
      "GET /api/bundles/channels",
      "GET /api/bundles/:id",
      "GET /api/bundles",
      "POST /api/bundles",
      "PATCH /api/bundles/:id",
      "DELETE /api/bundles/:id",
    ]);
    expect(routes.every(({ access }) => access.kind === "public")).toBe(true);
  });

  it("defaults update checks on and bundle routes off", () => {
    // Given / When
    const routes = createCoreServerRoutes({
      handler: async () => new Response(),
    });

    // Then
    expect(routes).toHaveLength(5);
    expect(routes[0]?.id).toBe("core.version");
    expect(routes.some(({ id }) => id.startsWith("core.bundles."))).toBe(false);
  });

  it("delegates route execution to the legacy handler with platform context", async () => {
    // Given
    const response = new Response('{"version":"legacy"}', {
      headers: { "content-type": "application/json" },
    });
    const handler = vi.fn(async () => response);
    const routes = createCoreServerRoutes({ handler });
    const request = new Request("https://example.com/api/version");
    const version = routes[0];
    if (version === undefined)
      throw new Error("Missing version route fixture.");

    // When
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

    // Then
    expect(actual).toBe(response);
    expect(handler).toHaveBeenCalledWith(request, undefined);
  });

  it("keeps the legacy version response byte-compatible through the kernel", async () => {
    // Given
    const legacyHandler = createHandler(createApi(), {
      basePath: "/hot-updater",
    });
    const router = compileRoutes(
      createCoreServerRoutes({ handler: legacyHandler }),
    );

    // When
    const direct = await legacyHandler(
      new Request("https://example.com/hot-updater/version"),
    );
    const throughKernel = await executeKernelRequest({
      basePath: "/hot-updater",
      request: new Request("https://example.com/hot-updater/version"),
      router,
    });

    // Then
    expect(throughKernel.status).toBe(direct.status);
    expect(Object.fromEntries(throughKernel.headers)).toEqual(
      Object.fromEntries(direct.headers),
    );
    expect(await throughKernel.text()).toBe(await direct.text());
  });
});
