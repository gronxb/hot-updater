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
  getNativeBuildInstallEligibility,
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
  nativeBuildDownloadLink: (id: string) =>
    ["native-build-download-link", id] as const,
  nativeBuildInstallEligibility: (id: string, udid: string | null) =>
    ["native-build-install-eligibility", id, udid] as const,
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
 * How long a storage download URL counts as fresh. Storage gives no lifetime
 * with the URL, and adapters let it be configured down to minutes, so a
 * person coming back to the page after this gets a new one.
 */
const DOWNLOAD_URL_STALE_MS = 60_000;

/**
 * How long a build page's signed link counts as fresh: far inside its 30 days,
 * so a page left open never shows an expired one, and it costs one request
 * a day.
 */
const DOWNLOAD_LINK_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * How long an iPhone keeps a build's install details and Install link, which
 * lasts an hour: past this, an open page reads and signs again.
 */
const INSTALL_ELIGIBILITY_STALE_MS = 30 * 60 * 1000;

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
 * The signed link of a build's page, which its QR code, download button, and
 * copyable link all use: one request when the page opens.
 */
export function useNativeBuildDownloadLinkQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.nativeBuildDownloadLink(id),
    queryFn: () => createNativeBuildDownloadLink({ data: { id } }),
    staleTime: DOWNLOAD_LINK_STALE_MS,
  });
}

/**
 * What this iPhone can do with a build, and the link Install opens: requested
 * only by an iPhone on the page of an IPA, and again before that link, which
 * lasts about an hour, runs out.
 */
export function useNativeBuildInstallEligibilityQuery(
  id: string,
  udid: string | null,
) {
  return useQuery({
    queryKey: queryKeys.nativeBuildInstallEligibility(id, udid),
    queryFn: () =>
      getNativeBuildInstallEligibility({
        data: { id, ...(udid === null ? {} : { udid }) },
      }),
    staleTime: INSTALL_ELIGIBILITY_STALE_MS,
    // A page left open never holds an expired link. It reads nothing while the
    // tab is hidden, and coming back reads again once this has passed.
    refetchInterval: INSTALL_ELIGIBILITY_STALE_MS,
  });
}

/**
 * The storage URL a phone downloads a build from when the Console can't sign
 * a link: read once, and again only when someone comes back to the page.
 */
export function useNativeBuildDownloadUrlQuery(id: string) {
  return useQuery({
    queryKey: queryKeys.nativeBuildDownloadUrl(id),
    queryFn: () => getNativeBuildDownloadUrl({ data: { id } }),
    staleTime: DOWNLOAD_URL_STALE_MS,
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
