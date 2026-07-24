import { analyticsProviderToken } from "@hot-updater/analytics/provider";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  StandaloneDatabaseError,
  standaloneRepository,
} from "./standaloneRepository";

const BASE_URL = "http://localhost/hot-updater";
const overview = {
  asOfMs: 1_721_224_800_000,
  window: "7d" as const,
  activeInstallations: 2,
  series: [{ bucketStartMs: 1_721_138_400_000, value: 2 }],
  bundleSeries: [
    {
      bundleId: "bundle-a",
      series: [{ bucketStartMs: 1_721_138_400_000, value: 2 }],
    },
  ],
  bundles: [{ bundleId: "bundle-a", installations: 2 }],
};

let responseBody: JsonBodyType = overview;
let responseStatus = 200;
let requestCount = 0;
let requestedUrl: URL | undefined;
let requestedHeaders: Headers | undefined;

const server = setupServer(
  http.get(`${BASE_URL}/api/installations/active`, ({ request }) => {
    requestCount += 1;
    requestedUrl = new URL(request.url);
    requestedHeaders = request.headers;
    return HttpResponse.json(responseBody, { status: responseStatus });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  responseBody = overview;
  responseStatus = 200;
  requestCount = 0;
  requestedUrl = undefined;
  requestedHeaders = undefined;
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const activeService = () => {
  const repository = standaloneRepository({
    baseUrl: BASE_URL,
    commonHeaders: { Authorization: "Bearer common" },
    routes: {
      activeInstallationOverview: () => ({
        path: "/api/installations/active",
        headers: {
          "X-Request-Id": "request-1",
          "X-Route": "active",
        },
      }),
    },
  });
  const [contribution] = getCapabilityContributions(repository);
  if (contribution === undefined) {
    throw new Error("Missing standalone Analytics provider.");
  }
  return analyticsProviderToken.parse(
    contribution.create({ database: repository, storages: [] }),
  );
};

describe("standalone active installation Analytics", () => {
  it("delegates the normalized exact alias with complete capability", async () => {
    const service = activeService();
    await expect(
      service.getActiveInstallationOverview({
        window: "7d",
        userId: "  Alias /+?  ",
      }),
    ).resolves.toEqual(overview);

    expect(requestedUrl?.searchParams.get("window")).toBe("7d");
    expect(requestedUrl?.searchParams.get("userId")).toBe("Alias /+?");
    expect(requestedUrl?.href).toContain("userId=Alias+%2F%2B%3F");
    expect(requestedHeaders?.get("authorization")).toBe("Bearer common");
    expect(requestedHeaders?.get("x-request-id")).toBe("request-1");
    expect(requestedHeaders?.get("x-route")).toBe("active");
    expect(Object.keys(service).sort()).toEqual([
      "appendBundleEvent",
      "getActiveInstallationOverview",
      "getBundleEventAnalytics",
      "getBundleEventOverview",
      "getBundleEventSummary",
      "getInstallationHistory",
      "mode",
      "resolveAvailability",
      "searchInstallations",
    ]);
  });

  it("omits a userId that normalizes to empty", async () => {
    await activeService().getActiveInstallationOverview({
      window: "7d",
      userId: "   ",
    });

    expect(requestedUrl?.searchParams.get("window")).toBe("7d");
    expect(requestedUrl?.searchParams.has("userId")).toBe(false);
  });

  it.each([
    {},
    { ...overview, asOfMs: Number.NaN },
    { ...overview, window: "30d" },
    { ...overview, activeInstallations: -1 },
    { ...overview, series: [{ bucketStartMs: 1, value: -1 }] },
    { ...overview, bundleSeries: undefined },
    {
      ...overview,
      bundleSeries: [
        {
          bundleId: "bundle-a",
          series: [{ bucketStartMs: 1_721_138_400_000, value: -1 }],
        },
      ],
    },
    { ...overview, bundles: [{ bundleId: "bundle-a", installations: 1 }] },
  ])("rejects malformed active responses %#", async (invalid) => {
    responseBody = invalid;

    await expect(
      activeService().getActiveInstallationOverview({ window: "7d" }),
    ).rejects.toEqual(
      new StandaloneDatabaseError(
        "invalid-response",
        "Invalid active installation overview response.",
        200,
      ),
    );
  });

  it.each([404, 500])("keeps a %i remote failure opaque", async (status) => {
    responseStatus = status;
    responseBody = { error: `remote-${status}` };

    await expect(
      activeService().getActiveInstallationOverview({ window: "24h" }),
    ).rejects.toEqual(
      new StandaloneDatabaseError(
        "request-failed",
        `Database request failed with status ${status}.`,
        status,
      ),
    );
  });

  it("rejects an empty non-JSON response", async () => {
    server.use(
      http.get(`${BASE_URL}/api/installations/active`, () =>
        HttpResponse.text("", { status: 200 }),
      ),
    );

    await expect(
      activeService().getActiveInstallationOverview({ window: "24h" }),
    ).rejects.toEqual(
      new StandaloneDatabaseError(
        "invalid-response",
        "Database response must contain JSON.",
        200,
      ),
    );
  });

  it.each([
    [{ window: "all" }, "Invalid active installation window."],
    [
      { window: "24h", userId: "a".repeat(1025) },
      "Invalid active installation userId.",
    ],
  ])("rejects invalid input without requesting", async (input, message) => {
    await expect(
      activeService().getActiveInstallationOverview(input as never),
    ).rejects.toEqual(new TypeError(message as string));
    expect(requestCount).toBe(0);
  });

  it("does not require a public Analytics support option", () => {
    const repository = standaloneRepository({
      baseUrl: BASE_URL,
    });

    expect(
      getCapabilityContributions(repository).map(({ token }) => token.id),
    ).toEqual(["analytics-provider@1"]);
    expect(requestCount).toBe(0);
  });
});
