import { describe, expect, it, vi } from "vitest";

import {
  createFirebaseWebRequest,
  FIREBASE_FUNCTION_CONCURRENCY,
  FIREBASE_FUNCTION_MAX_INSTANCES,
  sendFirebasePayloadTooLarge,
} from "./requestAdapter";

const request = (
  overrides: Partial<Parameters<typeof createFirebaseWebRequest>[0]> = {},
) => ({
  headers: {},
  hostname: "example.com",
  method: "POST",
  originalUrl: "/api/check-update/events",
  rawBody: new Uint8Array(),
  url: "/api/check-update/events",
  ...overrides,
});

describe("Firebase request adapter", () => {
  it("rejects an oversized declared body without reading rawBody", () => {
    const source = request({ headers: { "content-length": "17" } });
    Object.defineProperty(source, "rawBody", {
      get(): never {
        throw new Error("rawBody accessed");
      },
    });

    expect(createFirebaseWebRequest(source, 16)).toEqual({
      kind: "payload-too-large",
    });
  });

  it("rejects an oversized body without constructing a Request", () => {
    const requestConstructor = vi.spyOn(globalThis, "Request");
    try {
      expect(
        createFirebaseWebRequest(
          request({
            headers: { "transfer-encoding": "chunked" },
            rawBody: new Uint8Array(17),
          }),
          16,
        ),
      ).toEqual({ kind: "payload-too-large" });
      expect(requestConstructor).not.toHaveBeenCalled();
    } finally {
      requestConstructor.mockRestore();
    }
  });

  it("copies a bounded accepted body into the Web Request", async () => {
    const result = createFirebaseWebRequest(
      request({ rawBody: new TextEncoder().encode("accepted") }),
      16,
    );

    expect(result.kind).toBe("request");
    if (result.kind !== "request") return;
    await expect(result.request.text()).resolves.toBe("accepted");
  });

  it("accepts body methods when Firebase omits an empty rawBody", async () => {
    const result = createFirebaseWebRequest(
      request({ rawBody: undefined }),
      16,
    );

    expect(result.kind).toBe("request");
    if (result.kind !== "request") return;
    await expect(result.request.text()).resolves.toBe("");
  });

  it("does not inspect rawBody for GET requests", () => {
    const source = request({ method: "GET" });
    Object.defineProperty(source, "rawBody", {
      get(): never {
        throw new Error("rawBody accessed");
      },
    });
    const result = createFirebaseWebRequest(source, 16);

    expect(result.kind).toBe("request");
  });

  it("returns an opaque no-store 413 response", () => {
    const response = {
      send: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn(),
    };
    response.status.mockReturnValue(response);

    sendFirebasePayloadTooLarge(response);

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store",
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json",
    );
    expect(response.send).toHaveBeenCalledWith(
      JSON.stringify({ error: "Request payload too large" }),
    );
  });

  it("bounds per-instance and fleet-level body buffering", () => {
    expect(FIREBASE_FUNCTION_CONCURRENCY).toBe(10);
    expect(FIREBASE_FUNCTION_MAX_INSTANCES).toBe(10);
  });
});
