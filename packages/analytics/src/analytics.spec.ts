import type {
  DatabaseCapabilityRuntime,
  UniversalComponentDataSource,
  UniversalComponentSchema,
} from "@hot-updater/plugin-core";
import type {
  HotUpdaterPluginSetupContext,
  HotUpdaterRouteContext,
  HotUpdaterServerRoute,
} from "@hot-updater/server/internal/first-party-plugin";
import { describe, expect, it, vi } from "vitest";

import {
  analytics,
  analyticsComponentSchema,
  ANALYTICS_EVENT_BODY_MAX_BYTES,
} from "./index";
import {
  AnalyticsScanLimitExceededError,
  AnalyticsSchemaNotReadyError,
  type AnalyticsProvider,
} from "./provider";

const provider = Object.freeze({
  mode: "dedicated",
  appendBundleEvent: vi.fn(async () => undefined),
  getBundleEventSummary: vi.fn(async () => ({ installed: 0, recovered: 0 })),
  getBundleEventAnalytics: vi.fn(async () => ({
    summary: { installed: 0, recovered: 0 },
    series: { installed: [], recovered: [] },
    cohorts: { installed: [], recovered: [] },
    recentEvents: { data: [], pagination: { total: 0, limit: 50, offset: 0 } },
  })),
  getBundleEventOverview: vi.fn(async () => ({
    trackedInstallations: 0,
    bundles: [],
  })),
  getActiveInstallationOverview: vi.fn(async (input) => ({
    asOfMs: 0,
    window: input.window,
    activeInstallations: 0,
    series: [],
    bundleSeries: [],
    bundles: [],
  })),
  searchInstallations: vi.fn(async (_query, limit, offset) => ({
    data: [],
    pagination: { total: 0, limit, offset },
  })),
  getInstallationHistory: vi.fn(async (_installId, limit, offset) => ({
    data: [],
    pagination: { total: 0, limit, offset },
  })),
} satisfies AnalyticsProvider);

const database: DatabaseCapabilityRuntime = {
  name: "unused",
  async create() {
    throw new TypeError("database must not be used by Analytics setup");
  },
  async update() {
    return null;
  },
  async delete() {},
  async count() {
    return 0;
  },
  async findOne() {
    return null;
  },
  async findMany() {
    return [];
  },
};

function setupContext(
  componentSource?: UniversalComponentDataSource,
): HotUpdaterPluginSetupContext {
  const getComponent = (schema: UniversalComponentSchema) =>
    schema === analyticsComponentSchema ? componentSource : undefined;
  return {
    database,
    capabilities: {
      get() {
        return undefined;
      },
      require() {
        throw new TypeError("missing test capability");
      },
    },
    components: {
      get: getComponent,
      require(schema) {
        const source = getComponent(schema);
        if (source === undefined) throw new TypeError("missing test component");
        return source;
      },
    },
  };
}

function isServerRoute(value: unknown): value is HotUpdaterServerRoute {
  if (typeof value !== "object" || value === null) return false;
  const access = Reflect.get(value, "access");
  return (
    typeof access === "object" &&
    access !== null &&
    (Reflect.get(access, "kind") === "public" ||
      Reflect.get(access, "kind") === "protected") &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "method") === "string" &&
    typeof Reflect.get(value, "path") === "string" &&
    typeof Reflect.get(value, "handle") === "function"
  );
}

function routesFor(
  queryAccess?: "protected" | "public",
  routeProvider: AnalyticsProvider = provider,
): readonly HotUpdaterServerRoute[] {
  const plugin = analytics({
    provider: routeProvider,
    ...(queryAccess === undefined ? {} : { queryAccess }),
  });
  const result = plugin.setup(setupContext());
  if (typeof result !== "object" || result === null) {
    throw new TypeError("invalid Analytics contribution");
  }
  const routes = Reflect.get(result, "routes");
  if (!Array.isArray(routes) || !routes.every(isServerRoute)) {
    throw new TypeError("invalid Analytics routes");
  }
  return routes;
}

