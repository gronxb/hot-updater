import type {
  ChannelDeleteInput,
  ChannelInsertInput,
  ReleasePolicyPatch,
} from "@hot-updater/plugin-core";
import type { BundleEventAnalyticsWindow } from "@hot-updater/server";
import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  createChannel as createChannelApi,
  deleteChannel as deleteChannelApi,
  deleteBundle as deleteBundleApi,
  deleteRelease as deleteReleaseApi,
  getBundle,
  getBundleChildCounts,
  getBundleChildren,
  getBundleEventAnalytics as getBundleEventAnalyticsApi,
  getBundleEventSummary as getBundleEventSummaryApi,
  getBundles,
  getChannels,
  getConfig,
  getConfigLoaded,
  getInstallationHistory as getInstallationHistoryApi,
  getRelease,
  getReleaseCatalogDiagnostics,
  getReleases,
  preflightRelease as preflightReleaseApi,
  searchInstallations as searchInstallationsApi,
  updateRelease as updateReleaseApi,
} from "./api-rpc";

type BundleFilters = {
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
const releaseListQueryKey = ["releases"] as const;

export const queryKeys = {
  config: ["config"] as const,
  channels: ["channels"] as const,
  configLoaded: ["config-loaded"] as const,
  bundles: {
    all: bundleListQueryKey,
    list: (filters?: BundleFilters) =>
      [...bundleListQueryKey, filters ?? {}] as const,
  },
  releases: {
    all: releaseListQueryKey,
    list: (filters?: ReleaseFilters) =>
      [...releaseListQueryKey, filters ?? {}] as const,
  },
  release: (releaseId: string) => ["release", releaseId] as const,
  releaseCatalog: (scopeKey: string) => ["release-catalog", scopeKey] as const,
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

export type ReleaseFilters = {
  beforeReleaseId?: string;
  channelId?: string;
  platform?: "ios" | "android";
  limit?: number;
};

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

export function useReleasesQuery(filters?: ReleaseFilters) {
  return useQuery({
    queryKey: queryKeys.releases.list(filters),
    queryFn: () => getReleases({ data: filters }),
    placeholderData: (previousData) => previousData,
  });
}

export function useReleaseQuery(releaseId: string) {
  return useQuery({
    enabled: releaseId.length > 0,
    queryFn: () => getRelease({ data: { releaseId } }),
    queryKey: queryKeys.release(releaseId),
  });
}

export function useReleaseCatalogDiagnosticsQuery(scopeKey: string) {
  return useQuery({
    enabled: scopeKey.length > 0,
    queryFn: () => getReleaseCatalogDiagnostics({ data: { scopeKey } }),
    queryKey: queryKeys.releaseCatalog(scopeKey),
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
export function useCreateChannelMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ChannelInsertInput) =>
      createChannelApi({ data: input }).then((response) => response.data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.channels });
    },
  });
}

export function useDeleteChannelMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ChannelDeleteInput) =>
      deleteChannelApi({ data: input }).then((response) => response.data),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.channels });
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
    },
  });
}

export function useUpdateReleaseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      expectedRevision: number;
      patch: ReleasePolicyPatch;
      releaseId: string;
    }) => updateReleaseApi({ data: input }),
    onSuccess: async (_, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.releases.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.release(input.releaseId),
        }),
        queryClient.invalidateQueries({ queryKey: ["release-catalog"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.channels }),
      ]);
    },
  });
}

export function usePreflightReleaseMutation() {
  return useMutation({
    mutationFn: (input: {
      expectedRevision: number;
      patch: ReleasePolicyPatch;
      releaseId: string;
    }) => preflightReleaseApi({ data: input }),
  });
}

export function useDeleteReleaseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { expectedRevision: number; releaseId: string }) =>
      deleteReleaseApi({ data: input }),
    onSuccess: async (_, input) => {
      queryClient.removeQueries({
        queryKey: queryKeys.release(input.releaseId),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.releases.all }),
        queryClient.invalidateQueries({ queryKey: ["release-catalog"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.channels }),
      ]);
    },
  });
}
