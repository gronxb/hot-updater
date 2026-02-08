import type { Bundle } from "@hot-updater/plugin-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createBundle as createBundleApi,
  deleteBundle as deleteBundleApi,
  getBundle,
  getBundles,
  getChannels,
  getConfig,
  getConfigLoaded,
  getDeviceEvents,
  getRolloutStats,
  updateBundle as updateBundleApi,
} from "./server/api.server";

export interface DeviceEventFilters {
  bundleId?: string;
  platform?: "ios" | "android";
  channel?: string;
  eventType?: "PROMOTED" | "RECOVERED";
  limit?: number;
  offset?: number;
}

export const queryKeys = {
  config: ["config"] as const,
  channels: ["channels"] as const,
  configLoaded: ["config-loaded"] as const,
  bundles: (filters?: {
    channel?: string;
    platform?: "ios" | "android";
    limit?: string;
    offset?: string;
  }) => ["bundles", filters] as const,
  bundle: (bundleId: string) => ["bundle", bundleId] as const,
  rolloutStats: (bundleId: string) => ["rollout-stats", bundleId] as const,
  deviceEvents: (filters?: DeviceEventFilters) =>
    ["device-events", filters] as const,
};

// Query Hooks
export function useConfigQuery() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: () => getConfig(),
    staleTime: 5 * 60 * 1000, // 5 minutes - config rarely changes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
}

export function useChannelsQuery() {
  return useQuery({
    queryKey: queryKeys.channels,
    queryFn: () => getChannels(),
    staleTime: 5 * 60 * 1000, // 5 minutes - channels rarely change
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
}

export function useConfigLoadedQuery() {
  return useQuery({
    queryKey: queryKeys.configLoaded,
    queryFn: () => getConfigLoaded(),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
}

export function useBundlesQuery(filters?: {
  channel?: string;
  platform?: "ios" | "android";
  limit?: string;
  offset?: string;
}) {
  return useQuery({
    queryKey: queryKeys.bundles(filters),
    queryFn: () => getBundles({ data: filters }),
    staleTime: 30 * 1000, // 30 seconds - bundles can change frequently
    gcTime: 5 * 60 * 1000, // 5 minutes
    placeholderData: (previousData) => previousData,
  });
}

export function useBundleQuery(bundleId: string) {
  return useQuery({
    queryKey: queryKeys.bundle(bundleId),
    queryFn: () => getBundle({ data: { bundleId } }),
    staleTime: 30 * 1000, // 30 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
    enabled: !!bundleId,
  });
}

export function useRolloutStatsQuery(bundleId: string) {
  return useQuery({
    queryKey: queryKeys.rolloutStats(bundleId),
    queryFn: () => getRolloutStats({ data: { bundleId } }),
    staleTime: 30 * 1000, // 30 seconds - stats update frequently
    gcTime: 5 * 60 * 1000, // 5 minutes
    enabled: !!bundleId,
  });
}

// Mutation Hooks
export function useUpdateBundleMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (_params: { bundleId: string; bundle: Partial<Bundle> }) =>
      updateBundleApi(),
    onSuccess: (_, vars) => {
      // Invalidate queries
      queryClient.invalidateQueries({ queryKey: queryKeys.bundles() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.bundle(vars.bundleId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.rolloutStats(vars.bundleId),
      });
    },
  });
}

export function useCreateBundleMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (_bundle: Bundle) => createBundleApi(),
    onSuccess: () => {
      // Invalidate all bundle queries
      queryClient.invalidateQueries({ queryKey: queryKeys.bundles() });
      queryClient.invalidateQueries({ queryKey: queryKeys.channels });
    },
  });
}

export function useDeleteBundleMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (_params: { bundleId: string }) => deleteBundleApi(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bundles() });
    },
  });
}

export function useDeviceEventsQuery(
  filters?: DeviceEventFilters,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: queryKeys.deviceEvents(filters),
    queryFn: () => getDeviceEvents({ data: filters }),
    staleTime: 30000,
    placeholderData: (previousData) => previousData,
    ...options,
  });
}
