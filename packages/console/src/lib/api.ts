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
  getNativeBuildDetail,
  createNativeBuildDownloadLink,
  getNativeBuildDownloadUrl,
  getNativeBuildPatches,
  getNativeBuilds,
  getRelease,
  getReleaseCatalogDiagnostics,
  getReleaseNativeBuild,
  getReleases,
  preflightRelease as preflightReleaseApi,
  promoteRelease as promoteReleaseApi,
  updateRelease as updateReleaseApi,
} from "./api-rpc";

const releaseListQueryKey = ["releases"] as const;

export const queryKeys = {
  config: ["config"] as const,
  channels: ["channels"] as const,
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
  nativeBuilds: {
    all: ["native-builds"] as const,
    list: (page: NativeBuildPage) => ["native-builds", page] as const,
  },
  nativeBuild: (id: string) => ["native-build", id] as const,
  nativeBuildPatches: (minBundleId: string, page: KeysetPage) =>
    ["native-build-patches", minBundleId, page] as const,
  nativeBuildDownloadUrl: (id: string) =>
    ["native-build-download-url", id] as const,
  releaseNativeBuild: (release: ReleaseNativeBuildInput) =>
    ["release-native-build", release] as const,
};

export type KeysetPage = {
  /** Rows older than this key: the next page. */
  before?: string;
  /** Rows newer than this key: the previous page. */
  after?: string;
};

export type NativeBuildPage = KeysetPage & {
  /** Only the builds that embed this channel. */
  channel?: string;
};

export type ReleaseNativeBuildInput = {
  platform: "ios" | "android";
  channel: string;
  fingerprintHash: string | null;
  targetAppVersion: string | null;
};

/**
 * How often an open install QR reads its download URL again. Storage gives
 * no lifetime with the URL, and adapters let it be configured down to
 * minutes, so the QR never shows one older than this.
 */
const DOWNLOAD_URL_REFRESH_MS = 30_000;

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

/** One page of native builds, newest first, kept on screen while the next loads. */
export function useNativeBuildsQuery(page: NativeBuildPage) {
  return useQuery({
    queryKey: queryKeys.nativeBuilds.list(page),
    queryFn: () => getNativeBuilds({ data: page }),
    placeholderData: (previousData) => previousData,
    staleTime: 60_000,
  });
}

/**
 * A native build's page in one round trip, or null for an unknown ID. The
 * page reads it again when it opens, since its catalog and patches change
 * with each deploy.
 */
export function useNativeBuildDetailQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.nativeBuild(id),
    queryFn: () => getNativeBuildDetail({ data: { id } }),
    enabled: id.length > 0,
  });
}

/**
 * A page of patches from a built-in bundle other than the newest, which the
 * build's page already holds; kept on screen while the next one loads.
 */
export function useNativeBuildPatchesQuery(
  minBundleId: string,
  page: KeysetPage,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.nativeBuildPatches(minBundleId, page),
    queryFn: () => getNativeBuildPatches({ data: { minBundleId, ...page } }),
    enabled: enabled && minBundleId.length > 0,
    placeholderData: (previousData) => previousData,
  });
}

/**
 * The newest native build of a release's scope, or none: read only for a
 * release one build can serve, by its fingerprint or one exact app version.
 */
export function useReleaseNativeBuildQuery(
  release: ReleaseNativeBuildInput | null,
) {
  return useQuery({
    queryKey: queryKeys.releaseNativeBuild(
      release ?? {
        platform: "ios",
        channel: "",
        fingerprintHash: null,
        targetAppVersion: null,
      },
    ),
    queryFn: () => getReleaseNativeBuild({ data: release! }),
    enabled: release !== null,
    staleTime: 60_000,
  });
}

/**
 * The storage URL a phone downloads a build from, read while the install
 * QR is open and again before it expires.
 */
export function useNativeBuildDownloadUrlQuery(id: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.nativeBuildDownloadUrl(id),
    queryFn: () => getNativeBuildDownloadUrl({ data: { id } }),
    enabled,
    staleTime: DOWNLOAD_URL_REFRESH_MS,
    // A storage without download URLs has none to refresh.
    refetchInterval: (query) =>
      query.state.data?.url === null ? false : DOWNLOAD_URL_REFRESH_MS,
  });
}

// Mutation Hooks
export function useCreateNativeBuildDownloadLinkMutation() {
  return useMutation({
    mutationFn: (id: string) => createNativeBuildDownloadLink({ data: { id } }),
  });
}

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
