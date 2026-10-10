import type {
  ReleaseFilter,
  ReleasePolicyPatch,
} from "@hot-updater/plugin-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createChannel as createChannelApi,
  deleteChannel as deleteChannelApi,
  deleteRelease as deleteReleaseApi,
  getBundle,
  getBundleChildCounts,
  getBundleChildren,
  getChannels,
  getConfig,
  getRelease,
  getReleaseCatalogDiagnostics,
  getReleases,
  preflightRelease as preflightReleaseApi,
  promoteRelease as promoteReleaseApi,
  updateRelease as updateReleaseApi,
} from "./api-rpc";

const bundleListQueryKey = ["bundles"] as const;
const releaseListQueryKey = ["releases"] as const;

export const queryKeys = {
  config: ["config"] as const,
  channels: ["channels"] as const,
  bundles: {
    all: bundleListQueryKey,
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
};

export type ReleaseFilters = {
  /** One of the filter sets the release indexes serve; none lists every release. */
  filter?: ReleaseFilter;
  /** Releases older than this id: the next page. */
  beforeReleaseId?: string;
  /** Releases newer than this id: the previous page. */
  afterReleaseId?: string;
  limit?: number;
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
    mutationFn: (input: { name: string }) =>
      createChannelApi({ data: input }).then((response) => response.data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.channels });
    },
  });
}

export function useDeleteChannelMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string }) =>
      deleteChannelApi({ data: input }).then((response) => response.data),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.channels });
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
      // Core deletes the artifact with its last release, and the patches
      // built on it, so the bundle reads can change too.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.releases.all }),
        queryClient.invalidateQueries({ queryKey: ["release-catalog"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.channels }),
        queryClient.invalidateQueries({ queryKey: queryKeys.bundles.all }),
        queryClient.invalidateQueries({ queryKey: ["bundle"] }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.bundleChildren.all,
        }),
      ]);
    },
  });
}

export function usePromoteReleaseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      action: "copy" | "move";
      expectedRevision: number;
      releaseId: string;
      targetChannel: string;
    }) => promoteReleaseApi({ data: input }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.releases.all }),
        queryClient.invalidateQueries({ queryKey: ["release"] }),
        queryClient.invalidateQueries({ queryKey: ["release-catalog"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.channels }),
      ]);
    },
  });
}
