import { analytics } from "@hot-updater/analytics";
import { createHotUpdater } from "@hot-updater/server";
import { HttpResponse, http } from "msw";
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

import { standaloneRepository } from "./standaloneRepository";

const BASE_URL = "http://localhost/hot-updater";
const requests: Array<
  Readonly<{ authorization: string | null; path: string }>
> = [];
const server = setupServer(
  http.get(`${BASE_URL}/version`, ({ request }) => {
    requests.push({
      authorization: request.headers.get("authorization"),
      path: new URL(request.url).pathname,
    });
    return HttpResponse.json({
      capabilities: {
        analytics: true,
        analyticsQueries: true,
        eventIngestion: true,
        mode: "dedicated",
      },
      version: "0.0.0-test",
    });
  }),
  http.get(
    `${BASE_URL}/api/bundles/:bundleId/events/summary`,
    ({ request }) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        path: new URL(request.url).pathname,
      });
      return HttpResponse.json({ installed: 3, recovered: 1 });
    },
  ),
);

const createRuntime = () =>
  createHotUpdater({
    database: standaloneRepository({
      baseUrl: BASE_URL,
      commonHeaders: { Authorization: "Bearer repository-token" },
    }),
    plugins: [analytics({ queryAccess: "public" })],
    routes: { bundles: false, updateCheck: false },
  });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  requests.length = 0;
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("standaloneRepository Analytics capability", () => {
  it("performs no remote work during composition", () => {
    // Given / When
    const runtime = createRuntime();

    // Then
    expect(runtime.features.analytics.status).toBe("available");
    expect(requests).toEqual([]);
  });

  it("routes Analytics operations through the repository transport", async () => {
    // Given
    const runtime = createRuntime();

    // When
    const summary =
      await runtime.features.analytics.getBundleEventSummary("bundle-1");

    // Then
    expect(summary).toEqual({ installed: 3, recovered: 1 });
    expect(requests).toEqual([
      {
        authorization: "Bearer repository-token",
        path: "/hot-updater/version",
      },
      {
        authorization: "Bearer repository-token",
        path: "/hot-updater/api/bundles/bundle-1/events/summary",
      },
    ]);
  });
});
