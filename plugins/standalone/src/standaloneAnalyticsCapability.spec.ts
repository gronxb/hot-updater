import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAnalyticsCapabilityProbe } from "./standaloneAnalyticsCapability";
import { StandaloneDatabaseError } from "./standaloneHttp";

const BASE_URL = "http://localhost/hot-updater";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

describe("createAnalyticsCapabilityProbe", () => {
  it.each([
    {
      name: "dedicated query routes",
      capabilities: {
        analytics: true,
        mode: "dedicated",
        eventIngestion: false,
        analyticsQueries: true,
      },
    },
    {
      name: "bounded query routes",
      capabilities: {
        analytics: true,
        mode: "bounded",
        maxMatchingRows: 50_000,
        eventIngestion: true,
        analyticsQueries: true,
      },
    },
  ] as const)("preserves $name", async ({ capabilities }) => {
    // Given
    server.use(
      http.get(`${BASE_URL}/version`, () =>
        HttpResponse.json({ version: "0.0.0-test", capabilities }),
      ),
    );

    // When
    const result = createAnalyticsCapabilityProbe({ baseUrl: BASE_URL })();

    // Then
    await expect(result).resolves.toEqual(capabilities);
  });

  it.each([
    {
      name: "query routes are not mounted",
      capabilities: {
        analytics: true,
        mode: "dedicated",
        eventIngestion: true,
        analyticsQueries: false,
      },
    },
    {
      name: "the server returns the legacy structural shape",
      capabilities: { analytics: true, mode: "dedicated" },
    },
    {
      name: "capabilities are absent",
      capabilities: undefined,
    },
  ] as const)("reports unavailable when $name", async ({ capabilities }) => {
    // Given
    server.use(
      http.get(`${BASE_URL}/version`, () =>
        HttpResponse.json({
          version: "0.0.0-test",
          ...(capabilities === undefined ? {} : { capabilities }),
        }),
      ),
    );

    // When
    const result = createAnalyticsCapabilityProbe({ baseUrl: BASE_URL })();

    // Then
    await expect(result).resolves.toEqual({
      analytics: false,
      eventIngestion: false,
      analyticsQueries: false,
    });
  });

  it("rejects a partially route-aware capability response", async () => {
    // Given
    server.use(
      http.get(`${BASE_URL}/version`, () =>
        HttpResponse.json({
          version: "0.0.0-test",
          capabilities: {
            analytics: true,
            mode: "dedicated",
            analyticsQueries: true,
          },
        }),
      ),
    );

    // When
    const result = createAnalyticsCapabilityProbe({ baseUrl: BASE_URL })();

    // Then
    await expect(result).rejects.toEqual(
      new StandaloneDatabaseError(
        "invalid-response",
        "Invalid server version response.",
        200,
      ),
    );
  });
});
