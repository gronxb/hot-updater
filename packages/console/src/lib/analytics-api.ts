import { type QueryClient, useQuery } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import {
  type ActiveInstallationInput,
  parseActiveInstallationInput,
} from "./analytics-input";
import {
  getActiveInstallationOverviewRpc,
  getAnalyticsCapabilitiesRpc,
  getAnalyticsOverviewRpc,
  type AnalyticsCapabilities,
} from "./analytics-rpc";

export type AnalyticsCapabilityState =
  | { readonly status: "unresolved" }
  | { readonly status: "unsupported" }
  | {
      readonly status: "supported";
      readonly mode: "bounded";
      readonly maxMatchingRows: number;
    }
  | { readonly status: "supported"; readonly mode: "dedicated" }
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
  activeInstallations: (input: ActiveInstallationInput) =>
    [
      "analytics",
      "active-installations",
      input.window,
      input.userId ?? null,
    ] as const,
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
      if (!query.data.capabilities.analytics) {
        return { status: "unsupported" };
      }
      return query.data.capabilities.mode === "bounded"
        ? {
            status: "supported",
            mode: "bounded",
            maxMatchingRows: query.data.capabilities.maxMatchingRows,
          }
        : { status: "supported", mode: "dedicated" };
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

export const getAnalyticsCapabilitiesQueryOptions = () => ({
  queryKey: analyticsQueryKeys.capabilities,
  queryFn: () => getAnalyticsCapabilitiesRpc(),
  staleTime: Infinity,
});

export const useAnalyticsCapabilitiesQuery = () =>
  useQuery(getAnalyticsCapabilitiesQueryOptions());

export const ensureAnalyticsRouteAccess = async (
  queryClient: QueryClient,
): Promise<void> => {
  const result = await queryClient.ensureQueryData(
    getAnalyticsCapabilitiesQueryOptions(),
  );

  if (!result.capabilities.analytics) {
    throw redirect({
      to: "/",
      search: {
        channel: undefined,
        platform: undefined,
        page: undefined,
        after: undefined,
        before: undefined,
        bundleId: undefined,
        expandedBundleId: undefined,
      },
      replace: true,
    });
  }
};

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

export const getActiveInstallationQueryOptions = (
  capability: AnalyticsCapabilityState,
  input: ActiveInstallationInput,
) => {
  const normalized = parseActiveInstallationInput(input);
  return {
    queryKey: analyticsQueryKeys.activeInstallations(normalized),
    queryFn: () => getActiveInstallationOverviewRpc({ data: normalized }),
    staleTime: ANALYTICS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    enabled: isAnalyticsQueryEnabled(capability),
  };
};

export const useActiveInstallationQuery = (
  capability: AnalyticsCapabilityState,
  input: ActiveInstallationInput,
) => useQuery(getActiveInstallationQueryOptions(capability, input));
