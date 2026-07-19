import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  type AnalyticsCapabilityState,
  ensureAnalyticsRouteAccess,
  getActiveInstallationQueryOptions,
  getAnalyticsCapabilityState,
  getAnalyticsCapabilitiesQueryOptions,
  getAnalyticsOverviewQueryOptions,
  getProtectedAnalyticsRouteDecision,
  isAnalyticsQueryEnabled,
  useActiveInstallationQuery,
  useAnalyticsOverviewQuery,
} from "./analytics-api";
import {
  getActiveInstallationOverviewRpc,
  getAnalyticsCapabilitiesRpc,
  getAnalyticsOverviewRpc,
} from "./analytics-rpc";

vi.mock("./analytics-rpc", () => ({
  getActiveInstallationOverviewRpc: vi.fn(),
  getAnalyticsCapabilitiesRpc: vi.fn(),
  getAnalyticsOverviewRpc: vi.fn(),
}));

describe("analytics capability gating", () => {
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
        data: { capabilities: { analytics: false as const } },
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
            analytics: true as const,
            mode: "dedicated" as const,
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
      const capability = getAnalyticsCapabilityState(input);

      // Then
      expect(capability.status).toBe(state);
      expect(getProtectedAnalyticsRouteDecision(capability)).toBe(decision);
      expect(isAnalyticsQueryEnabled(capability)).toBe(enabled);
    },
  );
});

describe("analytics route access", () => {
  it("allows navigation when the shared capability query reports support", async () => {
    vi.mocked(getAnalyticsCapabilitiesRpc).mockResolvedValueOnce({
      capabilities: { analytics: true, mode: "dedicated" },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      ensureAnalyticsRouteAccess(queryClient),
    ).resolves.toBeUndefined();
    expect(
      queryClient.getQueryData(getAnalyticsCapabilitiesQueryOptions().queryKey),
    ).toEqual({
      capabilities: { analytics: true, mode: "dedicated" },
    });
  });

  it("redirects navigation when the shared capability query reports no support", async () => {
    vi.mocked(getAnalyticsCapabilitiesRpc).mockResolvedValueOnce({
      capabilities: { analytics: false },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(ensureAnalyticsRouteAccess(queryClient)).rejects.toMatchObject(
      {
        options: { to: "/" },
      },
    );
  });
});

describe("analytics overview query", () => {
  it.each<AnalyticsCapabilityState>([
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
    renderHook(() => useAnalyticsOverviewQuery(capability), { wrapper });
    await Promise.resolve();

    // Then
    expect(getAnalyticsOverviewRpc).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("refreshes externally written overview data after a finite interval", () => {
    // Given / When
    const options = getAnalyticsOverviewQueryOptions({
      status: "supported",
      mode: "dedicated",
    });

    // Then
    expect(options.staleTime).toBe(30_000);
    expect(options.refetchOnWindowFocus).toBe(true);
  });

  it("separates active responses by window and normalized exact user ID", () => {
    const supported = { status: "supported", mode: "dedicated" } as const;
    const first = getActiveInstallationQueryOptions(supported, {
      window: "7d",
      userId: "  Alias/B  ",
    });
    const second = getActiveInstallationQueryOptions(supported, {
      window: "24h",
      userId: "Alias/B",
    });

    expect(first.queryKey).toEqual([
      "analytics",
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
  it.each<AnalyticsCapabilityState>([
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
