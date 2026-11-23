import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react-native", () => ({ Platform: platform }));

import { fetchUpdateResponse } from "./fetchUpdateResponse";

type FakeReply = {
  readonly status: number;
  readonly body: string;
  readonly headers?: string;
};

/**
 * React Native's XMLHttpRequest: the reply arrives as a native network event,
 * which Android delivers while the app is in the background.
 */
class FakeXMLHttpRequest {
  static replies: Array<FakeReply | "error" | "never"> = [];
  static sent: Array<{ url: string; headers: Record<string, string> }> = [];

  status = 0;
  statusText = "";
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = "";
  private headers: Record<string, string> = {};
  private responseHeaders = "";

  open(_method: string, url: string) {
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  getAllResponseHeaders() {
    return this.responseHeaders;
  }

  send() {
    FakeXMLHttpRequest.sent.push({ url: this.url, headers: this.headers });
    const reply = FakeXMLHttpRequest.replies.shift() ?? "never";
    if (reply === "never") return;
    queueMicrotask(() => {
      if (reply === "error") {
        this.onerror?.();
        return;
      }
      this.status = reply.status;
      this.responseText = reply.body;
      this.responseHeaders = reply.headers ?? "";
      this.onload?.();
    });
  }

  abort() {
    queueMicrotask(() => this.onabort?.());
  }
}

/**
 * React Native's fetch (whatwg-fetch) resolves in a `setTimeout`, and Android
 * runs no JavaScript timer while the app is in the background.
 */
const timerGatedFetch = vi.fn(
  () =>
    new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response("{}", { status: 200 })), 0);
    }),
);

const settlesWithoutTimers = async <T>(promise: Promise<T>) => {
  const pending = Symbol("pending");
  let outcome: T | typeof pending = pending;
  void promise.then(
    (value) => {
      outcome = value;
    },
    () => {},
  );
  for (let flush = 0; flush < 20; flush += 1) await Promise.resolve();
  return outcome !== pending;
};

describe("fetchUpdateResponse on Android", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    platform.OS = "android";
    FakeXMLHttpRequest.replies = [];
    FakeXMLHttpRequest.sent = [];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    vi.stubGlobal("fetch", timerGatedFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    timerGatedFetch.mockClear();
  });

  // The artifact response carries download links the server just signed.
  // Waiting for a timer would hand them to native only once the user is back.
  it("resolves while JavaScript timers are stopped", async () => {
    FakeXMLHttpRequest.replies = [{ status: 200, body: '{"ok":true}' }];

    const request = fetchUpdateResponse({
      resource: "artifact",
      url: "https://updates.example.com/artifacts/v2/target/from/current",
    });

    expect(await settlesWithoutTimers(request)).toBe(true);
    const { response, body } = await request;
    expect(response.status).toBe(200);
    expect(body).toBe('{"ok":true}');
    expect(timerGatedFetch).not.toHaveBeenCalled();
  });

  it("sends the request headers and reads the response headers in any case", async () => {
    FakeXMLHttpRequest.replies = [
      {
        status: 304,
        body: "",
        headers: 'ETag: "v2"\r\nX-Hot-Updater-Catalog: none\r\n',
      },
    ];
    const onResponse = vi.fn();

    const { response, body } = await fetchUpdateResponse({
      onResponse,
      requestHeaders: { "If-None-Match": '"v1"', "X-Key": "k" },
      resource: "catalog",
      url: "https://updates.example.com/release-catalogs/x?y=1",
    });

    expect(FakeXMLHttpRequest.sent[0]!.headers).toMatchObject({
      accept: "application/json",
      "if-none-match": '"v1"',
      "x-key": "k",
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"v2"');
    expect(response.headers.get("x-hot-updater-catalog")).toBe("none");
    expect(response.headers.get("missing")).toBeNull();
    expect(body).toBe("");
    expect(onResponse).toHaveBeenCalledWith({
      body: "",
      bodyTruncated: false,
      path: "/release-catalogs/x",
      resource: "catalog",
      status: 304,
    });
  });

  it("rejects a request that gets no response as fetch does", async () => {
    FakeXMLHttpRequest.replies = ["error"];

    await expect(
      fetchUpdateResponse({ resource: "artifact", url: "https://x.test/a" }),
    ).rejects.toMatchObject({
      message: "Network request failed",
      name: "TypeError",
    });
  });

  it("times out after requestTimeout", async () => {
    FakeXMLHttpRequest.replies = ["never"];

    const request = fetchUpdateResponse({
      requestTimeout: 1000,
      resource: "artifact",
      url: "https://x.test/a",
    });
    const rejected = expect(request).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });
});

describe("fetchUpdateResponse on iOS", () => {
  beforeEach(() => {
    platform.OS = "ios";
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // iOS keeps JavaScript timers running until it suspends the app.
  it("keeps using fetch", async () => {
    FakeXMLHttpRequest.sent = [];

    const { body } = await fetchUpdateResponse({
      resource: "artifact",
      url: "https://x.test/a",
    });

    expect(body).toBe("{}");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(FakeXMLHttpRequest.sent).toEqual([]);
  });
});

describe("fetchUpdateResponse with the fetch given to HotUpdater.init", () => {
  beforeEach(() => {
    platform.OS = "android";
    FakeXMLHttpRequest.replies = [];
    FakeXMLHttpRequest.sent = [];
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends the request with the given fetch instead of the global one or XMLHttpRequest", async () => {
    const globalFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", globalFetch);
    const customFetch = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );

    const { response, body } = await fetchUpdateResponse({
      fetch: customFetch,
      resource: "catalog",
      url: "https://updates.example.com/hot-updater/release-catalogs/x",
    });

    expect(response.status).toBe(200);
    expect(body).toBe("{}");
    expect(customFetch).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(FakeXMLHttpRequest.sent).toEqual([]);
  });

  it("aborts the given fetch and rejects with Request timed out after requestTimeout", async () => {
    vi.useFakeTimers();
    const customFetch = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            // A fetch whose abort error isn't named AbortError.
            reject(new Error("canceled")),
          );
        }),
    );

    const request = fetchUpdateResponse({
      fetch: customFetch,
      requestTimeout: 100,
      resource: "catalog",
      url: "https://updates.example.com/hot-updater/release-catalogs/x",
    });
    const assertion = expect(request).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(100);

    await assertion;
    expect(customFetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });
});
