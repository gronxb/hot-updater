import { describe, expect, it, vi } from "vitest";

import { internalAnalyticsCapabilityProbe } from "./db/analyticsCapability";
import { createHandler } from "./handler";
import {
  createApi,
  createManagementHandler,
  testBundle,
  testEventPayload,
} from "./handler.testFixtures";

const createEventHandler = (api: ReturnType<typeof createApi>) =>
  createHandler(api, {
    basePath: "/hot-updater",
    routes: {
      updateCheck: true,
      bundles: false,
      analytics: true,
    },
  });

describe("createHandler event ingestion", () => {
  it("mounts the events route with update-check routes", async () => {
    const api = createApi();
    const handler = createEventHandler(api);
    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-SDK-Version": " 0.37.0 ",
        },
        body: JSON.stringify(testEventPayload),
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(api.appendBundleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "UPDATE_APPLIED",
        installId: "install-1",
        toBundleId: "bundle-1",
        sdkVersion: "0.37.0",
      }),
      undefined,
    );
  });

  it("preserves a missing SDK version as null when appending an event", async () => {
    const api = createApi();
    const handler = createEventHandler(api);
    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testEventPayload),
      }),
    );

    expect(response.status).toBe(204);
    expect(api.appendBundleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ sdkVersion: null }),
      undefined,
    );
  });

  it.each(["   ", "x".repeat(1025)])(
    "returns 400 before appending an invalid SDK version header %#",
    async (sdkVersion) => {
      const api = createApi();
      const handler = createEventHandler(api);
      const response = await handler(
        new Request("http://localhost/hot-updater/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Hot-Updater-SDK-Version": sdkVersion,
          },
          body: JSON.stringify(testEventPayload),
        }),
      );

      expect(response.status).toBe(400);
      expect(api.appendBundleEvent).not.toHaveBeenCalled();
    },
  );

  it("does not mount event routes when the database omits the capability", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const {
      appendBundleEvent: _appendBundleEvent,
      getBundleEventSummary: _getBundleEventSummary,
      getBundleEventAnalytics: _getBundleEventAnalytics,
      getBundleEventOverview: _getBundleEventOverview,
      searchInstallations: _searchInstallations,
      getInstallationHistory: _getInstallationHistory,
      ...api
    } = createApi();
    api.getBundles.mockResolvedValueOnce({
      data: [],
      pagination: {
        total: 0,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 0,
      },
    });
    const handler = createManagementHandler(api);

    const appendResponse = await handler(
      new Request("http://localhost/hot-updater/events", { method: "POST" }),
    );
    const summaryResponse = await handler(
      new Request(
        "http://localhost/hot-updater/api/bundles/bundle-1/events/summary",
      ),
    );
    const bundlesResponse = await handler(
      new Request("http://localhost/hot-updater/api/bundles"),
    );

    expect(appendResponse.status).toBe(404);
    expect(summaryResponse.status).toBe(404);
    expect(bundlesResponse.status).toBe(200);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("rejects standalone ingestion before reading the body when the upstream route is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const api = createApi();
    Reflect.set(api, internalAnalyticsCapabilityProbe, async () => ({
      analytics: true,
      mode: "dedicated",
      eventIngestion: false,
      analyticsQueries: true,
    }));
    const handler = createEventHandler(api);

    const response = await handler(
      new Request("http://localhost/hot-updater/events", { method: "POST" }),
    );

    expect(response.status).toBe(404);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("returns 400 JSON for invalid event payloads", async () => {
    const api = createApi();
    const handler = createEventHandler(api);
    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "UPDATE_APPLIED" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid event field: platform",
    });
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("returns 413 before parsing an oversized event body", async () => {
    const api = createApi();
    const handler = createEventHandler(api);
    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(17 * 1024) }),
      }),
    );

    expect(response.status).toBe(413);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for oversized event string fields", async () => {
    const api = createApi();
    const handler = createEventHandler(api);
    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "UPDATE_APPLIED",
          installId: "x".repeat(1025),
          fromBundleId: "bundle-0",
          toBundleId: "bundle-1",
          platform: "ios",
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          updateStrategy: "appVersion",
          fingerprintHash: null,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("returns 500 JSON for internal event errors", async () => {
    const api = createApi();
    api.appendBundleEvent.mockRejectedValueOnce(new Error("db unavailable"));
    const handler = createEventHandler(api);
    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "RECOVERED",
          installId: "install-1",
          fromBundleId: "bundle-1",
          toBundleId: testBundle.id,
          platform: "ios",
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          updateStrategy: "appVersion",
          fingerprintHash: null,
        }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
  });

  it("does not mount event ingestion when Analytics routes are disabled", async () => {
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/hot-updater",
      routes: {
        updateCheck: false,
        bundles: false,
      },
    });
    const response = await handler(
      new Request("http://localhost/hot-updater/events", {
        method: "POST",
        body: JSON.stringify(testEventPayload),
      }),
    );

    expect(response.status).toBe(404);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });
});
