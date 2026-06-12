import type { Bundle } from "@hot-updater/plugin-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  queryKeys,
  useDeleteBundleMutation,
  useUpdateBundleMutation,
} from "./api";
import {
  deleteBundle as deleteBundleApi,
  updateBundle as updateBundleApi,
} from "./api-rpc";

vi.mock("./api-rpc", () => ({
  createBundle: vi.fn(),
  deleteBundle: vi.fn(),
  getBundle: vi.fn(),
  getBundleChildCounts: vi.fn(),
  getBundleChildren: vi.fn(),
  getBundleDownloadUrl: vi.fn(),
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
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.channels,
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
    expect(invalidateQueries).toHaveBeenCalledTimes(3);
  });
});
