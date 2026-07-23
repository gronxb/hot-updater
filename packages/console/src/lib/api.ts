import type { Bundle } from "@hot-updater/plugin-core";
import type { BundleEventAnalyticsWindow } from "@hot-updater/server/db";
import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  createBundle as createBundleApi,
  deleteBundle as deleteBundleApi,
  getBundle,
  getBundleChildCounts,
  getBundleChildren,
  getBundleDownloadUrl,
  getBundleEventAnalytics as getBundleEventAnalyticsApi,
  getBundleEventSummary as getBundleEventSummaryApi,
  getBundles,
  getChannels,
  getConfig,
  getConfigLoaded,
  getInstallationHistory as getInstallationHistoryApi,
  promoteBundle as promoteBundleApi,
  searchInstallations as searchInstallationsApi,
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

const ANALYTICS_STALE_TIME_MS = 30_000;

export type BundleEventSummary = Awaited<
  ReturnType<typeof getBundleEventSummaryApi>
>;
export type BundleEventAnalytics = Awaited<
  ReturnType<typeof getBundleEventAnalyticsApi>
>;
export type InstallationSearchResult = Awaited<
  ReturnType<typeof searchInstallationsApi>
>;
export type InstallationHistoryResult = Awaited<
  ReturnType<typeof getInstallationHistoryApi>
>;
export type InstallationSearchRow = InstallationSearchResult["data"][number];
export type InstallationHistoryRow = InstallationHistoryResult["data"][number];

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
  bundleEventSummary: (bundleId: string) =>
    ["bundle-event-summary", bundleId] as const,
  bundleEventAnalytics: (input: {
    bundleId: string;
    window: BundleEventAnalyticsWindow;
    limit?: number;
    offset?: number;
  }) => ["bundle-event-analytics", input] as const,

  installations: {
    search: (input: { query: string; limit?: number; offset?: number }) =>
      ["installations", "search", input] as const,
    history: (input: { installId: string; limit?: number; offset?: number }) =>
      ["installations", "history", input] as const,
  },
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

export function useBundleEventSummaryQuery(bundleId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.bundleEventSummary(bundleId),
    queryFn: () => getBundleEventSummaryApi({ data: { bundleId } }),
    staleTime: ANALYTICS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    enabled: enabled && bundleId.length > 0,
  });
}

export function useBundleEventAnalyticsQuery(
  input: {
    bundleId: string;
    window: BundleEventAnalyticsWindow;
    limit?: number;
    offset?: number;
  },
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.bundleEventAnalytics(input),
    queryFn: () => getBundleEventAnalyticsApi({ data: input }),
    staleTime: ANALYTICS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    enabled: enabled && input.bundleId.length > 0,
  });
}

export function useInstallationSearchQuery(
  input: {
    query: string;
    limit?: number;
    offset?: number;
  },
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.installations.search(input),
    queryFn: () => searchInstallationsApi({ data: input }),
    staleTime: ANALYTICS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    enabled: enabled && input.query.trim().length > 0,
  });
}

export function useInstallationHistoryQuery(
  input: {
    installId: string;
    limit?: number;
    offset?: number;
  },
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.installations.history(input),
    queryFn: () => getInstallationHistoryApi({ data: input }),
    staleTime: ANALYTICS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    enabled: enabled && input.installId.length > 0,
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
    queryFn: () =>
      getBundleChildCounts({ data: { bundleIds: normalizedBundleIds } }),
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
