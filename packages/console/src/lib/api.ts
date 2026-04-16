import type { Bundle } from "@hot-updater/plugin-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createBundleDiff as createBundleDiffApi,
  createBundle as createBundleApi,
  deleteBundle as deleteBundleApi,
  getBundle,
  getBundleChildCounts,
  getBundleChildren,
  getBundleDownloadUrl,
  getBundles,
  getChannels,
  getConfig,
  getConfigLoaded,
  promoteBundle as promoteBundleApi,
  updateBundle as updateBundleApi,
} from "./api-rpc";

type BundleFilters = {
  channel?: string;
  platform?: "ios" | "android";
  page?: number;
  limit?: string;
  after?: string;
  before?: string;
};

type BundlesQueryData = Awaited<ReturnType<typeof getBundles>>;

const bundleListQueryKey = ["bundles"] as const;

export const queryKeys = {
  config: ["config"] as const,
  channels: ["channels"] as const,
  configLoaded: ["config-loaded"] as const,
  bundles: {
    all: bundleListQueryKey,
    list: (filters?: BundleFilters) =>
      [...bundleListQueryKey, filters ?? {}] as const,
  },
  bundleChildren: {
    all: ["bundle-children"] as const,
    list: (baseBundleId: string) => ["bundle-children", baseBundleId] as const,
    counts: (bundleIds: string[]) =>
      ["bundle-children", "counts", ...bundleIds] as const,
  },
  bundle: (bundleId: string) => ["bundle", bundleId] as const,
};

function replaceBundleInQueryData(
  data: BundlesQueryData | undefined,
  updatedBundle: Bundle,
) {
  if (!data) {
    return data;
  }

  return {
    ...data,
    data: data.data.map((bundle) =>
      bundle.id === updatedBundle.id ? updatedBundle : bundle,
    ),
  };
}

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

export function useBundlesQuery(filters?: BundleFilters) {
  return useQuery({
    queryKey: queryKeys.bundles.list(filters),
    queryFn: () => getBundles({ data: filters }),
    staleTime: Infinity,
    placeholderData: (previousData) => previousData,
  });
}

export function useBundleQuery(bundleId: string) {
  return useQuery({
    queryKey: queryKeys.bundle(bundleId),
    queryFn: () => getBundle({ data: { bundleId } }),
    staleTime: Infinity,
    enabled: !!bundleId,
  });
}

export function useBundleChildrenQuery(baseBundleId: string) {
  return useQuery({
    queryKey: queryKeys.bundleChildren.list(baseBundleId),
    queryFn: () => getBundleChildren({ data: { baseBundleId } }),
    staleTime: Infinity,
    enabled: !!baseBundleId,
  });
}

export function useBundleChildCountsQuery(bundleIds: string[]) {
  const normalizedBundleIds = [...bundleIds].sort((left, right) =>
    left.localeCompare(right),
  );

  return useQuery({
    queryKey: queryKeys.bundleChildren.counts(normalizedBundleIds),
    queryFn: () => getBundleChildCounts({ data: { bundleIds: normalizedBundleIds } }),
    staleTime: Infinity,
    enabled: normalizedBundleIds.length > 0,
  });
}

// Mutation Hooks
export function useBundleDownloadUrlMutation() {
  return useMutation({
    mutationFn: (params: { bundleId: string }) =>
      getBundleDownloadUrl({ data: params }),
  });
}

export function useUpdateBundleMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { bundleId: string; bundle: Partial<Bundle> }) =>
      updateBundleApi({ data: params }),
    onSuccess: async ({ bundle: updatedBundle }, vars) => {
      queryClient.setQueryData(queryKeys.bundle(vars.bundleId), updatedBundle);
      queryClient.setQueriesData(
        { queryKey: queryKeys.bundles.all },
        (data: BundlesQueryData | undefined) =>
          replaceBundleInQueryData(data, updatedBundle),
      );

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.bundles.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.bundleChildren.all,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.bundle(vars.bundleId),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.channels }),
      ]);
    },
  });
}

export function useCreateBundleMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (bundle: Bundle) => createBundleApi({ data: bundle }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.bundles.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.bundleChildren.all,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.channels }),
      ]);
    },
  });
}

export function usePromoteBundleMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      action: "copy" | "move";
      bundleId: string;
      nextBundleId?: string;
      targetChannel: string;
    }) => promoteBundleApi({ data: params }),
    onSuccess: async ({ bundle }) => {
      queryClient.setQueryData(queryKeys.bundle(bundle.id), bundle);

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.bundles.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.bundleChildren.all,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.channels }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.bundle(bundle.id),
        }),
      ]);
    },
  });
}

export function useDeleteBundleMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { bundleId: string }) =>
      deleteBundleApi({ data: params }),
    onSuccess: async (_, vars) => {
      queryClient.removeQueries({ queryKey: queryKeys.bundle(vars.bundleId) });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.bundles.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.bundleChildren.all,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.channels }),
      ]);
    },
  });
}

export function useCreateBundleDiffMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { baseBundleId: string; bundleId: string }) =>
      createBundleDiffApi({ data: params }),
    onSuccess: async ({ bundle }) => {
      queryClient.setQueryData(queryKeys.bundle(bundle.id), bundle);

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.bundles.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.bundleChildren.all,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.bundle(bundle.id),
        }),
      ]);
    },
  });
}
