import { describe, expect, it } from "vitest";

import {
  createAnalyticsHandler,
  createAnalyticsHandlerApi,
} from "./handlerAnalytics.testFixtures";

const unchangedPayload = {
  type: "UNCHANGED",
  installId: "install-1",
  fromBundleId: null,
  toBundleId: "bundle-current",
  userId: "Alias-B",
  username: "Alice",
  platform: "ios",
  appVersion: "1.0.0",
  channel: "production",
  cohort: "default",
  updateStrategy: null,
  fingerprintHash: null,
};

const postEvent = (payload: unknown) =>
  new Request("http://localhost/hot-updater/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Hot-Updater-SDK-Version": "0.38.0",
    },
    body: JSON.stringify(payload),
  });

describe("POST /events UNCHANGED", () => {
  it("persists a strict UNCHANGED app-ready observation", async () => {
    // Given
    const api = createAnalyticsHandlerApi();
    const handler = createAnalyticsHandler(api);
    const context = { requestId: "unchanged-event" };

    // When
    const response = await handler(postEvent(unchangedPayload), context);

    // Then
    expect(response.status).toBe(204);
    expect(api.appendBundleEvent).toHaveBeenCalledWith(
      {
        ...unchangedPayload,
        sdkVersion: "0.38.0",
      },
      context,
    );
  });

  it.each([
    {
      name: "UNCHANGED from bundle",
      payload: { ...unchangedPayload, fromBundleId: "bundle-old" },
    },
    {
      name: "UNCHANGED strategy",
      payload: { ...unchangedPayload, updateStrategy: "appVersion" },
    },
    {
      name: "transition null from bundle",
      payload: {
        ...unchangedPayload,
        type: "UPDATE_APPLIED",
        updateStrategy: "appVersion",
      },
    },
    {
      name: "transition null strategy",
      payload: {
        ...unchangedPayload,
        type: "RECOVERED",
        fromBundleId: "bundle-failed",
      },
    },
    { name: "unknown status", payload: { ...unchangedPayload, type: "READY" } },
  ])("rejects the mixed $name shape", async ({ payload }) => {
    // Given
    const api = createAnalyticsHandlerApi();
    const handler = createAnalyticsHandler(api);

    // When
    const response = await handler(postEvent(payload));

    // Then
    expect(response.status).toBe(400);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("returns 404 before parsing a body for an incomplete capability", async () => {
    // Given
    const completeApi = createAnalyticsHandlerApi();
    const {
      getActiveInstallationOverview: _getActiveInstallationOverview,
      ...incompleteApi
    } = completeApi;
    const handler = createAnalyticsHandler(incompleteApi);
    const request = new Request("http://localhost/hot-updater/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{malformed",
    });

    // When
    const response = await handler(request);

    // Then
    expect(response.status).toBe(404);
    expect(completeApi.appendBundleEvent).not.toHaveBeenCalled();
  });
});
