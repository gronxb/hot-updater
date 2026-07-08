import type { Bundle } from "@hot-updater/plugin-core";
import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  type BundleFilters,
  type ConsoleApiClient,
  useConsoleApiClient,
} from "./api-client";

type BundlesQueryData = Awaited<ReturnType<ConsoleApiClient["getBundles"]>>;

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

function removeBundleFromQueryData(
  data: BundlesQueryData | undefined,
  bundleId: string,
) {
  if (!data) {
    return data;
  }

  return {
    ...data,
    data: data.data.filter((bundle) => bundle.id !== bundleId),
  };
}

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

const invalidateInBackground = (
  queryClient: QueryClient,
  queryKey: QueryKey,
) => {
  void queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
};

// Query Hooks
export function useConfigQuery() {
  const api = useConsoleApiClient();

  return useQuery({
    queryKey: queryKeys.config,
    queryFn: () => api.getConfig(),
    staleTime: Infinity,
  });
}

export function useChannelsQuery() {
  const api = useConsoleApiClient();

  return useQuery({
    queryKey: queryKeys.channels,
    queryFn: () => api.getChannels(),
    staleTime: Infinity,
  });
}

export function useConfigLoadedQuery() {
  const api = useConsoleApiClient();

  return useQuery({
    queryKey: queryKeys.configLoaded,
    queryFn: () => api.getConfigLoaded(),
    staleTime: Infinity,
  });
}

export function useBundlesQuery(filters?: BundleFilters) {
  const api = useConsoleApiClient();

  return useQuery({
    queryKey: queryKeys.bundles.list(filters),
    queryFn: () => api.getBundles(filters),
    staleTime: Infinity,
    placeholderData: (previousData) => previousData,
  });
}

export function useBundleQuery(bundleId: string) {
  const api = useConsoleApiClient();

  return useQuery({
    queryKey: queryKeys.bundle(bundleId),
    queryFn: () => api.getBundle({ bundleId }),
    staleTime: Infinity,
    enabled: !!bundleId,
  });
}

export function useBundleChildrenQuery(baseBundleId: string) {
  const api = useConsoleApiClient();

  return useQuery({
    queryKey: queryKeys.bundleChildren.list(baseBundleId),
    queryFn: () => api.getBundleChildren({ baseBundleId }),
    staleTime: Infinity,
    enabled: !!baseBundleId,
  });
}

export function useBundleChildCountsQuery(bundleIds: string[]) {
  const api = useConsoleApiClient();
  const normalizedBundleIds = [...bundleIds].sort((left, right) =>
    left.localeCompare(right),
  );

  return useQuery({
    queryKey: queryKeys.bundleChildren.counts(normalizedBundleIds),
    queryFn: () => api.getBundleChildCounts({ bundleIds: normalizedBundleIds }),
    staleTime: Infinity,
    enabled: normalizedBundleIds.length > 0,
  });
}

// Mutation Hooks
export function useBundleDownloadUrlMutation() {
  const api = useConsoleApiClient();

  return useMutation({
    mutationFn: (params: { bundleId: string }) =>
      api.getBundleDownloadUrl(params),
  });
}

export function useUpdateBundleMutation() {
  const api = useConsoleApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { bundleId: string; bundle: Partial<Bundle> }) =>
      api.updateBundle(params),
    onSuccess: ({ bundle: updatedBundle }, vars) => {
      queryClient.setQueryData(queryKeys.bundle(vars.bundleId), updatedBundle);
      queryClient.setQueriesData(
        { queryKey: queryKeys.bundles.all },
        (data: BundlesQueryData | undefined) =>
          replaceBundleInQueryData(data, updatedBundle),
      );

      invalidateInBackground(queryClient, queryKeys.bundles.all);

      if (
        hasOwn(vars.bundle, "patches") ||
        hasOwn(vars.bundle, "channel") ||
        hasOwn(vars.bundle, "platform")
      ) {
        invalidateInBackground(queryClient, queryKeys.bundleChildren.all);
      }

      if (hasOwn(vars.bundle, "channel")) {
        invalidateInBackground(queryClient, queryKeys.channels);
      }
    },
  });
}

export function useCreateBundleMutation() {
  const api = useConsoleApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (bundle: Bundle) => api.createBundle(bundle),
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
  const api = useConsoleApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      action: "copy" | "move";
      bundleId: string;
      nextBundleId?: string;
      targetChannel: string;
    }) => api.promoteBundle(params),
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
  const api = useConsoleApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { bundleId: string }) => api.deleteBundle(params),
    onSuccess: (_, vars) => {
      queryClient.removeQueries({ queryKey: queryKeys.bundle(vars.bundleId) });
      queryClient.setQueriesData(
        { queryKey: queryKeys.bundles.all },
        (data: BundlesQueryData | undefined) =>
          removeBundleFromQueryData(data, vars.bundleId),
      );

      invalidateInBackground(queryClient, queryKeys.bundles.all);
      invalidateInBackground(queryClient, queryKeys.bundleChildren.all);
      invalidateInBackground(queryClient, queryKeys.channels);
    },
  });
}
