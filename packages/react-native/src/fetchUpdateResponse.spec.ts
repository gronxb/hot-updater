import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android" }));
/** React Native's AppState, whose changes the tests send. */
const appState = vi.hoisted(() => {
  type Listener = (state: string) => void;
  const listeners = new Set<Listener>();
  return {
    currentState: "active",
    listeners,
    addEventListener(_type: "change", listener: Listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    change(state: string) {
      this.currentState = state;
      for (const listener of listeners) listener(state);
    },
  };
});
vi.mock("react-native", () => ({ AppState: appState, Platform: platform }));

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

describe("fetchUpdateResponse across time in the background", () => {
  let respond: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    platform.OS = "ios";
    appState.currentState = "active";
    appState.listeners.clear();
    // The response comes when the test says it reached the app.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((resolve, reject) => {
            respond = () =>
              resolve(new Response('{"ok":true}', { status: 200 }));
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("Aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const track = <T>(promise: Promise<T>) => {
    const state = { settled: false };
    promise.then(
      () => {
        state.settled = true;
      },
      () => {
        state.settled = true;
      },
    );
    return state;
  };

  // iOS suspends an app about a second after it leaves the foreground, and
  // its timers stop with it. When the user comes back, the timer that became
  // overdue meanwhile must not abort a response that arrived while away.
  it("doesn't time out over a background period the response arrived in", async () => {
    const request = fetchUpdateResponse({
      requestTimeout: 15_000,
      resource: "artifact",
      url: "https://x.test/artifacts/v2/target/from/current",
    });
    await vi.advanceTimersByTimeAsync(500);
    appState.change("background");
    // Back after 23 s: the overdue timers run first.
    await vi.advanceTimersByTimeAsync(23_000);
    appState.change("active");
    respond();

    await expect(request).resolves.toMatchObject({ body: '{"ok":true}' });
  });

  it("times out once the foreground time before and after a background period reaches requestTimeout", async () => {
    const request = fetchUpdateResponse({
      requestTimeout: 1000,
      resource: "artifact",
      url: "https://x.test/a",
    });
    const rejected = expect(request).rejects.toThrow("Request timed out");
    const state = track(request);
    await vi.advanceTimersByTimeAsync(600);
    appState.change("background");
    await vi.advanceTimersByTimeAsync(60_000);
    appState.change("active");
    await vi.advanceTimersByTimeAsync(399);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(appState.listeners.size).toBe(0);
  });

  it("starts counting a request sent from the background once the app is back", async () => {
    appState.currentState = "background";
    const request = fetchUpdateResponse({
      requestTimeout: 1000,
      resource: "artifact",
      url: "https://x.test/a",
    });
    const rejected = expect(request).rejects.toThrow("Request timed out");
    const state = track(request);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.settled).toBe(false);
    appState.change("active");
    await vi.advanceTimersByTimeAsync(1000);

    await rejected;
  });

  // An app in the app switcher or behind Control Center still runs.
  it("keeps counting while the app is inactive", async () => {
    const request = fetchUpdateResponse({
      requestTimeout: 1000,
      resource: "artifact",
      url: "https://x.test/a",
    });
    const rejected = expect(request).rejects.toThrow("Request timed out");
    appState.change("inactive");
    await vi.advanceTimersByTimeAsync(1000);

    await rejected;
  });

  it("stops listening for app state changes once the response arrives", async () => {
    const request = fetchUpdateResponse({
      resource: "artifact",
      url: "https://x.test/a",
    });
    await vi.advanceTimersByTimeAsync(0);
    respond();
    await request;

    expect(appState.listeners.size).toBe(0);
  });
});
