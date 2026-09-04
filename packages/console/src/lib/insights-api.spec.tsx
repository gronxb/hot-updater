import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  type InsightsCapabilityState,
  ensureInsightsRouteAccess,
  getActiveInstallationQueryOptions,
  getInsightsCapabilityState,
  getInsightsCapabilitiesQueryOptions,
  getInsightsOverviewQueryOptions,
  getProtectedInsightsRouteDecision,
  isInsightsQueryEnabled,
  useActiveInstallationQuery,
  useInsightsOverviewQuery,
} from "./insights-api";
import {
  getActiveInstallationOverviewRpc,
  getInsightsCapabilitiesRpc,
  getInsightsOverviewRpc,
} from "./insights-rpc";

vi.mock("./insights-rpc", () => ({
  getActiveInstallationOverviewRpc: vi.fn(),
  getInsightsCapabilitiesRpc: vi.fn(),
  getInsightsOverviewRpc: vi.fn(),
}));

describe("insights capability gating", () => {
  it.each([
    {
      name: "unresolved",
      input: { status: "pending" as const },
      state: "unresolved",
      decision: "loading",
      enabled: false,
    },
    {
      name: "unsupported",
      input: {
        status: "success" as const,
        data: { capabilities: { insights: false as const } },
      },
      state: "unsupported",
      decision: "redirect",
      enabled: false,
    },
    {
      name: "supported",
      input: {
        status: "success" as const,
        data: {
          capabilities: {
            insights: true as const,
            mode: "bounded" as const,
            maxMatchingRows: 50_000,
          },
        },
      },
      state: "supported",
      decision: "allow",
      enabled: true,
    },
    {
      name: "error",
      input: { status: "error" as const, error: new Error("offline") },
      state: "error",
      decision: "error",
      enabled: false,
    },
  ])(
    "keeps protected queries disabled for the $name state unless supported",
    ({ input, state, decision, enabled }) => {
      // Given / When
      const capability = getInsightsCapabilityState(input);

      // Then
      expect(capability.status).toBe(state);
      expect(getProtectedInsightsRouteDecision(capability)).toBe(decision);
      expect(isInsightsQueryEnabled(capability)).toBe(enabled);
    },
  );
});

describe("insights route access", () => {
  it("allows navigation when the shared capability query reports support", async () => {
    vi.mocked(getInsightsCapabilitiesRpc).mockResolvedValueOnce({
      capabilities: {
        insights: true,
        mode: "bounded",
        maxMatchingRows: 50_000,
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      ensureInsightsRouteAccess(queryClient),
    ).resolves.toBeUndefined();
    expect(
      queryClient.getQueryData(getInsightsCapabilitiesQueryOptions().queryKey),
    ).toEqual({
      capabilities: {
        insights: true,
        mode: "bounded",
        maxMatchingRows: 50_000,
      },
    });
  });

  it("redirects navigation when the shared capability query reports no support", async () => {
    vi.mocked(getInsightsCapabilitiesRpc).mockResolvedValueOnce({
      capabilities: { insights: false },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(ensureInsightsRouteAccess(queryClient)).rejects.toMatchObject({
      options: { to: "/" },
    });
  });
});

describe("insights overview query", () => {
  it.each<InsightsCapabilityState>([
    { status: "unresolved" },
    { status: "unsupported" },
    { status: "error", error: new Error("offline") },
  ])("does not execute while capability is $status", async (capability) => {
    // Given
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    // When
    renderHook(() => useInsightsOverviewQuery(capability), { wrapper });
    await Promise.resolve();

    // Then
    expect(getInsightsOverviewRpc).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("refreshes externally written overview data after a finite interval", () => {
    // Given / When
    const options = getInsightsOverviewQueryOptions({
      status: "supported",
      mode: "bounded",
      maxMatchingRows: 50_000,
    });

    // Then
    expect(options.staleTime).toBe(30_000);
    expect(options.refetchOnWindowFocus).toBe(true);
  });

  it("separates active responses by window and normalized exact user ID", () => {
    const supported = {
      status: "supported",
      mode: "bounded",
      maxMatchingRows: 50_000,
    } as const;
    const first = getActiveInstallationQueryOptions(supported, {
      window: "7d",
      userId: "  Alias/B  ",
    });
    const second = getActiveInstallationQueryOptions(supported, {
      window: "24h",
      userId: "Alias/B",
    });

    expect(first.queryKey).toEqual([
      "insights",
      "active-installations",
      "7d",
      "Alias/B",
    ]);
    expect(second.queryKey).not.toEqual(first.queryKey);
    expect(first.enabled).toBe(true);
    expect(
      getActiveInstallationQueryOptions(
        { status: "unsupported" },
        { window: "7d", userId: "Alias/B" },
      ).enabled,
    ).toBe(false);
  });
});

describe("active installation query", () => {
  it.each<InsightsCapabilityState>([
    { status: "unresolved" },
    { status: "unsupported" },
    { status: "error", error: new Error("offline") },
  ])("does not execute while capability is $status", async (capability) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(
      () => useActiveInstallationQuery(capability, { window: "30d" }),
      { wrapper },
    );
    await Promise.resolve();

    expect(getActiveInstallationOverviewRpc).not.toHaveBeenCalled();
    queryClient.clear();
  });
});
