import { NIL_UUID } from "@hot-updater/core";
import { extractTimestampFromUUIDv7 } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { createHandler, type HandlerAPI } from "./handler";

const createApi = () =>
  ({
    getAppUpdateInfo: vi
      .fn<HandlerAPI["getAppUpdateInfo"]>()
      .mockResolvedValue({
        fileHash: null,
        fileUrl: null,
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
      }),
    getBundleById: vi.fn<HandlerAPI["getBundleById"]>(),
    getBundles: vi.fn<HandlerAPI["getBundles"]>(),
    getChannels: vi
      .fn<HandlerAPI["getChannels"]>()
      .mockResolvedValue(["production"]),
    appendBundleEvent: vi.fn<NonNullable<HandlerAPI["appendBundleEvent"]>>(),
    insertBundle: vi.fn<HandlerAPI["insertBundle"]>(),
    updateBundleById: vi.fn<HandlerAPI["updateBundleById"]>(),
    deleteBundleById: vi.fn<HandlerAPI["deleteBundleById"]>(),
  }) satisfies HandlerAPI;

const createAppReadyEventBody = (
  overrides: Readonly<Record<string, unknown>> = {},
): string =>
  JSON.stringify({
    activeBundleId: "bundle-1",
    appVersion: "1.0.0",
    channel: "production",
    cohort: "730",
    defaultChannel: "production",
    fingerprintHash: "fingerprint-hash",
    installId: "install-1",
    isChannelSwitched: false,
    platform: "ios",
    sdkVersion: "0.31.0",
    status: "STABLE",
    ...overrides,
  });

