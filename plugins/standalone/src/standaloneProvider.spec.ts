import { analyticsProviderToken } from "@hot-updater/analytics/provider";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";

import { standaloneRepository } from "./standaloneRepository";

class MissingAnalyticsCapabilityError extends Error {}
class MissingAvailabilityResolverError extends Error {}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("standalone Analytics provider", () => {
  it("attaches exactly one deferred provider capability", () => {
    // Given
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    // When
    const repository = standaloneRepository({
      baseUrl: "https://trusted.example/provider",
    });

    // Then
    const contributions = getCapabilityContributions(repository);
    expect(contributions.map(({ token }) => token)).toEqual([
      analyticsProviderToken,
    ]);
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
    const repository = standaloneRepository({
      baseUrl: "https://trusted.example/provider",
    });
    const [contribution] = getCapabilityContributions(repository);
    if (contribution === undefined) throw new MissingAnalyticsCapabilityError();
    const provider = analyticsProviderToken.parse(
      contribution.create({ database: repository, storages: [] }),
    );
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
