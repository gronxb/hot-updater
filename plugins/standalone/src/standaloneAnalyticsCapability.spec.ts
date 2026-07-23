import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createAnalyticsCapabilityProbe } from "./standaloneAnalyticsCapability";
import { StandaloneDatabaseError } from "./standaloneHttp";

const BASE_URL = "http://localhost/hot-updater";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => vi.restoreAllMocks());
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
    {
      name: "event ingestion without query routes",
      capabilities: {
        analytics: true,
        mode: "dedicated",
        eventIngestion: true,
        analyticsQueries: false,
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

  it("coalesces capability discovery and refreshes the cache after 30 seconds", async () => {
    // Given
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let requestCount = 0;
    server.use(
      http.get(`${BASE_URL}/version`, () => {
        requestCount += 1;
        return HttpResponse.json({
          version: "0.0.0-test",
          capabilities: {
            analytics: true,
            mode: "dedicated",
            eventIngestion: requestCount === 1,
            analyticsQueries: false,
          },
        });
      }),
    );
    const probe = createAnalyticsCapabilityProbe({ baseUrl: BASE_URL });

    // When
    const initial = await Promise.all([probe(), probe()]);
    const cached = await probe();
    now.mockReturnValue(31_001);
    const refreshed = await probe();

    // Then
    expect(requestCount).toBe(2);
    expect(initial).toEqual([
      expect.objectContaining({ eventIngestion: true }),
      expect.objectContaining({ eventIngestion: true }),
    ]);
    expect(cached).toEqual(expect.objectContaining({ eventIngestion: true }));
    expect(refreshed).toEqual(
      expect.objectContaining({ eventIngestion: false }),
    );
  });

  it("uses a bounded stale capability and then fails closed", async () => {
    // Given
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let requestCount = 0;
    server.use(
      http.get(`${BASE_URL}/version`, () => {
        requestCount += 1;
        if (requestCount > 1) {
          return new HttpResponse(null, { status: 503 });
        }
        return HttpResponse.json({
          version: "0.0.0-test",
          capabilities: {
            analytics: true,
            mode: "dedicated",
            eventIngestion: true,
            analyticsQueries: false,
          },
        });
      }),
    );
    const probe = createAnalyticsCapabilityProbe({ baseUrl: BASE_URL });

    // When
    const initial = await probe();
    now.mockReturnValue(31_001);
    const stale = await probe();
    now.mockReturnValue(301_001);
    const expired = probe();

    // Then
    expect(initial).toEqual(expect.objectContaining({ eventIngestion: true }));
    expect(stale).toEqual(initial);
    await expect(expired).rejects.toBeInstanceOf(StandaloneDatabaseError);
    expect(requestCount).toBe(3);
  });
});
