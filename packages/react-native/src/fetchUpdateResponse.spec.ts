import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchUpdateResponse } from "./fetchUpdateResponse";

describe("fetchUpdateResponse", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends the request with the given fetch instead of the global one", async () => {
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
