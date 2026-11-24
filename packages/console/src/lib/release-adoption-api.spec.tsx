import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type AdoptionRelease, recommendsRollback } from "./release-adoption";
import { useReleaseHealth } from "./release-adoption-api";
import {
  getBundleEventsRpc,
  listAdoptionReleasesRpc,
} from "./release-adoption-rpc";

vi.mock("./release-adoption-rpc", () => ({
  listAdoptionReleasesRpc: vi.fn(),
  getAdoptionReleaseRpc: vi.fn(),
  getBundleEventsRpc: vi.fn(),
}));

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };

const ARTIFACT_A = "00000000-0000-7000-8000-00000000000a";
const V3 = "00000000-0000-7000-8000-000000000003";
const V5 = "00000000-0000-7000-8000-000000000005";

/** A release of artifact A, as both are. */
const release = (
  releaseId: string,
  label: number,
  live: boolean,
): AdoptionRelease => ({
  releaseId,
  label,
  platform: "ios",
  deployedAtMs: label,
  targetAppVersion: "1.0.0",
  enabled: true,
  live,
  revision: 1,
});

/** The server's counts by release: v3 crashed for 10 of 30, v5 for none of 40. */
const COUNTS: Record<string, { LAUNCHED: number; RECOVERED: number }> = {
  [V3]: { LAUNCHED: 30, RECOVERED: 10 },
  [V5]: { LAUNCHED: 40, RECOVERED: 0 },
  // Keyed by the artifact, both releases' counts merge.
  [ARTIFACT_A]: { LAUNCHED: 70, RECOVERED: 10 },
};

describe("Release health", () => {
  afterEach(() => vi.clearAllMocks());

  it("reads each release's crashes apart when two releases serve one artifact, and recommends rolling back only the one that crashed", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // v3 served artifact A, then v5 promoted it back into the channel.
    vi.mocked(listAdoptionReleasesRpc).mockResolvedValue([
      release(V5, 5, true),
      release(V3, 3, false),
    ]);
    vi.mocked(getBundleEventsRpc).mockImplementation((async ({
      data,
    }: {
      data: Record<string, string>;
    }) => {
      const id = data.releaseId ?? data.bundleId!;
      const type = data.type as "LAUNCHED" | "RECOVERED";
      const total = COUNTS[id]![type];
      return {
        releaseId: id,
        bundleId: id,
        type,
        measuredAtMs: 0,
        points: [{ startMs: 0, events: total }],
        total,
      };
    }) as never);

    const { result } = renderHook(
      () =>
        useReleaseHealth({
          platform: "ios",
          channel: "production",
          window: "24h",
          releaseIds: [V5, V3],
          focusReleaseId: undefined,
          chart: "crashes",
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() =>
      expect(
        result.current.releases?.every(
          (bundle) => bundle.recovered !== undefined,
        ),
      ).toBe(true),
    );
    const byRelease = Object.fromEntries(
      result.current.releases!.map((bundle) => [
        bundle.release.releaseId,
        {
          launched: bundle.launched!.total,
          recovered: bundle.recovered!.total,
          recommended: recommendsRollback(
            bundle.release,
            bundle.launched!.total,
            bundle.recovered!.total,
          ),
        },
      ]),
    );
    expect(byRelease).toEqual({
      [V5]: { launched: 40, recovered: 0, recommended: false },
      [V3]: { launched: 30, recovered: 10, recommended: true },
    });
    queryClient.clear();
  });
});
