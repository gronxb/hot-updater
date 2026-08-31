import { type QueryClient, useQuery } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import {
  type ActiveInstallationInput,
  parseActiveInstallationInput,
} from "./insights-input";
import {
  getActiveInstallationOverviewRpc,
  getInsightsCapabilitiesRpc,
  getInsightsOverviewRpc,
  type InsightsCapabilities,
} from "./insights-rpc";

export type InsightsCapabilityState =
  | { readonly status: "unresolved" }
  | { readonly status: "unsupported" }
  | {
      readonly status: "supported";
      readonly mode: "bounded";
      readonly maxMatchingRows: number;
    }
  | { readonly status: "error"; readonly error: Error };

type InsightsCapabilityQueryResult =
  | { readonly status: "pending" }
  | { readonly status: "success"; readonly data: InsightsCapabilities }
  | { readonly status: "error"; readonly error: Error };

export type ProtectedInsightsRouteDecision =
  | "loading"
  | "redirect"
  | "allow"
  | "error";

export const insightsQueryKeys = {
  capabilities: ["insights", "capabilities"] as const,
  overview: ["insights", "overview"] as const,
  activeInstallations: (input: ActiveInstallationInput) =>
    [
      "insights",
      "active-installations",
      input.window,
      input.userId ?? null,
    ] as const,
};

const INSIGHTS_STALE_TIME_MS = 30_000;

export const getInsightsCapabilityState = (
  query: InsightsCapabilityQueryResult,
): InsightsCapabilityState => {
  switch (query.status) {
    case "pending":
      return { status: "unresolved" };
    case "error":
      return { status: "error", error: query.error };
    case "success":
      if (!query.data.capabilities.insights) {
        return { status: "unsupported" };
      }
      return {
        status: "supported",
        mode: "bounded",
        maxMatchingRows: query.data.capabilities.maxMatchingRows,
      };
  }
};

export const getProtectedInsightsRouteDecision = (
  capability: InsightsCapabilityState,
): ProtectedInsightsRouteDecision => {
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

export const isInsightsQueryEnabled = (
  capability: InsightsCapabilityState,
): boolean => capability.status === "supported";

export const getInsightsCapabilitiesQueryOptions = () => ({
  queryKey: insightsQueryKeys.capabilities,
  queryFn: () => getInsightsCapabilitiesRpc(),
  staleTime: Infinity,
});

export const useInsightsCapabilitiesQuery = () =>
  useQuery(getInsightsCapabilitiesQueryOptions());

export const ensureInsightsRouteAccess = async (
  queryClient: QueryClient,
): Promise<void> => {
  const result = await queryClient.ensureQueryData(
    getInsightsCapabilitiesQueryOptions(),
  );

  if (!result.capabilities.insights) {
    throw redirect({
      to: "/",
      search: {},
      replace: true,
    });
  }
};

export const getInsightsOverviewQueryOptions = (
  capability: InsightsCapabilityState,
) => ({
  queryKey: insightsQueryKeys.overview,
  queryFn: () => getInsightsOverviewRpc(),
  staleTime: INSIGHTS_STALE_TIME_MS,
  refetchOnWindowFocus: true,
  enabled: isInsightsQueryEnabled(capability),
});

export const useInsightsOverviewQuery = (capability: InsightsCapabilityState) =>
  useQuery(getInsightsOverviewQueryOptions(capability));

export const getActiveInstallationQueryOptions = (
  capability: InsightsCapabilityState,
  input: ActiveInstallationInput,
) => {
  const normalized = parseActiveInstallationInput(input);
  return {
    queryKey: insightsQueryKeys.activeInstallations(normalized),
    queryFn: () => getActiveInstallationOverviewRpc({ data: normalized }),
    staleTime: INSIGHTS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    enabled: isInsightsQueryEnabled(capability),
  };
};

export const useActiveInstallationQuery = (
  capability: InsightsCapabilityState,
  input: ActiveInstallationInput,
) => useQuery(getActiveInstallationQueryOptions(capability, input));
