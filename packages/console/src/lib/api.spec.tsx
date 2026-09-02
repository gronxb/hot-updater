import type { Bundle } from "@hot-updater/plugin-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  queryKeys,
  useCreateChannelMutation,
  useDeleteChannelMutation,
  useDeleteBundleMutation,
  useDeleteBundlesMutation,
  useReleasesQuery,
  useUpdateReleaseMutation,
} from "./api";
import {
  createChannel as createChannelApi,
  deleteChannel as deleteChannelApi,
  deleteBundle as deleteBundleApi,
  deleteBundles as deleteBundlesApi,
  getReleases as getReleasesApi,
  updateRelease as updateReleaseApi,
} from "./api-rpc";

vi.mock("./api-rpc", () => ({
  createBundle: vi.fn(),
  createChannel: vi.fn(),
  deleteBundle: vi.fn(),
  deleteBundles: vi.fn(),
  deleteChannel: vi.fn(),
  deleteRelease: vi.fn(),
  getBundle: vi.fn(),
  getBundleChildCounts: vi.fn(),
  getBundleChildren: vi.fn(),
  getBundles: vi.fn(),
  getChannels: vi.fn(),
  getConfig: vi.fn(),
  getConfigLoaded: vi.fn(),
  getRelease: vi.fn(),
  getReleaseCatalogDiagnostics: vi.fn(),
  getReleases: vi.fn(),
  preflightRelease: vi.fn(),
  updateRelease: vi.fn(),
}));

const bundle: Bundle = {
  id: "bundle-001",
  platform: "ios",
  fileHash: "hash",
  gitCommitHash: null,
  storageUri: "s3://bucket/bundle.zip",
  archiveByteSize: 3_000_000_001,
};

const otherBundle: Bundle = {
  ...bundle,
  id: "bundle-002",
  fileHash: "other-hash",
};

const timeout = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), ms);
  });

it("refreshes the active release table before a successful update resolves", async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const filters = { channelId: "channel-1", platform: "ios" as const };
  const page: Awaited<ReturnType<typeof getReleasesApi>> = {
    data: [
      {
        activity30d: null,
        bundle_id: bundle.id,
        channel_id: "channel-1",
        created_at_ms: 1,
        currentlyUnreachable: false,
        enabled: true,
        fingerprint_hash: null,
        id: "release-1",
        kind: "BUNDLE",
        message: "Initial message",
        operation: "DEPLOY",
        platform: "ios",
        revision: 1,
        rollout_cohort_count: 1_000,
        scope_key: "scope-1",
        should_force_update: false,
        source_release_id: null,
        strategy: "APP_VERSION",
        target_app_version: "1.2.x",
        target_cohorts: [],
        updated_at_ms: 1,
      },
    ],
    pagination: { currentPage: 1, hasNextPage: false, hasPreviousPage: false },
  };
  queryClient.setQueryData(queryKeys.releases.list(filters), page);
  const refreshedPage = {
    ...page,
    data: page.data.map((release) => ({
      ...release,
      message: "Updated message",
      revision: 2,
    })),
  };
  let finishRefresh!: () => void;
  vi.mocked(getReleasesApi).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRefresh = () => resolve(refreshedPage);
      }),
  );
  vi.mocked(updateReleaseApi).mockResolvedValueOnce({
    attempts: 1,
    catalog: {
      scope_key: "scope-1",
      catalog_id: "catalog-1",
      strategy: "APP_VERSION",
      channel_id: "channel-1",
      channel_key: "production",
      platform: "ios",
      fingerprint_hash: null,
      generation: 2,
      payload: "{}",
      catalog_hash: "catalog-hash",
      byte_size: 2,
      is_tombstone: false,
      updated_at_ms: 2,
    },
    release: refreshedPage.data[0]!,
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(
    () => ({
      releases: useReleasesQuery(filters),
      update: useUpdateReleaseMutation(),
    }),
    { wrapper },
  );

  try {
    const input = {
      expectedRevision: 1,
      patch: { message: "Updated message" },
      releaseId: "release-1",
    };
    let saved!: Promise<unknown>;
    act(() => {
      saved = result.current.update.mutateAsync(input);
    });
    await waitFor(() =>
      expect(getReleasesApi).toHaveBeenCalledWith({ data: filters }),
    );
    expect(updateReleaseApi).toHaveBeenCalledWith({ data: input });
    expect(result.current.update.isPending).toBe(true);
    expect(result.current.releases.data?.data[0]?.message).toBe(
      "Initial message",
    );

    await act(async () => {
      finishRefresh();
      await saved;
    });

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    expect(result.current.releases.data).toEqual(refreshedPage);
  } finally {
    unmount();
    queryClient.clear();
  }
});

