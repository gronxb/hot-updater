import { describe, expect, it, vi } from "vitest";

import {
  createFirebaseWebRequest,
  FIREBASE_FUNCTION_CONCURRENCY,
  FIREBASE_FUNCTION_MAX_INSTANCES,
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
  it("defers body access for request-head guards", () => {
    const source = request({ headers: { "content-length": "17" } });
    Object.defineProperty(source, "rawBody", {
      get(): never {
        throw new Error("rawBody accessed");
      },
    });

    const result = createFirebaseWebRequest(source);

    expect(result.headers.get("content-length")).toBe("17");
    expect(result.bodyUsed).toBe(false);
  });

  it("streams the Firebase body only when the kernel consumes it", async () => {
    const rawBody = new TextEncoder().encode("accepted");
    const source = request();
    const readRawBody = vi.fn(() => rawBody);
    Object.defineProperty(source, "rawBody", { get: readRawBody });

    const result = createFirebaseWebRequest(source);

    expect(readRawBody).not.toHaveBeenCalled();
    await expect(result.text()).resolves.toBe("accepted");
    expect(readRawBody).toHaveBeenCalledOnce();
  });

  it("forwards an accepted body into the Web Request", async () => {
    const result = createFirebaseWebRequest(
      request({ rawBody: new TextEncoder().encode("accepted") }),
    );

    await expect(result.text()).resolves.toBe("accepted");
  });

  it("accepts body methods when Firebase omits an empty rawBody", async () => {
    const result = createFirebaseWebRequest(request({ rawBody: undefined }));

    await expect(result.text()).resolves.toBe("");
  });

  it("does not inspect rawBody for GET requests", () => {
    const source = request({ method: "GET" });
    Object.defineProperty(source, "rawBody", {
      get(): never {
        throw new Error("rawBody accessed");
      },
    });
    const result = createFirebaseWebRequest(source);

    expect(result.body).toBeNull();
  });

  it("bounds per-instance and fleet-level body buffering", () => {
    expect(FIREBASE_FUNCTION_CONCURRENCY).toBe(10);
    expect(FIREBASE_FUNCTION_MAX_INSTANCES).toBe(10);
  });
});
