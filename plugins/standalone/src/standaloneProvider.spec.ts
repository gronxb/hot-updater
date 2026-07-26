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

  it("isolates availability cancellation from the shared upstream request", async () => {
    // Given
    let upstreamSignal: AbortSignal | undefined;
    let resolveResponse: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        upstreamSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveResponse = resolve;
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
    controller.abort();

    // Then
    await expect(availability).rejects.toMatchObject({ name: "AbortError" });
    expect(upstreamSignal?.aborted).toBe(false);
    resolveResponse?.(
      Response.json({
        version: "0.0.0-test",
        capabilities: {
          analytics: true,
          mode: "dedicated",
          eventIngestion: true,
          analyticsQueries: true,
        },
      }),
    );
    await expect(
      provider.resolveAvailability(new AbortController().signal),
    ).resolves.toMatchObject({ analytics: true });
  });
});