describe("bundle event request boundary", () => {
  it("does not mount app-ready telemetry unless explicitly enabled", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, { basePath: "/api" });

    // When
    const response = await handler(
      new Request("http://localhost/api/bundle-events/app-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: createAppReadyEventBody(),
      }),
    );

    // Then
    expect(response.status).toBe(404);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies without relying on Content-Length", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/api",
      bundleEvents: { maxBodyBytes: 512 },
    });
    const request = new Request(
      "http://localhost/api/bundle-events/app-ready",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: createAppReadyEventBody({ userId: "가".repeat(512) }),
      },
    );
    expect(request.headers.get("Content-Length")).toBeNull();

    // When
    const response = await handler(request);

    // Then
    expect(response.status).toBe(413);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it.each([
    "activeBundleId",
    "previousActiveBundleId",
    "crashedBundleId",
    "installId",
    "channel",
    "appVersion",
    "fingerprintHash",
    "cohort",
    "userId",
    "defaultChannel",
    "sdkVersion",
  ])("rejects an overlong persisted %s field", async (field) => {
    // Given
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/api",
      bundleEvents: {},
    });

    // When
    const response = await handler(
      new Request("http://localhost/api/bundle-events/app-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: createAppReadyEventBody({ [field]: "x".repeat(10_000) }),
      }),
    );

    // Then
    expect(response.status).toBe(400);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      headerName: "WWW-Authenticate",
      headerValue: "Bearer",
      reason: "authentication",
      status: 401,
    },
    {
      headerName: "X-Hot-Updater-Policy",
      headerValue: "authorization",
      reason: "authorization",
      status: 403,
    },
    {
      headerName: "Retry-After",
      headerValue: "30",
      reason: "rate or quota",
      status: 429,
    },
  ])(
    "returns policy status $status and headers for $reason failures",
    async ({ headerName, headerValue, reason, status }) => {
      // Given
      const api = createApi();
      const handler = createHandler(api, {
        basePath: "/api",
        bundleEvents: {
          policy: () =>
            new Response(JSON.stringify({ error: reason }), {
              status,
              headers: { [headerName]: headerValue },
            }),
        },
      });

      // When
      const response = await handler(
        new Request("http://localhost/api/bundle-events/app-ready", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: createAppReadyEventBody(),
        }),
      );

      // Then
      expect(response.status).toBe(status);
      expect(response.headers.get(headerName)).toBe(headerValue);
      expect(api.appendBundleEvent).not.toHaveBeenCalled();
    },
  );

  it("passes the deployment context to the bundle event policy", async () => {
    // Given
    const api = createApi();
    const policy = vi.fn(() => undefined);
    const handler = createHandler<{ env: { quota: string } }>(api, {
      basePath: "/api",
      bundleEvents: { policy },
    });
    const context = { env: { quota: "tenant-a" } };
    const request = new Request(
      "http://localhost/api/bundle-events/app-ready",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: createAppReadyEventBody(),
      },
    );

    // When
    const response = await handler(request, context);

    // Then
    expect(response.status).toBe(201);
    expect(policy).toHaveBeenCalledWith(request, context);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects an invalid max body size of %s when creating the handler",
    (maxBodyBytes) => {
      expect(() =>
        createHandler(createApi(), {
          bundleEvents: { maxBodyBytes },
        }),
      ).toThrow("bundleEvents.maxBodyBytes must be a positive safe integer");
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects an invalid retention age of %s when creating the handler",
    (maxAgeMs) => {
      expect(() =>
        createHandler(createApi(), {
          bundleEvents: { retention: { maxAgeMs } },
        }),
      ).toThrow(
        "bundleEvents.retention.maxAgeMs must be a positive safe integer",
      );
    },
  );

  it("uses a stable request UUID as the existing event primary ID across retries", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/api",
      bundleEvents: {},
    });
    const eventId = "018f22e2-6f21-7b42-a91e-9893d1029f9f";
    const createRequest = () =>
      new Request("http://localhost/api/bundle-events/app-ready", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-Event-ID": eventId,
        },
        body: createAppReadyEventBody(),
      });

    // When
    const responses = await Promise.all([
      handler(createRequest()),
      handler(createRequest()),
    ]);

    // Then
    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(api.appendBundleEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: eventId }),
      {},
    );
    expect(api.appendBundleEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: eventId }),
      {},
    );
  });

  it("normalizes a request UUID before using it as the event primary ID", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/api",
      bundleEvents: {},
    });
    const eventId = "018F22E2-6F21-7B42-A91E-9893D1029F9F";

    // When
    const response = await handler(
      new Request("http://localhost/api/bundle-events/app-ready", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-Event-ID": eventId,
        },
        body: createAppReadyEventBody(),
      }),
    );

    // Then
    expect(response.status).toBe(201);
    expect(api.appendBundleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: eventId.toLowerCase() }),
      {},
    );
  });

  it("rejects a malformed request event UUID", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/api",
      bundleEvents: {},
    });

    // When
    const response = await handler(
      new Request("http://localhost/api/bundle-events/app-ready", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-Event-ID": "not-a-uuid",
        },
        body: createAppReadyEventBody(),
      }),
    );

    // Then
    expect(response.status).toBe(400);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("rejects a request event UUID whose timestamp is too far in the future", async () => {
    // Given
    const api = createApi();
    const handler = createHandler(api, {
      basePath: "/api",
      bundleEvents: { retention: { maxAgeMs: 86_400_000 } },
    });

    // When
    const response = await handler(
      new Request("http://localhost/api/bundle-events/app-ready", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-Event-ID": "ffffffff-ffff-7fff-bfff-ffffffffffff",
        },
        body: createAppReadyEventBody(),
      }),
    );

    // Then
    expect(response.status).toBe(400);
    expect(api.appendBundleEvent).not.toHaveBeenCalled();
  });

  it("deletes events before a deterministic UUIDv7 retention boundary", async () => {
    // Given
    const deleteBundleEventsBefore =
      vi.fn<
        (
          params: { readonly beforeId: string },
          context?: unknown,
        ) => Promise<void>
      >();
    const api = { ...createApi(), deleteBundleEventsBefore };
    const context = { env: { tenantId: "tenant-a" } };
    const retentionMs = 86_400_000;
    const handler = createHandler(api, {
      basePath: "/api",
      bundleEvents: { retention: { maxAgeMs: retentionMs } },
    });
    const eventId = "018f22e2-6f21-7b42-a91e-9893d1029f9f";
    const serverNow = extractTimestampFromUUIDv7(eventId) + 7 * retentionMs;
    vi.useFakeTimers();
    vi.setSystemTime(serverNow);
    const boundaryTimestamp = serverNow - retentionMs;
    const boundaryHex = boundaryTimestamp.toString(16).padStart(12, "0");
    const expectedBeforeId = `${boundaryHex.slice(0, 8)}-${boundaryHex.slice(
      8,
    )}-7000-8000-000000000000`;

    // When
    let response: Response;
    try {
      response = await handler(
        new Request("http://localhost/api/bundle-events/app-ready", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Hot-Updater-Event-ID": eventId,
          },
          body: createAppReadyEventBody(),
        }),
        context,
      );
    } finally {
      vi.useRealTimers();
    }

    // Then
    expect(response.status).toBe(201);
    expect(deleteBundleEventsBefore).toHaveBeenCalledWith(
      {
        beforeId: expectedBeforeId,
      },
      context,
    );
    const deleteOrder =
      deleteBundleEventsBefore.mock.invocationCallOrder[0] ??
      Number.MAX_SAFE_INTEGER;
    const appendOrder = api.appendBundleEvent.mock.invocationCallOrder[0] ?? -1;
    expect(deleteOrder).toBeLessThan(appendOrder);
  });
});
