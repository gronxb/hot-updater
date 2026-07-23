import { describe, expect, it } from "vitest";

import { createHandler } from "./handler";
import { createApi } from "./handler.testFixtures";
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
    name: "unsupported without requested routes",
    analyticsSupported: false,
    eventIngestion: false,
    analyticsQueries: false,
  },
  {
    name: "unsupported with requested ingestion",
    analyticsSupported: false,
    eventIngestion: true,
    analyticsQueries: false,
  },
  {
    name: "unsupported with requested queries",
    analyticsSupported: false,
    eventIngestion: false,
    analyticsQueries: true,
  },
  {
    name: "unsupported with all requested routes",
    analyticsSupported: false,
    eventIngestion: true,
    analyticsQueries: true,
  },
  {
    name: "supported without requested routes",
    analyticsSupported: true,
    eventIngestion: false,
    analyticsQueries: false,
  },
  {
    name: "supported with requested ingestion",
    analyticsSupported: true,
    eventIngestion: true,
    analyticsQueries: false,
  },
  {
    name: "supported with requested queries",
    analyticsSupported: true,
    eventIngestion: false,
    analyticsQueries: true,
  },
  {
    name: "supported with all requested routes",
    analyticsSupported: true,
    eventIngestion: true,
    analyticsQueries: true,
  },
] as const;

describe("createHandler route capabilities", () => {
  it.each(routeCases)(
    "reports only reachable Analytics routes when $name",
    async ({ analyticsSupported, eventIngestion, analyticsQueries }) => {
      // Given
      const api = createApi();
      if (!analyticsSupported) {
        for (const method of ANALYTICS_METHODS) {
          Reflect.deleteProperty(api, method);
        }
      }
      const handler = createHandler(api, {
        basePath: "/hot-updater",
        ...(eventIngestion
          ? { eventIngestion: { authorize: () => false } }
          : {}),
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
      const expectedEventIngestion = analyticsSupported && eventIngestion;
      const expectedAnalyticsQueries = analyticsSupported && analyticsQueries;
      await expect(versionResponse.json()).resolves.toEqual({
        version: HOT_UPDATER_SERVER_VERSION,
        capabilities: analyticsSupported
          ? {
              analytics: true,
              mode: "dedicated",
              eventIngestion: expectedEventIngestion,
              analyticsQueries: expectedAnalyticsQueries,
            }
          : {
              analytics: false,
              eventIngestion: false,
              analyticsQueries: false,
            },
      });
      expect(ingestionResponse.status !== 404).toBe(expectedEventIngestion);
      expect(queryResponse.status !== 404).toBe(expectedAnalyticsQueries);
    },
  );
});
