import type {
  HotUpdaterRouteContext,
  HotUpdaterServerRoute,
} from "@hot-updater/server/internal/first-party-plugin";
import { describe, expect, it } from "vitest";

import { AnalyticsScanLimitExceededError } from "../errors";
import type { AnalyticsProvider } from "../provider";
import { createTestProvider } from "../testing/createTestProvider";
import {
  ANALYTICS_OPERATION_NAMES,
  createAnalyticsRoutes,
  EVENT_BODY_MAX_BYTES,
} from "./operations";

class MissingTestRouteError extends Error {
  readonly name = "MissingTestRouteError";
}

const getRoute = (
  routes: readonly HotUpdaterServerRoute[],
  id: string,
): HotUpdaterServerRoute => {
  const route = routes.find((candidate) => candidate.id === id);
  if (route === undefined) throw new MissingTestRouteError();
  return route;
};

const routeContext = (
  route: HotUpdaterServerRoute,
  request: Request,
  params: Readonly<Record<string, string>> = {},
): HotUpdaterRouteContext => ({
  headers: new Headers(request.headers),
  principal: undefined,
  route: {
    access: { kind: "public" },
    id: route.id,
    method: route.method,
    params,
    pattern: route.path,
  },
  signal: request.signal,
  url: new URL(request.url),
});

const executeRoute = async (
  route: HotUpdaterServerRoute,
  request: Request,
  params?: Readonly<Record<string, string>>,
): Promise<Response> => {
  const input =
    route.input === undefined ? undefined : await route.input.parse(request);
  return route.handle(routeContext(route, request, params), input);
};

const validEvent = {
  appVersion: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprintHash: null,
  fromBundleId: "bundle-0",
  installId: "install-1",
  platform: "ios",
  toBundleId: "bundle-1",
  type: "UPDATE_APPLIED",
  updateStrategy: "appVersion",
} as const;

describe("Analytics operation registry", () => {
  it("owns the exact seven stable method/path pairs", () => {
    // Given / When
    const routes = createAnalyticsRoutes(createTestProvider(), {
      queryAccess: "public",
    });

    // Then
    expect(ANALYTICS_OPERATION_NAMES).toEqual([
      "appendBundleEvent",
      "getBundleEventSummary",
      "getBundleEventAnalytics",
      "getBundleEventOverview",
      "getActiveInstallationOverview",
      "searchInstallations",
      "getInstallationHistory",
    ]);
    expect(routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /events",
      "GET /api/bundles/:id/events/summary",
      "GET /api/bundles/:id/events/analytics",
      "GET /api/installations/overview",
      "GET /api/installations/active",
      "GET /api/installations",
      "GET /api/installations/:installId/events",
    ]);
  });

  it("declares the exact ingestion body policy and preserves SDK forwarding", async () => {
    // Given
    const provider = createTestProvider();
    const route = getRoute(
      createAnalyticsRoutes(provider, { queryAccess: "public" }),
      "analytics.appendBundleEvent",
    );
    const request = new Request("https://example.com/events", {
      body: JSON.stringify(validEvent),
      headers: { "Hot-Updater-SDK-Version": " 0.37.0 " },
      method: "POST",
    });

    // When
    const response = await executeRoute(route, request);

    // Then
    expect(route.requestPolicy).toEqual({
      maximumBodyBytes: EVENT_BODY_MAX_BYTES,
      payloadTooLargeResponse: {
        body: { error: "Event payload exceeds 16384 bytes" },
        headers: { "Content-Type": "application/json" },
        status: 413,
      },
    });
    expect(response.status).toBe(204);
    expect(provider.appendBundleEvent).toHaveBeenCalledWith({
      ...validEvent,
      sdkVersion: "0.37.0",
    });
  });

  it("returns the existing 400 body before calling the provider", async () => {
    // Given
    const provider = createTestProvider();
    const route = getRoute(
      createAnalyticsRoutes(provider, { queryAccess: "public" }),
      "analytics.appendBundleEvent",
    );
    const request = new Request("https://example.com/events", {
      body: JSON.stringify({ type: "UPDATE_APPLIED" }),
      method: "POST",
    });

    // When
    const response = await executeRoute(route, request);

    // Then
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid event field: platform",
    });
    expect(provider.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("checks remote ingestion availability before consuming the body", async () => {
    // Given
    const provider: AnalyticsProvider = {
      ...createTestProvider(),
      resolveAvailability: async () => ({
        analytics: false,
        analyticsQueries: false,
        eventIngestion: false,
      }),
    };
    const route = getRoute(
      createAnalyticsRoutes(provider, { queryAccess: "public" }),
      "analytics.appendBundleEvent",
    );
    const request = new Request("https://example.com/events", {
      body: JSON.stringify(validEvent),
      method: "POST",
    });

    // When
    const response = await executeRoute(route, request);

    // Then
    expect(response.status).toBe(404);
    expect(request.bodyUsed).toBe(false);
    expect(provider.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("forwards the existing analytics query defaults and bounds", async () => {
    // Given
    const provider = createTestProvider();
    const route = getRoute(
      createAnalyticsRoutes(provider, { queryAccess: "public" }),
      "analytics.getBundleEventAnalytics",
    );
    const request = new Request(
      "https://example.com/api/bundles/bundle-1/events/analytics",
    );

    // When
    const response = await executeRoute(route, request, { id: "bundle-1" });

    // Then
    expect(response.status).toBe(200);
    expect(provider.getBundleEventAnalytics).toHaveBeenCalledWith(
      "bundle-1",
      "24h",
      50,
      0,
    );
  });

  it("maps the bounded scan error to the existing dedicated 503 body", async () => {
    // Given
    const provider = createTestProvider();
    provider.getActiveInstallationOverview = async () => {
      throw new AnalyticsScanLimitExceededError(50_000);
    };
    const route = getRoute(
      createAnalyticsRoutes(provider, { queryAccess: "public" }),
      "analytics.getActiveInstallationOverview",
    );
    const request = new Request("https://example.com/api/installations/active");

    // When
    const response = await executeRoute(route, request);

    // Then
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "ANALYTICS_SCAN_LIMIT_EXCEEDED", limit: 50_000 },
    });
  });
});
