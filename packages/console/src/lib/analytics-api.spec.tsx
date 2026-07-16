import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  type AnalyticsCapabilityState,
  getAnalyticsCapabilityState,
  getProtectedAnalyticsRouteDecision,
  isAnalyticsQueryEnabled,
  useAnalyticsOverviewQuery,
} from "./analytics-api";
import { getAnalyticsOverviewRpc } from "./analytics-rpc";

vi.mock("./analytics-rpc", () => ({
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
        data: { supportsBundleEvents: false },
      },
      state: "unsupported",
      decision: "redirect",
      enabled: false,
    },
    {
      name: "supported",
      input: {
        status: "success" as const,
        data: { supportsBundleEvents: true },
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
});