describe("analytics", () => {
  it("declares component data only when no provider is explicit", () => {
    expect(analytics().schema).toBe(analyticsComponentSchema);
    expect(analytics().requires).toEqual([]);
    expect(analytics({ provider }).schema).toBeUndefined();
    expect(analytics({ provider }).requires).toEqual([]);
  });

  it("requires its canonical component source for the default provider", () => {
    expect(() => analytics().setup(setupContext())).toThrow(
      "missing test component",
    );
  });

  it("constructs the default provider from its canonical component source", () => {
    const source: UniversalComponentDataSource = {
      schema: analyticsComponentSchema,
      append: async () => undefined,
      assertReady: async () => undefined,
      orderedScan: async () => [],
    };
    const contribution = analytics().setup(setupContext(source));

    expect(contribution).toEqual(
      expect.objectContaining({
        routes: expect.arrayContaining([
          expect.objectContaining({ id: "analytics.appendBundleEvent" }),
        ]),
      }),
    );
  });

  it("publishes one public ingestion route and six protected query routes", () => {
    const routes = routesFor();

    expect(
      routes.map(({ method, path, access }) => [method, path, access.kind]),
    ).toEqual([
      ["POST", "/events", "public"],
      ["GET", "/api/bundles/:id/events/summary", "protected"],
      ["GET", "/api/bundles/:id/events/analytics", "protected"],
      ["GET", "/api/installations/overview", "protected"],
      ["GET", "/api/installations/active", "protected"],
      ["GET", "/api/installations", "protected"],
      ["GET", "/api/installations/:installId/events", "protected"],
    ]);
  });

  it("allows query routes to be explicitly public", () => {
    const routes = routesFor("public");

    expect(
      routes.slice(1).every(({ access }) => access.kind === "public"),
    ).toBe(true);
  });

  it("prevents a public capability 404 from being cached after recovery", async () => {
    let available = false;
    const dynamicProvider = Object.freeze({
      ...provider,
      async resolveAvailability() {
        return available
          ? {
              analytics: true,
              analyticsQueries: true,
              eventIngestion: true,
              mode: "dedicated",
            }
          : {
              analytics: false,
              analyticsQueries: false,
              eventIngestion: false,
            };
      },
    } satisfies AnalyticsProvider);
    const route = routesFor("public", dynamicProvider).find(
      ({ id }) => id === "analytics.getBundleEventOverview",
    );
    if (route?.input === undefined)
      throw new TypeError("missing overview route");
    const request = new Request(
      "https://example.com/api/installations/overview",
    );

    const unavailable = await route.input.parse(request);
    if (typeof unavailable !== "object" || unavailable === null) {
      throw new TypeError("invalid unavailable response");
    }
    const response = Reflect.get(unavailable, "response");
    if (!(response instanceof Response))
      throw new TypeError("missing unavailable response");

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    available = true;
    await expect(route.input.parse(request)).resolves.toMatchObject({
      kind: "input",
    });
  });

  it("returns 413 without invoking the provider when the event body exceeds 16 KiB", async () => {
    provider.appendBundleEvent.mockClear();
    const route = routesFor().find(
      ({ id }) => id === "analytics.appendBundleEvent",
    );
    if (route?.input === undefined)
      throw new TypeError("missing ingestion route");
    const request = new Request("https://example.com/api/events", {
      method: "POST",
      body: "x".repeat(ANALYTICS_EVENT_BODY_MAX_BYTES + 1),
    });

    const input = await route.input.parse(request);
    if (typeof input !== "object" || input === null) {
      throw new TypeError("invalid ingestion parser output");
    }
    const response = Reflect.get(input, "response");

    if (!(response instanceof Response))
      throw new TypeError("missing response");
    expect(response.status).toBe(413);
    expect(provider.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("returns an opaque 503 contract when Analytics schema readiness fails", async () => {
    provider.appendBundleEvent.mockRejectedValueOnce(
      new AnalyticsSchemaNotReadyError({
        componentVersion: null,
        fingerprint: "private-drift-details",
        legacyVersion: "0.38.0",
      }),
    );
    const route = routesFor().find(
      ({ id }) => id === "analytics.appendBundleEvent",
    );
    if (route?.input === undefined)
      throw new TypeError("missing ingestion route");
    const request = new Request("https://example.com/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "UNCHANGED",
        installId: "install-1",
        toBundleId: "bundle-1",
        platform: "ios",
        appVersion: "1.0.0",
        channel: "production",
        cohort: "default",
        fingerprintHash: null,
        fromBundleId: null,
        updateStrategy: null,
      }),
    });
    const input = await route.input.parse(request);
    const context: HotUpdaterRouteContext = {
      headers: new Headers(),
      principal: undefined,
      route: {
        access: { kind: "public" },
        id: route.id,
        method: route.method,
        params: {},
        pattern: route.path,
      },
      signal: request.signal,
      url: new URL(request.url),
    };

    const response = await route.handle(context, input);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "ANALYTICS_SCHEMA_NOT_READY" },
    });
  });

  it("returns a stable 503 contract when a bounded scan exceeds its limit", async () => {
    provider.getBundleEventOverview.mockRejectedValueOnce(
      new AnalyticsScanLimitExceededError(50_000),
    );
    const route = routesFor("public").find(
      ({ id }) => id === "analytics.getBundleEventOverview",
    );
    if (route?.input === undefined)
      throw new TypeError("missing overview route");
    const request = new Request(
      "https://example.com/api/installations/overview",
    );
    const input = await route.input.parse(request);
    const context: HotUpdaterRouteContext = {
      headers: new Headers(),
      principal: undefined,
      route: {
        access: { kind: "public" },
        id: route.id,
        method: route.method,
        params: {},
        pattern: route.path,
      },
      signal: request.signal,
      url: new URL(request.url),
    };

    const response = await route.handle(context, input);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: { code: "ANALYTICS_SCAN_LIMIT_EXCEEDED", limit: 50_000 },
    });
  });
});
