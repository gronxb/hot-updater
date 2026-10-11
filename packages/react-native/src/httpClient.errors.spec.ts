import {
  createReleaseCatalogScopeKey,
  type UpdateHttpResponse,
} from "@hot-updater/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchUpdateResponse } from "./fetchUpdateResponse";
import { createHttpClient } from "./httpClient";

vi.mock("./catalogCacheNative", () => ({
  readNativeReleaseCatalogCache: async () => null,
  removeNativeReleaseCatalogCache: async () => {},
  writeNativeReleaseCatalogCache: async () => true,
}));

const request = async (
  resource: "catalog" | "artifact",
  onResponse?: (response: UpdateHttpResponse) => void,
) => {
  const session = await createHttpClient(
    "https://updates.example.com",
    onResponse,
  ).createSession();
  return resource === "catalog"
    ? session.fetchReleaseCatalog({
        appVersion: "1.0.0",
        channel: "production",
        fingerprintHash: null,
        platform: "ios",
        requestTimeout: 50,
        updateStrategy: "appVersion",
      })
    : session.resolveArtifact({
        currentBundleId: "current",
        requestTimeout: 50,
        targetBundleId: "target",
      });
};

describe.each(["catalog", "artifact"] as const)(
  "%s server errors",
  (resource) => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it.each([
      '{"error":"Database unavailable","requestId":"request-123"}',
      "Upstream storage is temporarily unavailable",
    ])("preserves the server response body: %s", async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(body, {
            status: 503,
            statusText: "Service Unavailable",
          }),
        ),
      );

      const onResponse = vi.fn();
      await expect(request(resource, onResponse)).rejects.toMatchObject({
        name: "UpdateHttpError",
        status: 503,
        message: "Request failed with HTTP 503 Service Unavailable",
      });
      expect(onResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          resource,
          status: 503,
          body,
          bodyTruncated: false,
        }),
      );
    });

    it("records a successful response without consuming the parser's body", async () => {
      const payload =
        resource === "catalog"
          ? {
              catalogId: "project-a",
              catalogHash: `sha256:${"a".repeat(64)}`,
              fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
              generation: 1,
              releases: [],
              rollbackReleases: [],
              schemaVersion: 1,
              scopeKey: createReleaseCatalogScopeKey({
                channelKey: "cHJvZHVjdGlvbg",
                platform: "ios",
                strategy: "APP_VERSION",
              }),
            }
          : {
              artifactProtocolVersion: 1,
              assets: {},
              manifestUrl: "https://updates.example.com/manifest.json",
              manifestFileHash: "hash",
            };
      const body = JSON.stringify(payload);
      const onResponse = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      );
      await expect(request(resource, onResponse)).resolves.toMatchObject(
        payload,
      );
      const fetchMock = vi.mocked(fetch);
      expect(
        new Headers(fetchMock.mock.calls[0]![1]?.headers).get("accept"),
      ).toBe("application/json");
      expect(onResponse).toHaveBeenCalledOnce();
      expect(onResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          resource,
          status: 200,
          body,
          bodyTruncated: false,
        }),
      );
    });

    it.each([false, true])(
      "retains HTTP status when the error body is unreadable (timeout: %s)",
      async (timeout) => {
        vi.useFakeTimers();
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_url: string, options: RequestInit) => {
            const response = new Response(null, { status: 502 });
            vi.spyOn(response, "text").mockImplementation(
              () =>
                new Promise((_, reject) => {
                  const fail = () => reject(new TypeError("Body read failed"));
                  if (timeout) options.signal!.addEventListener("abort", fail);
                  else fail();
                }),
            );
            return response;
          }),
        );
        const result = request(resource).catch((error: unknown) => error);
        await vi.runAllTimersAsync();

        expect(await result).toMatchObject({
          name: "UpdateHttpError",
          status: 502,
          message: "Request failed with HTTP 502",
        });
      },
    );

    it("times out the same way when Expo's fetch cancels on the timeout", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, options: RequestInit) =>
            new Promise((_, reject) => {
              options.signal!.addEventListener("abort", () =>
                reject(
                  new Error(
                    "fetch failed: FetchRequestCanceledException: Fetch request has been canceled (at Expo/NativeResponse.swift:63)",
                  ),
                ),
              );
            }),
        ),
      );
      const result = request(resource).catch((error: unknown) => error);
      await vi.runAllTimersAsync();

      expect(await result).toMatchObject({ message: "Request timed out" });
    });

    it("keeps the server's 404 details", async () => {
      const body = '{"error":"Bundle target was not found"}';
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(body, { status: 404 })),
      );

      const onResponse = vi.fn();
      await expect(request(resource, onResponse)).rejects.toThrow(
        "Request failed with HTTP 404",
      );
      expect(onResponse).toHaveBeenCalledWith(
        expect.objectContaining({ status: 404, body }),
      );
    });
  },
);

it("reports the request path without URL credentials or query parameters", async () => {
  const onResponse = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
  try {
    await fetchUpdateResponse({
      url: "https://user:password@updates.example.com/api/catalog?token=secret#fragment",
      resource: "catalog",
      onResponse,
    });
    expect(onResponse).toHaveBeenCalledWith({
      resource: "catalog",
      path: "/api/catalog",
      status: 200,
      body: "{}",
      bodyTruncated: false,
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