describe("channel mutations", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  const createWrapper = () =>
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    };

  it("forwards the canonical channel insert and refreshes channel queries", async () => {
    const input = {
      row: { id: "channel-beta", name: "beta" },
      onConflict: "returnExisting" as const,
    };
    vi.mocked(createChannelApi).mockResolvedValue({
      data: { row: input.row, inserted: true },
    });
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const { result } = renderHook(() => useCreateChannelMutation(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.mutateAsync(input);
    });

    expect(createChannelApi).toHaveBeenCalledWith({ data: input });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.channels,
    });
  });

  it("preserves a not-empty delete result and refreshes channels", async () => {
    vi.mocked(deleteChannelApi).mockResolvedValue({
      data: { deleted: false, reason: "not_empty" },
    });
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const { result } = renderHook(() => useDeleteChannelMutation(), {
      wrapper: createWrapper(),
    });

    let deleteResult: Awaited<ReturnType<typeof result.current.mutateAsync>>;
    await act(async () => {
      deleteResult = await result.current.mutateAsync({ id: "channel-beta" });
    });

    expect(deleteResult!).toEqual({ deleted: false, reason: "not_empty" });
    expect(deleteChannelApi).toHaveBeenCalledWith({
      data: { id: "channel-beta" },
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.channels,
    });
  });
});

describe("useDeleteBundleMutation", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        mutations: {
          retry: false,
        },
        queries: {
          retry: false,
        },
      },
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("removes a deleted bundle from cached bundle lists", async () => {
    vi.mocked(deleteBundleApi).mockResolvedValue({
      success: true,
    });
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();

    queryClient.setQueryData(queryKeys.bundle(bundle.id), bundle);
    queryClient.setQueryData(queryKeys.bundles.list({}), {
      data: [bundle, otherBundle],
      pagination: {
        total: 2,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 1,
      },
    });

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDeleteBundleMutation(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        bundleId: bundle.id,
      });
    });

    expect(
      queryClient.getQueryData(queryKeys.bundle(bundle.id)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.bundles.list({}))).toEqual({
      data: [otherBundle],
      pagination: {
        total: 2,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 1,
      },
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.bundles.all,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.bundleChildren.all,
    });
  });

  it("does not wait for background invalidations after deleting cached bundle data", async () => {
    vi.mocked(deleteBundleApi).mockResolvedValue({
      success: true,
    });
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockImplementation(() => new Promise<never>(() => {}));

    queryClient.setQueryData(queryKeys.bundle(bundle.id), bundle);
    queryClient.setQueryData(queryKeys.bundles.list({}), {
      data: [bundle, otherBundle],
      pagination: {
        total: 2,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 1,
      },
    });

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDeleteBundleMutation(), {
      wrapper,
    });

    let mutation: Promise<unknown> | undefined;
    act(() => {
      mutation = result.current.mutateAsync({
        bundleId: bundle.id,
      });
    });

    await expect(
      Promise.race([mutation!.then(() => "resolved"), timeout(20)]),
    ).resolves.toBe("resolved");

    expect(
      queryClient.getQueryData(queryKeys.bundle(bundle.id)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.bundles.list({}))).toEqual({
      data: [otherBundle],
      pagination: {
        total: 2,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 1,
      },
    });
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });
});

describe("useDeleteBundlesMutation", () => {
  it("removes the whole batch from artifact caches and invalidates once", async () => {
    vi.mocked(deleteBundlesApi).mockResolvedValue({
      success: true,
      deletedBundleIds: [bundle.id, otherBundle.id],
      missingBundleIds: [],
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue();
    const filters = { platform: "ios" as const, limit: "2000" };

    queryClient.setQueryData(queryKeys.bundle(bundle.id), bundle);
    queryClient.setQueryData(queryKeys.bundle(otherBundle.id), otherBundle);
    queryClient.setQueryData(queryKeys.bundles.list(filters), {
      data: [bundle, otherBundle],
      pagination: {
        total: 2,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 1,
      },
    });

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDeleteBundlesMutation(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        bundleIds: [bundle.id, otherBundle.id],
      });
    });

    expect(
      queryClient.getQueryData(queryKeys.bundle(bundle.id)),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.bundle(otherBundle.id)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.bundles.list(filters))).toEqual({
      data: [],
      pagination: {
        total: 2,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 1,
      },
    });
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.bundles.all,
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.bundleChildren.all,
    });

    queryClient.clear();
  });
});
