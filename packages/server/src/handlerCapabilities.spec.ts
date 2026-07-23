import { describe, expect, it } from "vitest";

import { internalAnalyticsCapabilityProbe } from "./db/analyticsCapability";
import { createHandler } from "./handler";
import { createApi, testEventPayload } from "./handler.testFixtures";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

const BASE_URL = "http://localhost/hot-updater";
const ANALYTICS_METHODS = [
  "appendBundleEvent",
  "getBundleEventSummary",
  "getBundleEventAnalytics",
  "getBundleEventOverview",
  "getActiveInstallationOverview",
  "searchInstallations",
  "getInstallationHistory",
] as const;

const routeCases = [
  {
    name: "unsupported without requested queries",
    analyticsSupported: false,
    analyticsQueries: false,
  },
  {
    name: "unsupported with requested queries",
    analyticsSupported: false,
    analyticsQueries: true,
  },
  {
    name: "supported without requested queries",
    analyticsSupported: true,
    analyticsQueries: false,
  },
  {
    name: "supported with requested queries",
    analyticsSupported: true,
    analyticsQueries: true,
  },
] as const;

describe("createHandler route capabilities", () => {
  it.each(routeCases)(
    "reports only reachable Analytics routes when $name",
    async ({ analyticsSupported, analyticsQueries }) => {
      // Given
      const api = createApi();
      if (!analyticsSupported) {
        for (const method of ANALYTICS_METHODS) {
          Reflect.deleteProperty(api, method);
        }
      }
      const handler = createHandler(api, {
        basePath: "/hot-updater",
        routes: {
          updateCheck: false,
          bundles: false,
          analytics: analyticsQueries,
        },
      });

      // When
      const versionResponse = await handler(new Request(`${BASE_URL}/version`));
      const ingestionResponse = await handler(
        new Request(`${BASE_URL}/events`, { method: "POST" }),
      );
      const queryResponse = await handler(
        new Request(`${BASE_URL}/api/bundles/bundle-1/events/summary`),
      );

      // Then
      const expectedAnalyticsQueries = analyticsSupported && analyticsQueries;
      await expect(versionResponse.json()).resolves.toEqual({
        version: HOT_UPDATER_SERVER_VERSION,
        capabilities: analyticsSupported
          ? {
              analytics: true,
              mode: "dedicated",
              eventIngestion: true,
              analyticsQueries: expectedAnalyticsQueries,
            }
          : {
              analytics: false,
              eventIngestion: false,
              analyticsQueries: false,
            },
      });
      expect(ingestionResponse.status !== 404).toBe(analyticsSupported);
      expect(queryResponse.status !== 404).toBe(expectedAnalyticsQueries);
    },
  );

  it.each([
    {
      name: "only event ingestion is available upstream",
      eventIngestion: true,
      analyticsQueries: false,
    },
    {
      name: "only Analytics queries are available upstream",
      eventIngestion: false,
      analyticsQueries: true,
    },
  ] as const)(
    "honors standalone route capabilities when $name",
    async ({ eventIngestion, analyticsQueries }) => {
      // Given
      const api = createApi();
      Reflect.set(api, internalAnalyticsCapabilityProbe, async () => ({
        analytics: true,
        mode: "dedicated",
        eventIngestion,
        analyticsQueries,
      }));
      const handler = createHandler(api, {
        basePath: "/hot-updater",
        routes: {
          updateCheck: false,
          bundles: false,
          analytics: true,
        },
      });

      // When
      const versionResponse = await handler(new Request(`${BASE_URL}/version`));
      const ingestionResponse = await handler(
        new Request(`${BASE_URL}/events`, {
          method: "POST",
          body: JSON.stringify(testEventPayload),
        }),
      );
      const queryResponse = await handler(
        new Request(`${BASE_URL}/api/bundles/bundle-1/events/summary`),
      );

      // Then
      await expect(versionResponse.json()).resolves.toEqual({
        version: HOT_UPDATER_SERVER_VERSION,
        capabilities: {
          analytics: true,
          mode: "dedicated",
          eventIngestion,
          analyticsQueries,
        },
      });
      expect(ingestionResponse.status !== 404).toBe(eventIngestion);
      expect(queryResponse.status !== 404).toBe(analyticsQueries);
      expect(api.appendBundleEvent).toHaveBeenCalledTimes(
        eventIngestion ? 1 : 0,
      );
    },
  );
});
