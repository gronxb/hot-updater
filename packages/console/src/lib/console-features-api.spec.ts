import { QueryClient } from "@tanstack/react-query";
import { isNotFound } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleFeatureSet, ConsoleFeatures } from "./console-features";
import {
  consoleFeaturesQueryKey,
  notFoundFeature,
  requireConsoleFeature,
} from "./console-features-api";
import { getConsoleFeaturesRpc } from "./console-features-rpc";

vi.mock("./console-features-rpc", () => ({ getConsoleFeaturesRpc: vi.fn() }));

const featureSet = (
  features: Partial<ConsoleFeatures>,
  remote = false,
): ConsoleFeatureSet => ({
  features: {
    insights: false,
    insightsAnalytics: false,
    apiKeys: false,
    remoteConfig: false,
    ...features,
  },
  remote,
});

const createQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(() => vi.resetAllMocks());

describe("feature route guard", () => {
  it("lets a route load while its feature is on, reading the features once", async () => {
    const served = featureSet({ insights: true, insightsAnalytics: true });
    vi.mocked(getConsoleFeaturesRpc).mockResolvedValue(served);
    const queryClient = createQueryClient();

    await expect(
      requireConsoleFeature(queryClient, "insightsAnalytics"),
    ).resolves.toBeUndefined();
    await expect(
      requireConsoleFeature(queryClient, "insights"),
    ).resolves.toBeUndefined();

    expect(getConsoleFeaturesRpc).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(consoleFeaturesQueryKey)).toEqual(served);
  });

  it.each([
    ["insights", featureSet({ apiKeys: true })],
    ["insightsAnalytics", featureSet({ insights: true }, true)],
    ["apiKeys", featureSet({ insights: true, insightsAnalytics: true })],
  ] as const)(
    "finds no %s route while the feature is off, and names the feature",
    async (feature, served) => {
      vi.mocked(getConsoleFeaturesRpc).mockResolvedValue(served);

      const thrown: unknown = await requireConsoleFeature(
        createQueryClient(),
        feature,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(isNotFound(thrown)).toBe(true);
      expect(notFoundFeature((thrown as { data?: unknown }).data)).toBe(
        feature,
      );
    },
  );

  it("lets the route load when the features cannot be read, so the root layout answers", async () => {
    vi.mocked(getConsoleFeaturesRpc).mockRejectedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    const queryClient = createQueryClient();

    await expect(
      requireConsoleFeature(queryClient, "apiKeys"),
    ).resolves.toBeUndefined();
    // A server render sends the cache to the browser and cannot serialize the
    // refusal, so the failed read is not kept.
    expect(
      queryClient.getQueryCache().find({ queryKey: consoleFeaturesQueryKey }),
    ).toBeUndefined();
  });
});

describe("notFoundFeature", () => {
  it("reads only a feature the registry holds", () => {
    expect(notFoundFeature({ feature: "apiKeys" })).toBe("apiKeys");
    expect(notFoundFeature({ feature: "billing" })).toBeUndefined();
    expect(notFoundFeature({ feature: "toString" })).toBeUndefined();
    expect(notFoundFeature("apiKeys")).toBeUndefined();
    expect(notFoundFeature(undefined)).toBeUndefined();
  });
});
