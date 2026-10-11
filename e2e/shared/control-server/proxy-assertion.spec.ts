import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ControlEndpointError,
  createControlClient,
} from "../control-client.ts";

// No provider or device is needed to exercise the HTTP assertion boundary.
vi.mock("../published.ts", () => ({
  importPublished: async () => ({}),
  publishedBin: () => "/unused/hot-updater",
}));

beforeEach(() => {
  vi.stubEnv("HOT_UPDATER_E2E_PLATFORM", "ios");
  vi.stubEnv("HOT_UPDATER_E2E_APP_ID", "app.example");
  vi.stubEnv("HOT_UPDATER_E2E_DEVICE_ID", "leased-device");
  vi.stubEnv("HOT_UPDATER_E2E_RESULTS_DIR", "/unused/results");
  vi.stubEnv("HOT_UPDATER_E2E_APP_BASE_URL", "http://provider/hot-updater");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("proxy assertion HTTP completion", () => {
  it("reports the extra catalog request while allowing a failed attempt to drain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const app = (await import("./routes.ts")).default;
    for (const kind of [
      "catalog",
      "catalog",
      "artifact",
      "catalog",
      "artifact",
    ]) {
      const path = kind === "catalog" ? "release-catalogs" : "artifacts";
      expect((await app.request(`/hot-updater/${path}/fixture`)).status).toBe(
        204,
      );
    }
    const client = createControlClient({
      baseUrl: "http://control",
      fetch: (url, init) => app.request(url, init),
    });

    const failure = await client
      .postJson("assert retry transport", "/e2e/assert-proxy", {
        artifactFailuresRemaining: 0,
        artifactRequests: 2,
        catalogRequests: 2,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ControlEndpointError);
    expect(failure).toMatchObject({ status: 422 });
    expect(JSON.parse((failure as ControlEndpointError).body)).toEqual({
      error: "Unexpected catalog request count",
      details: {
        expected: 2,
        observed: {
          artifactFailuresRemaining: 0,
          pathCardinality: 2,
          requestCounts: { artifact: 2, catalog: 3, other: 0 },
        },
      },
    });
    await expect(client.cancelAndDrain()).resolves.toBeUndefined();
  });

  it("still quarantines an unexpected server failure", async () => {
    const controller = await import("./controller.ts");
    vi.spyOn(controller, "handleAssertProxy").mockImplementation(() => {
      throw new Error("unexpected server failure");
    });
    const app = (await import("./routes.ts")).default;
    const client = createControlClient({
      baseUrl: "http://control",
      fetch: (url, init) => app.request(url, init),
    });

    await expect(
      client.postJson("assert proxy", "/e2e/assert-proxy", {}),
    ).rejects.toMatchObject({ status: 500 });
    await expect(client.cancelAndDrain()).rejects.toMatchObject({
      quarantineRequired: true,
      message: expect.stringContaining("unexpected server failure"),
    });
  });
});
