import { createHotUpdater } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import {
  createRuntimeDatabase,
  runtimeBundle,
} from "../../server/src/runtime.testFixtures";
import { managedBetterAuthPlugin, managedRoutePolicy } from "./managed";
import { createPluginSetupContext } from "./setupContext.testFixtures";

const RAW_API_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WRONG_API_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const API_KEY_SHA256 = "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo";
const publicCoreUrls = [
  "/api/version",
  "/api/fingerprint/ios/fingerprint/production/0/builtin",
  "/api/fingerprint/ios/fingerprint/production/0/builtin/stable",
  "/api/app-version/ios/1.0.0/production/0/builtin",
  "/api/app-version/ios/1.0.0/production/0/builtin/stable",
] as const;

const request = (path: string, apiKey?: string) =>
  new Request(
    `https://example.com${path}`,
    apiKey === undefined ? undefined : { headers: { "x-api-key": apiKey } },
  );

const createManagedServer = (scope: "all" | "management") => {
  const database = createRuntimeDatabase();
  return createHotUpdater({
    database,
    plugins: [
      managedBetterAuthPlugin({ apiKeySha256: API_KEY_SHA256 }),
      managedRoutePolicy({ scope }),
    ],
    routes: { bundles: true, updateCheck: true },
  });
};

describe("managedBetterAuthPlugin", () => {
  it("contributes authentication without changing public core defaults", async () => {
    const plugin = managedBetterAuthPlugin({
      apiKeySha256: API_KEY_SHA256,
    });
    const contribution = plugin.setup(createPluginSetupContext());
    if (typeof contribution !== "object" || contribution === null) {
      throw new TypeError("invalid managed authentication contribution");
    }
    const server = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [plugin],
    });

    const responses = await Promise.all([
      server.handler(request("/api/version")),
      server.handler(request("/api/version", WRONG_API_KEY)),
    ]);

    expect(Reflect.ownKeys(contribution)).toEqual(["authentication"]);
    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
  });

  it("emits only the exact management exceptions", () => {
    const contribution = managedRoutePolicy({ scope: "management" }).setup(
      createPluginSetupContext(),
    );
    if (typeof contribution !== "object" || contribution === null) {
      throw new TypeError("invalid management policy contribution");
    }

    expect(Reflect.ownKeys(contribution)).toEqual(["routePolicy"]);
    expect(Reflect.get(contribution, "routePolicy")).toEqual({
      kind: "protect-except-core",
      routeIds: [
        "core.version",
        "core.update.fingerprint",
        "core.update.fingerprint-cohort",
        "core.update.app-version",
        "core.update.app-version-cohort",
      ],
    });
  });

  it("emits protect-all only when full protection is explicit", () => {
    const contribution = managedRoutePolicy({ scope: "all" }).setup(
      createPluginSetupContext(),
    );
    if (typeof contribution !== "object" || contribution === null) {
      throw new TypeError("invalid full policy contribution");
    }

    expect(Reflect.ownKeys(contribution)).toEqual(["routePolicy"]);
    expect(Reflect.get(contribution, "routePolicy")).toEqual({
      kind: "protect-all",
    });
  });

  it("allows a management policy without authentication when only OTA routes exist", async () => {
    const server = createHotUpdater({
      database: createRuntimeDatabase(),
      plugins: [managedRoutePolicy({ scope: "management" })],
    });

    const response = await server.handler(request("/api/version"));

    expect(response.status).toBe(200);
  });

  it("rejects management policy without authentication when bundle routes are enabled", () => {
    expect(() =>
      createHotUpdater({
        database: createRuntimeDatabase(),
        plugins: [managedRoutePolicy({ scope: "management" })],
        routes: { bundles: true, updateCheck: true },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
      }),
    );
  });

  it("rejects all-route policy without authentication", () => {
    expect(() =>
      createHotUpdater({
        database: createRuntimeDatabase(),
        plugins: [managedRoutePolicy({ scope: "all" })],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "PROTECTED_ROUTE_WITHOUT_AUTHENTICATION",
      }),
    );
  });

  it("keeps version and all four OTA selectors public under management protection", async () => {
    const server = createManagedServer("management");

    const responses = await Promise.all(
      publicCoreUrls.map((url) => server.handler(request(url))),
    );

    expect(responses.map(({ status }) => status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
  });

  it("returns the same opaque non-cacheable denial for missing and invalid keys", async () => {
    const server = createManagedServer("management");

    const responses = await Promise.all([
      server.handler(request("/api/bundles")),
      server.handler(request("/api/bundles", "not-a-key")),
      server.handler(request("/api/bundles", WRONG_API_KEY)),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => response.text()),
    );

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401]);
    expect(
      responses.map((response) => response.headers.get("cache-control")),
    ).toEqual(["private, no-store", "private, no-store", "private, no-store"]);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe('{"error":"Unauthorized"}');
  });

  it("accepts repeated and concurrent valid API-key sessions", async () => {
    const server = createManagedServer("management");
    const send = () => server.handler(request("/api/bundles", RAW_API_KEY));

    const sequential: Response[] = [];
    for (let index = 0; index < 10; index += 1) {
      sequential.push(await send());
    }
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => send()),
    );

    expect([...sequential, ...concurrent].map(({ status }) => status)).toEqual(
      Array.from({ length: 20 }, () => 200),
    );
  });

  it("authenticates before reading a denied management body", async () => {
    const server = createManagedServer("management");
    let bodyPulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyPulls += 1;
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(runtimeBundle)),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const deniedRequestInit = {
      body,
      duplex: "half",
      headers: { "content-type": "application/json" },
      method: "POST" as const,
    };
    const deniedRequest = new Request(
      "https://example.com/api/bundles",
      deniedRequestInit,
    );

    const response = await server.handler(deniedRequest);

    expect(response.status).toBe(401);
    expect(deniedRequest.bodyUsed).toBe(false);
    expect(bodyPulls).toBe(0);
    const persisted = await server.handler(
      request(`/api/bundles/${runtimeBundle.id}`, RAW_API_KEY),
    );
    expect(persisted.status).toBe(404);
  });

  it("reads and persists an authorized management body", async () => {
    const server = createManagedServer("management");
    const authorizedRequest = new Request("https://example.com/api/bundles", {
      body: JSON.stringify(runtimeBundle),
      headers: {
        "content-type": "application/json",
        "x-api-key": RAW_API_KEY,
      },
      method: "POST",
    });

    const response = await server.handler(authorizedRequest);

    expect(response.status).toBe(201);
    expect(authorizedRequest.bodyUsed).toBe(true);
    const persisted = await server.handler(
      request(`/api/bundles/${runtimeBundle.id}`, RAW_API_KEY),
    );
    expect(persisted.status).toBe(200);
    await expect(persisted.json()).resolves.toMatchObject(runtimeBundle);
  });

  it("protects OTA routes only under the explicit all scope", async () => {
    const server = createManagedServer("all");

    const denied = await Promise.all(
      [publicCoreUrls[0], publicCoreUrls[1], publicCoreUrls[3]].map((url) =>
        server.handler(request(url)),
      ),
    );
    const allowed = await Promise.all(
      [publicCoreUrls[0], publicCoreUrls[1], publicCoreUrls[3]].map((url) =>
        server.handler(request(url, RAW_API_KEY)),
      ),
    );

    expect(denied.map(({ status }) => status)).toEqual([401, 401, 401]);
    expect(allowed.map(({ status }) => status)).toEqual([200, 200, 200]);
  });

  it("authenticates a canonical API-key digest", async () => {
    const plugin = managedBetterAuthPlugin({
      apiKeySha256: API_KEY_SHA256,
    });
    const contribution = plugin.setup(createPluginSetupContext());
    if (typeof contribution !== "object" || contribution === null) {
      throw new TypeError("invalid managed authentication contribution");
    }
    const authentication = Reflect.get(contribution, "authentication");
    if (
      typeof authentication !== "object" ||
      authentication === null ||
      typeof Reflect.get(authentication, "authenticate") !== "function"
    ) {
      throw new TypeError("missing managed authentication");
    }
    const authenticate = Reflect.get(authentication, "authenticate");
    const result = await Reflect.apply(authenticate, authentication, [
      {
        headers: new Headers({ "x-api-key": RAW_API_KEY }),
        method: "GET",
        route: {
          access: { kind: "protected" },
          id: "core.bundles.list",
          method: "GET",
          params: {},
          pattern: "/api/bundles",
        },
        signal: new AbortController().signal,
        url: new URL("https://example.com/api/bundles"),
      },
    ]);

    expect(result).toEqual({
      kind: "authenticated",
      principal: {
        issuer: "better-auth",
        subject: "hot-updater-managed",
      },
    });
  });

  it.each([
    "",
    "short",
    " AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!",
  ])("rejects a non-canonical SHA-256 projection %#", (apiKeySha256) => {
    expect(() => managedBetterAuthPlugin({ apiKeySha256 })).toThrow(
      "Managed Better Auth API-key SHA-256 projection is invalid.",
    );
  });

  it.each([undefined, null, {}])(
    "rejects invalid managed options from JavaScript %#",
    (options) => {
      expect(() =>
        Reflect.apply(managedBetterAuthPlugin, undefined, [options]),
      ).toThrow("Managed Better Auth API-key SHA-256 projection is invalid.");
    },
  );

  it.each([undefined, null, {}, { scope: "unknown" }])(
    "rejects an invalid route policy scope from JavaScript %#",
    (options) => {
      expect(() =>
        Reflect.apply(managedRoutePolicy, undefined, [options]),
      ).toThrow('Managed route policy scope must be "management" or "all".');
    },
  );
});
