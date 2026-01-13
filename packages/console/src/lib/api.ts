import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bundle } from "@hot-updater/plugin-core";
import {
  getConfig,
  getChannels,
  getConfigLoaded,
  getBundles,
  getBundle,
  getRolloutStats,
  getDeviceEvents,
  updateBundle as updateBundleApi,
  createBundle as createBundleApi,
  deleteBundle as deleteBundleApi,
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
    staleTime: Infinity,
  });
}

export function useChannelsQuery() {
  return useQuery({
    queryKey: queryKeys.channels,
    queryFn: () => getChannels(),
    staleTime: Infinity,
  });
}

export function useConfigLoadedQuery() {
  return useQuery({
    queryKey: queryKeys.configLoaded,
    queryFn: () => getConfigLoaded(),
    staleTime: Infinity,
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
    queryFn: () => (getBundles as any)({ data: filters }),
    staleTime: Infinity,
    placeholderData: (previousData) => previousData,
  });
}

export function useBundleQuery(bundleId: string) {
  return useQuery({
    queryKey: queryKeys.bundle(bundleId),
    queryFn: () => (getBundle as any)({ data: { bundleId } }),
    staleTime: Infinity,
    enabled: !!bundleId,
  });
}

export function useRolloutStatsQuery(bundleId: string) {
  return useQuery({
    queryKey: queryKeys.rolloutStats(bundleId),
    queryFn: () => (getRolloutStats as any)({ data: { bundleId } }),
    staleTime: Infinity,
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

export function useDeviceEventsQuery(filters?: DeviceEventFilters) {
  return useQuery({
    queryKey: queryKeys.deviceEvents(filters),
    queryFn: () => (getDeviceEvents as any)({ data: filters }),
    staleTime: 30000,
    placeholderData: (previousData) => previousData,
  });
}
