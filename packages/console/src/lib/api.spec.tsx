import type { Bundle } from "@hot-updater/plugin-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  queryKeys,
  useBundleEventAnalyticsQuery,
  useBundleEventSummaryQuery,
  useCreateChannelMutation,
  useDeleteChannelMutation,
  useDeleteBundleMutation,
  useDeleteBundlesMutation,
  useUpdateBundleMutation,
} from "./api";
import {
  createChannel as createChannelApi,
  deleteChannel as deleteChannelApi,
  deleteBundle as deleteBundleApi,
  getBundleEventAnalytics as getBundleEventAnalyticsApi,
  deleteBundles as deleteBundlesApi,
  getBundleEventSummary as getBundleEventSummaryApi,
  updateBundle as updateBundleApi,
} from "./api-rpc";

vi.mock("./api-rpc", () => ({
  createBundle: vi.fn(),
  createChannel: vi.fn(),
  deleteBundle: vi.fn(),
  deleteChannel: vi.fn(),
  deleteBundles: vi.fn(),
  getBundle: vi.fn(),
  getBundleChildCounts: vi.fn(),
  getBundleChildren: vi.fn(),
  getBundleEventSummary: vi.fn(),
  getBundleEventAnalytics: vi.fn(),
  getBundles: vi.fn(),
  getChannels: vi.fn(),
  getConfig: vi.fn(),
  getConfigLoaded: vi.fn(),
  promoteBundle: vi.fn(),
  updateBundle: vi.fn(),
}));

const bundle: Bundle = {
  id: "bundle-001",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  gitCommitHash: null,
  message: null,
  storageUri: "s3://bucket/bundle.zip",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
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

describe("protected bundle-event queries", () => {
  it("does not request a bundle-event summary when explicitly disabled", async () => {
    // Given
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    // When
    renderHook(() => useBundleEventSummaryQuery(bundle.id, false), { wrapper });
    await Promise.resolve();

    // Then
    expect(getBundleEventSummaryApi).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("does not request bundle-event analytics when explicitly disabled", async () => {
    // Given
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    // When
    renderHook(
      () =>
        useBundleEventAnalyticsQuery(
          { bundleId: bundle.id, window: "30d" },
          false,
        ),
      { wrapper },
    );
    await Promise.resolve();

    // Then
    expect(getBundleEventAnalyticsApi).not.toHaveBeenCalled();
    queryClient.clear();
  });
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

describe("useUpdateBundleMutation", () => {
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

  it("does not wait for background invalidations after updating cached bundle data", async () => {
    const updatedBundle = {
      ...bundle,
      enabled: false,
    };
    vi.mocked(updateBundleApi).mockResolvedValue({
      success: true,
      bundle: updatedBundle,
    });
    const invalidateQueries = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockImplementation(() => new Promise<never>(() => {}));

    queryClient.setQueryData(queryKeys.bundle(bundle.id), bundle);
    queryClient.setQueryData(queryKeys.bundles.list({}), {
      data: [bundle],
      pagination: {
        total: 1,
        hasNextPage: false,
        hasPreviousPage: false,
        currentPage: 1,
        totalPages: 1,
      },
    });

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateBundleMutation(), {
      wrapper,
    });

    let mutation: Promise<unknown> | undefined;
    act(() => {
      mutation = result.current.mutateAsync({
        bundleId: bundle.id,
        bundle: {
          enabled: false,
        },
      });
    });

    await expect(
      Promise.race([mutation!.then(() => "resolved"), timeout(20)]),
    ).resolves.toBe("resolved");

    expect(queryClient.getQueryData(queryKeys.bundle(bundle.id))).toEqual(
      updatedBundle,
    );
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.bundles.all,
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
  it("removes a batch from cached lists and invalidates once", async () => {
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

    const filters = { channel: "development", limit: "2000" };
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
    expect(invalidateQueries).toHaveBeenCalledTimes(3);
  });
});
