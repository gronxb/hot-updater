import { HOT_UPDATER_SERVER_VERSION } from "@hot-updater/server";
import { describe, expect, it } from "vitest";

import { createTestProvider } from "../testing/createTestProvider";
import {
  createAnalyticsWireRuntime,
  createUnavailableAnalyticsWireRuntime,
  testEventPayload,
} from "./wire.testFixtures";

const BASE_URL = "http://localhost/hot-updater";

describe("Analytics capability wire compatibility", () => {
  it("reports the installed dedicated feature and reachable routes", async () => {
    const { runtime } = createAnalyticsWireRuntime();

    const versionResponse = await runtime.handler(
      new Request(`${BASE_URL}/version`),
    );
    const ingestionResponse = await runtime.handler(
      new Request(`${BASE_URL}/events`, {
        body: JSON.stringify(testEventPayload),
        method: "POST",
      }),
    );
    const queryResponse = await runtime.handler(
      new Request(`${BASE_URL}/api/bundles/bundle-1/events/summary`),
    );

    await expect(versionResponse.json()).resolves.toEqual({
      capabilities: {
        analytics: true,
        analyticsQueries: true,
        eventIngestion: true,
        mode: "dedicated",
      },
      version: HOT_UPDATER_SERVER_VERSION,
    });
    expect(ingestionResponse.status).toBe(204);
    expect(queryResponse.status).toBe(200);
  });

  it("reports the warn-mode missing capability and mounts no routes", async () => {
    const runtime = createUnavailableAnalyticsWireRuntime();

    const versionResponse = await runtime.handler(
      new Request(`${BASE_URL}/version`),
    );
    const ingestionResponse = await runtime.handler(
      new Request(`${BASE_URL}/events`, { method: "POST" }),
    );
    const queryResponse = await runtime.handler(
      new Request(`${BASE_URL}/api/bundles/bundle-1/events/summary`),
    );

    await expect(versionResponse.json()).resolves.toEqual({
      capabilities: {
        analytics: false,
        analyticsQueries: false,
        eventIngestion: false,
      },
      version: HOT_UPDATER_SERVER_VERSION,
    });
    expect(runtime.features.analytics).toEqual({
      reason: "missing-provider-capability",
      status: "unavailable",
    });
    expect(ingestionResponse.status).toBe(404);
    expect(queryResponse.status).toBe(404);
  });

  it.each([
    {
      analyticsQueries: false,
      eventIngestion: true,
      name: "only ingestion",
    },
    {
      analyticsQueries: true,
      eventIngestion: false,
      name: "only queries",
    },
  ] as const)(
    "honors remote reachability when $name is available",
    async ({ analyticsQueries, eventIngestion }) => {
      const provider = {
        ...createTestProvider(),
        resolveAvailability: async () => ({
          analytics: true as const,
          analyticsQueries,
          eventIngestion,
          mode: "dedicated" as const,
        }),
      };
      const { runtime } = createAnalyticsWireRuntime(provider);

      const versionResponse = await runtime.handler(
        new Request(`${BASE_URL}/version`),
      );
      const ingestionResponse = await runtime.handler(
        new Request(`${BASE_URL}/events`, {
          body: JSON.stringify(testEventPayload),
          method: "POST",
        }),
      );
      const queryResponse = await runtime.handler(
        new Request(`${BASE_URL}/api/bundles/bundle-1/events/summary`),
      );

      await expect(versionResponse.json()).resolves.toEqual({
        capabilities: {
          analytics: true,
          analyticsQueries,
          eventIngestion,
          mode: "dedicated",
        },
        version: HOT_UPDATER_SERVER_VERSION,
      });
      expect(ingestionResponse.status !== 404).toBe(eventIngestion);
      expect(queryResponse.status !== 404).toBe(analyticsQueries);
      expect(provider.appendBundleEvent).toHaveBeenCalledTimes(
        eventIngestion ? 1 : 0,
      );
    },
  );
});
