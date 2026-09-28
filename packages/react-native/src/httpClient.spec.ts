import {
  isUUIDv7,
  type ArtifactInfo,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FetchJSONResponseError } from "./fetchJSON";
import { createHttpClient, type InsightsEventParams } from "./httpClient";

const mocks = vi.hoisted(() => {
  Reflect.set(globalThis, "HotUpdater", {
    SDK_VERSION: "test-sdk-version",
  });
  return {
    fetchCatalog: vi.fn(),
    fetchJSON: vi.fn(),
  };
});

vi.mock("./releaseCatalogCache", () => ({
  fetchReleaseCatalogWithCache: mocks.fetchCatalog,
}));

vi.mock("./fetchJSON", () => ({
  FetchJSONResponseError: class FetchJSONResponseError extends Error {
    constructor(
      readonly status: number,
      statusText: string,
    ) {
      super(statusText);
    }
  },
  fetchJSON: mocks.fetchJSON,
}));

const artifact: ArtifactInfo = {
  artifactProtocolVersion: 1,
  assets: {
    "index.ios.bundle": {
      file: { url: "/storage/index.bundle.br" },
      fileHash: "bundle-hash",
    },
  },
  manifestFileHash: "manifest-hash",
  manifestUrl: "/storage/manifest.json",
  archiveUrl: "/storage/bundle.tar.br",
};

const catalog: ReleaseCatalog = {
  catalogId: "server-owned-project",
  catalogHash: `sha256:${"a".repeat(64)}`,
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  generation: 1,
  releases: [],
  schemaVersion: 1,
  scopeKey: "v1:app-version:server-owned-project:ios:cHJvZHVjdGlvbg",
};

describe("private HotUpdater HTTP client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchCatalog.mockResolvedValue(catalog);
    mocks.fetchJSON.mockResolvedValue(artifact);
  });

  it("fetches a catalog without putting its internal identity in the route", async () => {
    const session = await createHttpClient(
      "https://updates.example.com/hot-updater/",
    ).createSession();

    await expect(
      session.fetchReleaseCatalog({
        appVersion: "1.2.0",
        channel: "production",
        fingerprintHash: null,
        platform: "ios",
        updateStrategy: "appVersion",
      }),
    ).resolves.toBe(catalog);

    expect(mocks.fetchCatalog).toHaveBeenCalledWith({
      baseURL: "https://updates.example.com/hot-updater",
      expectedScope: {
        channelKey: "cHJvZHVjdGlvbg",
        platform: "ios",
        strategy: "APP_VERSION",
      },
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://updates.example.com/hot-updater/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/1.2.0",
    });
  });

  it("resolves a functional baseURL once per session and captures it for a deferred artifact", async () => {
    const resolveBaseURL = vi
      .fn()
      .mockResolvedValueOnce("https://first.example.com/hot-updater")
      .mockResolvedValueOnce("https://second.example.com/hot-updater");
    const client = createHttpClient(resolveBaseURL);
    const firstSession = await client.createSession();

    await firstSession.fetchReleaseCatalog({
      appVersion: "1.2.0",
      channel: "production",
      fingerprintHash: null,
      platform: "ios",
      updateStrategy: "appVersion",
    });
    await expect(
      firstSession.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).resolves.toEqual({
      ...artifact,
      assets: {
        "index.ios.bundle": {
          file: {
            url: "https://first.example.com/hot-updater/storage/index.bundle.br",
          },
          fileHash: "bundle-hash",
        },
      },
      manifestUrl:
        "https://first.example.com/hot-updater/storage/manifest.json",
      archiveUrl: "https://first.example.com/hot-updater/storage/bundle.tar.br",
    });

    expect(resolveBaseURL).toHaveBeenCalledOnce();
    expect(mocks.fetchJSON).toHaveBeenCalledWith({
      requestHeaders: undefined,
      requestTimeout: undefined,
      url: "https://first.example.com/hot-updater/artifacts/v1/target/from/current",
    });

    await client.createSession();
    expect(resolveBaseURL).toHaveBeenCalledTimes(2);
  });

  it("rejects non-storage relative artifact URLs", async () => {
    mocks.fetchJSON.mockResolvedValue({
      ...artifact,
      assets: {
        "index.ios.bundle": {
          file: { url: "/private/index.bundle.br" },
          fileHash: "bundle-hash",
        },
      },
    });
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toThrow("client-relative storage paths");
  });

  it("rejects a legacy artifact response", async () => {
    mocks.fetchJSON.mockResolvedValue({
      fileHash: "archive-hash",
      fileUrl: "/storage/bundle.zip",
    });
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toThrow("does not support artifact protocol 1");
  });

  it("reports an old server without the v1 endpoint explicitly", async () => {
    mocks.fetchJSON.mockRejectedValue(
      new FetchJSONResponseError(404, "Not Found"),
    );
    const session = await createHttpClient(
      "https://updates.example.com",
    ).createSession();

    await expect(
      session.resolveArtifact({
        currentBundleId: "current",
        targetBundleId: "target",
      }),
    ).rejects.toThrow("does not support artifact protocol 1");
  });

  it("requires a functional baseURL to resolve to a non-empty string", async () => {
    await expect(createHttpClient(() => "").createSession()).rejects.toThrow(
      "baseURL function must return a non-empty string",
    );
  });
});

