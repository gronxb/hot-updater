import { useQuery } from "@tanstack/react-query";

import {
  getAnalyticsCapabilitiesRpc,
  getAnalyticsOverviewRpc,
  type AnalyticsCapabilities,
} from "./analytics-rpc";

export type AnalyticsCapabilityState =
  | { readonly status: "unresolved" }
  | { readonly status: "unsupported" }
  | { readonly status: "supported" }
  | { readonly status: "error"; readonly error: Error };

type AnalyticsCapabilityQueryResult =
  | { readonly status: "pending" }
  | { readonly status: "success"; readonly data: AnalyticsCapabilities }
  | { readonly status: "error"; readonly error: Error };

export type ProtectedAnalyticsRouteDecision =
  | "loading"
  | "redirect"
  | "allow"
  | "error";

export const analyticsQueryKeys = {
  capabilities: ["analytics", "capabilities"] as const,
  overview: ["analytics", "overview"] as const,
};

const ANALYTICS_STALE_TIME_MS = 30_000;

export const getAnalyticsCapabilityState = (
  query: AnalyticsCapabilityQueryResult,
): AnalyticsCapabilityState => {
  switch (query.status) {
    case "pending":
      return { status: "unresolved" };
    case "error":
      return { status: "error", error: query.error };
    case "success":
      return query.data.supportsBundleEvents
        ? { status: "supported" }
        : { status: "unsupported" };
  }
};

export const getProtectedAnalyticsRouteDecision = (
  capability: AnalyticsCapabilityState,
): ProtectedAnalyticsRouteDecision => {
  switch (capability.status) {
    case "unresolved":
      return "loading";
    case "unsupported":
      return "redirect";
    case "supported":
      return "allow";
    case "error":
      return "error";
  }
};

export const isAnalyticsQueryEnabled = (
  capability: AnalyticsCapabilityState,
): boolean => capability.status === "supported";

export const useAnalyticsCapabilitiesQuery = () =>
  useQuery({
    queryKey: analyticsQueryKeys.capabilities,
    queryFn: () => getAnalyticsCapabilitiesRpc(),
    staleTime: Infinity,
  });

export const getAnalyticsOverviewQueryOptions = (
  capability: AnalyticsCapabilityState,
) => ({
  queryKey: analyticsQueryKeys.overview,
  queryFn: () => getAnalyticsOverviewRpc(),
  staleTime: ANALYTICS_STALE_TIME_MS,
  refetchOnWindowFocus: true,
  enabled: isAnalyticsQueryEnabled(capability),
});

export const useAnalyticsOverviewQuery = (
  capability: AnalyticsCapabilityState,
) => useQuery(getAnalyticsOverviewQueryOptions(capability));
