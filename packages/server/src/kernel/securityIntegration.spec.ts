import { afterEach, describe, expect, it, vi } from "vitest";

import { createHotUpdater } from "../index";
import {
  defineFirstPartyFeatureManifest,
  type FeatureApiKind,
} from "../internal/first-party-plugin";
import { createRuntimeDatabase } from "../runtime.testFixtures";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterPostAuthMiddleware,
  HotUpdaterRouteAccess,
  HotUpdaterServerRoute,
  HotUpdaterVersionMetadataContribution,
} from "./contracts";

const SECRET = "integration-secret-75d218";

const authenticationPlugin = (
  authenticate: HotUpdaterAuthenticationProvider["authenticate"],
) =>
  defineFirstPartyFeatureManifest<
    "security-auth",
    FeatureApiKind,
    Record<never, never>
  >({
    aliases: {},
    id: "security-auth",
    namespace: "security-auth",
    setup: () => ({
      authentication: { authenticate, id: "security-auth" },
    }),
    version: "1.0.0",
  });

type RoutePluginOptions = {
  readonly access: HotUpdaterRouteAccess;
  readonly handle: HotUpdaterServerRoute<unknown>["handle"];
  readonly input?: HotUpdaterServerRoute<unknown>["input"];
  readonly middleware?: readonly HotUpdaterPostAuthMiddleware[];
};

const routePlugin = (options: RoutePluginOptions) =>
  defineFirstPartyFeatureManifest<
    "security-route",
    FeatureApiKind,
    Record<never, never>
  >({
    aliases: {},
    id: "security-route",
    namespace: "security-route",
    setup: () => ({
      middleware: options.middleware,
      routes: [
        {
          access: options.access,
          handle: options.handle,
          id: "security.route",
          input: options.input,
          method: "POST",
          path: "/guarded",
        },
      ],
    }),
    version: "1.0.0",
  });

const metadataPlugin = (
  resolve: HotUpdaterVersionMetadataContribution["resolve"],
) =>
  defineFirstPartyFeatureManifest<
    "security-metadata",
    FeatureApiKind,
    Record<never, never>
  >({
    aliases: {},
    id: "security-metadata",
    namespace: "security-metadata",
    setup: () => ({
      metadata: [
        {
          keys: ["securityStable"],
          namespace: "security-metadata",
          resolve,
          target: "capabilities",
        },
      ],
    }),
    version: "1.0.0",
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("final root composer security integration", () => {
  it("returns an exact generic 503 before body, parser, or dependencies", async () => {
    // Given
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pull();
          controller.enqueue(new TextEncoder().encode(SECRET));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const parse = vi.fn(async (request: Request) => request.text());
    const database = vi.fn();
    const storage = vi.fn();
    const handle = vi.fn(async () => {
      database();
      storage();
      return new Response(SECRET);
    });
    const authenticate = vi.fn(async () => ({ kind: "unavailable" as const }));
    const hotUpdater = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [
        authenticationPlugin(authenticate),
        routePlugin({
          access: { kind: "protected" },
          handle,
          input: { parse },
        }),
      ],
    });
    const request = new Request("https://example.com/api/guarded", {
      body,
      duplex: "half",
      headers: { authorization: `Bearer ${SECRET}` },
      method: "POST",
    });

    // When
    const response = await hotUpdater.handler(request);

    // Then
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Service unavailable",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(request.bodyUsed).toBe(false);
    expect(pull).not.toHaveBeenCalled();
    expect(authenticate).toHaveBeenCalledOnce();
    expect([parse, handle, database, storage]).toSatisfy(
      (spies: readonly ReturnType<typeof vi.fn>[]) =>
        spies.every((spy) => spy.mock.calls.length === 0),
    );
  });

  it("rejects protected omission while public routes skip authentication", async () => {
    // Given
    const handle = vi.fn(async () => new Response("public"));
    const protectedManifest = routePlugin({
      access: { kind: "protected" },
      handle,
    });
    const authenticate = vi.fn(async () => {
      throw new Error(SECRET);
    });

    // When
    const construct = () =>
      createHotUpdater({
        database: createRuntimeDatabase(),
        plugins: [protectedManifest],
      });
    const publicUpdater = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [
        authenticationPlugin(authenticate),
        routePlugin({ access: { kind: "public" }, handle }),
      ],
    });
    const response = await publicUpdater.handler(
      new Request("https://example.com/api/guarded", { method: "POST" }),
    );

    // Then
    expect(construct).toThrowError(
      expect.objectContaining({
        code: "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("public");
    expect(authenticate).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledOnce();
  });

  it("keeps version bytes invariant across inbound credential variants", async () => {
    // Given
    const resolve = vi.fn(async (_signal: AbortSignal) => ({
      securityStable: true,
    }));
    const hotUpdater = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [metadataPlugin(resolve)],
    });
    const variants: readonly RequestInit["headers"][] = [
      undefined,
      { Authorization: `Bearer ${SECRET}` },
      { Cookie: `session=${SECRET}` },
      { "X-API-Key": SECRET },
    ];

    // When
    const responses = await Promise.all(
      variants.map((headers) =>
        hotUpdater.handler(
          new Request("https://example.com/api/version", { headers }),
        ),
      ),
    );
    const snapshots = await Promise.all(
      responses.map(async (response) => ({
        body: await response.text(),
        headers: [...response.headers],
        status: response.status,
      })),
    );

    // Then
    expect(
      new Set(snapshots.map((snapshot) => JSON.stringify(snapshot))),
    ).toHaveLength(1);
    expect(JSON.stringify(snapshots)).not.toContain(SECRET);
    expect(resolve).toHaveBeenCalledTimes(variants.length);
    expect(
      resolve.mock.calls.every(([signal]) => signal instanceof AbortSignal),
    ).toBe(true);
  });

  it.each(["concurrent", "sequential"] as const)(
    "fails closed when composed middleware calls next %sly",
    async (mode) => {
      // Given
      const handle = vi.fn(async () => new Response(SECRET));
      const middleware: HotUpdaterPostAuthMiddleware = {
        id: "invalid-next",
        phase: "post-auth",
        async handle(_context, next) {
          if (mode === "concurrent") {
            await Promise.all([next(), next()]);
          } else {
            await next();
            await next();
          }
          return new Response(SECRET);
        },
      };
      const hotUpdater = createHotUpdater({
        database: createRuntimeDatabase(),
        plugins: [
          routePlugin({
            access: { kind: "public" },
            handle,
            middleware: [middleware],
          }),
        ],
      });

      // When
      const response = await hotUpdater.handler(
        new Request("https://example.com/api/guarded", { method: "POST" }),
      );

      // Then
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(SECRET);
      expect(handle).toHaveBeenCalledOnce();
    },
  );
});