const unchangedEvent: InsightsEventParams = {
  appVersion: "1.0.0",
  channel: "production",
  cohort: "123",
  fingerprintHash: null,
  fromBundleId: null,
  installId: "install-id",
  platform: "ios",
  toBundleId: "bundle-id",
  type: "UNCHANGED",
  updateStrategy: null,
};

/** Answers each POST /events with the next response, then 204. */
const stubEventsEndpoint = (...responses: (number | Response | Error)[]) => {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    const next = responses.shift() ?? 204;
    if (next instanceof Error) throw next;
    return typeof next === "number"
      ? new Response(null, { status: next })
      : next;
  });
  vi.stubGlobal("fetch", fetchMock);
  const sentEvents = () =>
    fetchMock.mock.calls.map(
      ([, request]) =>
        JSON.parse(String(request?.body)) as {
          eventId: string;
          type: string;
        },
    );
  return { fetchMock, sentEvents };
};

describe("Insights event delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // No jitter: the first retry waits exactly 1 s and the second 2 s.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const createSession = () =>
    createHttpClient("https://updates.example.com").createSession();

  it("retries a 503 in the background under the same UUIDv7 eventId", async () => {
    const { fetchMock, sentEvents } = stubEventsEndpoint(503, 204);
    const session = await createSession();

    // Settles after the failed first attempt, without waiting for the retry.
    await session.sendInsightsEvent(unchangedEvent);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = sentEvents();
    expect(isUUIDv7(first?.eventId)).toBe(true);
    expect(second?.eventId).toBe(first?.eventId);
  });

  it("waits for a 429's Retry-After before the next attempt", async () => {
    const { fetchMock } = stubEventsEndpoint(
      new Response(null, { headers: { "Retry-After": "7" }, status: 429 }),
    );
    const session = await createSession();

    await session.sendInsightsEvent(unchangedEvent);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps a server's Retry-After at 30 seconds", async () => {
    const { fetchMock } = stubEventsEndpoint(
      new Response(null, { headers: { "Retry-After": "3600" }, status: 503 }),
    );
    const session = await createSession();

    await session.sendInsightsEvent(unchangedEvent);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400", async () => {
    const { fetchMock } = stubEventsEndpoint(400);
    const session = await createSession();

    await expect(session.sendInsightsEvent(unchangedEvent)).rejects.toThrow(
      "Expected HTTP 204 from /events, received 400",
    );
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops after three attempts and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchMock } = stubEventsEndpoint(
      500,
      new Error("network unavailable"),
      503,
    );
    const session = await createSession();

    await session.sendInsightsEvent(unchangedEvent);
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[HotUpdater] Insights UNCHANGED event was not delivered:",
      expect.objectContaining({
        message: "Expected HTTP 204 from /events, received 503",
      }),
    );
  });

  it("gives each attempt its own timeout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>(
      (_input, request) =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const session = await createSession();

    const sent = session.sendInsightsEvent({
      ...unchangedEvent,
      requestTimeout: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    // The second attempt starts after a 1 s backoff and gets a full 2 s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondSignal = fetchMock.mock.calls[1]?.[1]?.signal;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(secondSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(secondSignal?.aborted).toBe(true);
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[HotUpdater] Insights UNCHANGED event was not delivered:",
      expect.objectContaining({ message: "Request timed out" }),
    );
  });

  it("sends a later event after an earlier event's retries without holding its caller", async () => {
    const { fetchMock, sentEvents } = stubEventsEndpoint(503);
    const session = await createSession();

    await session.sendInsightsEvent(unchangedEvent);
    await session.sendInsightsEvent({
      ...unchangedEvent,
      fromBundleId: "bundle-id",
      toBundleId: "next-bundle-id",
      type: "UPDATE_DOWNLOADED",
      updateStrategy: "appVersion",
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.runAllTimersAsync();
    const [first, retry, later] = sentEvents();
    expect([first?.type, retry?.type, later?.type]).toEqual([
      "UNCHANGED",
      "UNCHANGED",
      "UPDATE_DOWNLOADED",
    ]);
    expect(retry?.eventId).toBe(first?.eventId);
    expect(later?.eventId).not.toBe(first?.eventId);
  });

  it("keeps sending events after one fails outside its requests", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("console unavailable");
    });
    const { fetchMock, sentEvents } = stubEventsEndpoint(500, 500, 500);
    const session = await createSession();

    await session.sendInsightsEvent(unchangedEvent);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // A queue left rejected would never send this event or settle its caller.
    await session.sendInsightsEvent({
      ...unchangedEvent,
      fromBundleId: "bundle-id",
      toBundleId: "next-bundle-id",
      type: "UPDATE_DOWNLOADED",
      updateStrategy: "appVersion",
    });
    expect(sentEvents().map(({ type }) => type)).toEqual([
      "UNCHANGED",
      "UNCHANGED",
      "UNCHANGED",
      "UPDATE_DOWNLOADED",
    ]);
  });
});
