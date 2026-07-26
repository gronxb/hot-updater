import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneAnalyticsProvider } from "./standaloneAnalyticsProvider";
import { standaloneRepository } from "./standaloneRepository";

class MissingAvailabilityResolverError extends Error {}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("standalone Analytics provider", () => {
  it("attaches the provider capability without remote work", () => {
    // Given
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    // When
    const config = {
      baseUrl: "https://trusted.example/provider",
    };
    const repository = standaloneRepository(config);
    const provider = createStandaloneAnalyticsProvider(config);

    // Then
    expect(getCapabilityContributions(repository)).toEqual([
      expect.objectContaining({
        create: expect.any(Function),
        token: expect.objectContaining({
          id: "hot-updater.analytics.provider@1",
        }),
      }),
    ]);
    expect(provider.mode).toBe("dedicated");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates availability cancellation to the upstream request", async () => {
    // Given
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        upstreamSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          upstreamSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const provider = createStandaloneAnalyticsProvider({
      baseUrl: "https://trusted.example/provider",
    });
    if (provider.resolveAvailability === undefined) {
      throw new MissingAvailabilityResolverError();
    }
    const controller = new AbortController();

    // When
    const availability = provider.resolveAvailability(controller.signal);
    const rejection = expect(availability).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);

    // Then
    expect(upstreamSignal?.aborted).toBe(true);
    await rejection;
  });
});
