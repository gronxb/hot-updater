import { describe, expect, it } from "vitest";

import type { AnalyticsProvider } from "../provider";
import { createTestProvider } from "../testing/createTestProvider";
import {
  createAnalyticsWireRuntime,
  testEventPayload,
} from "./wire.testFixtures";

const postEvent = (payload: unknown, sdkVersion?: string): Request =>
  new Request("http://localhost/hot-updater/events", {
    body: JSON.stringify(payload),
    headers:
      sdkVersion === undefined
        ? { "Content-Type": "application/json" }
        : {
            "Content-Type": "application/json",
            "Hot-Updater-SDK-Version": sdkVersion,
          },
    method: "POST",
  });

const unavailableProvider = (): AnalyticsProvider => ({
  ...createTestProvider(),
  resolveAvailability: async () => ({
    analytics: true,
    analyticsQueries: true,
    eventIngestion: false,
    mode: "dedicated",
  }),
});

describe("Analytics event ingestion wire compatibility", () => {
  it("returns 204 and forwards the normalized SDK version", async () => {
    const { provider, runtime } = createAnalyticsWireRuntime();

    const response = await runtime.handler(
      postEvent(testEventPayload, " 0.37.0 "),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(provider.appendBundleEvent).toHaveBeenCalledWith({
      ...testEventPayload,
      sdkVersion: "0.37.0",
    });
  });

  it("preserves a missing SDK version as null", async () => {
    const { provider, runtime } = createAnalyticsWireRuntime();

    const response = await runtime.handler(postEvent(testEventPayload));

    expect(response.status).toBe(204);
    expect(provider.appendBundleEvent).toHaveBeenCalledWith({
      ...testEventPayload,
      sdkVersion: null,
    });
  });

  it.each(["   ", "x".repeat(1025)])(
    "rejects invalid SDK version header %#",
    async (sdkVersion) => {
      const { provider, runtime } = createAnalyticsWireRuntime();

      const response = await runtime.handler(
        postEvent(testEventPayload, sdkVersion),
      );

      expect(response.status).toBe(400);
      expect(provider.appendBundleEvent).not.toHaveBeenCalled();
    },
  );

  it("rejects an unavailable remote route before reading the body", async () => {
    const provider = unavailableProvider();
    const { runtime } = createAnalyticsWireRuntime(provider);
    const request = new Request("http://localhost/hot-updater/events", {
      body: "{malformed",
      method: "POST",
    });

    const response = await runtime.handler(request);

    expect(response.status).toBe(404);
    expect(provider.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("keeps invalid payloads and oversized strings opaque to providers", async () => {
    const { provider, runtime } = createAnalyticsWireRuntime();

    const missingFields = await runtime.handler(
      postEvent({ type: "UPDATE_APPLIED" }),
    );
    const oversizedField = await runtime.handler(
      postEvent({ ...testEventPayload, installId: "x".repeat(1025) }),
    );

    expect(missingFields.status).toBe(400);
    await expect(missingFields.json()).resolves.toEqual({
      error: "Invalid event field: platform",
    });
    expect(oversizedField.status).toBe(400);
    expect(provider.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("returns the existing 413 response before parsing an oversized body", async () => {
    const { provider, runtime } = createAnalyticsWireRuntime();

    const response = await runtime.handler(
      postEvent({ padding: "x".repeat(17 * 1024) }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Event payload exceeds 16384 bytes",
    });
    expect(provider.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("keeps provider failures behind the kernel's opaque 500", async () => {
    const provider = createTestProvider();
    provider.appendBundleEvent = async () => {
      throw new Error("db unavailable");
    };
    const { runtime } = createAnalyticsWireRuntime(provider);

    const response = await runtime.handler(postEvent(testEventPayload));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Internal server error",
    });
  });

  it("accepts only the strict UNCHANGED shape", async () => {
    const unchanged = {
      ...testEventPayload,
      fromBundleId: null,
      type: "UNCHANGED",
      updateStrategy: null,
      userId: "Alias-B",
      username: "Alice",
    } as const;
    const { provider, runtime } = createAnalyticsWireRuntime();

    const response = await runtime.handler(postEvent(unchanged, "0.38.0"));

    expect(response.status).toBe(204);
    expect(provider.appendBundleEvent).toHaveBeenCalledWith({
      ...unchanged,
      sdkVersion: "0.38.0",
    });
  });

  it.each([
    { fromBundleId: "bundle-old" },
    { updateStrategy: "appVersion" },
    { type: "READY" },
  ])("rejects mixed UNCHANGED shape %#", async (override) => {
    const { provider, runtime } = createAnalyticsWireRuntime();
    const payload = {
      ...testEventPayload,
      fromBundleId: null,
      type: "UNCHANGED",
      updateStrategy: null,
      ...override,
    };

    const response = await runtime.handler(postEvent(payload));

    expect(response.status).toBe(400);
    expect(provider.appendBundleEvent).not.toHaveBeenCalled();
  });
});
