import type { Bundle } from "@hot-updater/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import type { Accessor } from "solid-js";

const DEFAULT_CHANNEL = "production";

/**
 * Get the base path for API calls.
 * This value is injected by the server into the HTML via window.__HOT_UPDATER_BASE_PATH__
 * This enables SSOT - the basePath is configured only in createHotUpdater({ consolePath: "/console" })
 */
declare global {
  interface Window {
    __HOT_UPDATER_BASE_PATH__?: string;
  }
}

const getBasePath = (): string => {
  if (typeof window !== "undefined" && window.__HOT_UPDATER_BASE_PATH__) {
    return window.__HOT_UPDATER_BASE_PATH__;
  }
  return "";
};

interface BundlesQuery {
  channel?: string;
  platform?: "ios" | "android";
  limit?: string;
  offset?: string;
}

interface ConfigResponse {
  console: {
    port: number;
    gitUrl?: string;
  };
}

interface PaginationInfo {
  total: number;
  totalPages: number;
  currentPage: number;
  limit: number;
  offset: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

interface BundlesResponse {
  data: Bundle[];
  pagination: PaginationInfo;
}

// Helper function to build query string
const buildQueryString = (params: Record<string, string | undefined>) => {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, value);
    }
  }
  const queryString = searchParams.toString();
  return queryString ? `?${queryString}` : "";
};

// API client functions
const api = {
  bundles: {
    $get: async (options: { query: BundlesQuery }) => {
      const basePath = getBasePath();
      const query = buildQueryString(options.query as Record<string, string>);
      const res = await fetch(`${basePath}/bundles${query}`);
      return { json: () => res.json() as Promise<BundlesResponse> };
    },
    $post: async (bundle: Bundle) => {
      const basePath = getBasePath();
      const res = await fetch(`${basePath}/bundles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });
      return { ok: res.ok, json: () => res.json(), status: res.status };
    },
  },
  bundle: {
    $get: async (bundleId: string) => {
      const basePath = getBasePath();
      const res = await fetch(`${basePath}/bundles/${bundleId}`);
      return { json: () => res.json() as Promise<Bundle | null> };
    },
    $delete: async (bundleId: string) => {
      const basePath = getBasePath();
      const res = await fetch(`${basePath}/bundles/${bundleId}`, {
        method: "DELETE",
      });
      return { ok: res.ok, json: () => res.json(), status: res.status };
    },
    $patch: async (bundleId: string, data: Partial<Bundle>) => {
      const basePath = getBasePath();
      const res = await fetch(`${basePath}/bundles/${bundleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return { ok: res.ok, json: () => res.json(), status: res.status };
    },
  },
  config: {
    $get: async () => {
      const basePath = getBasePath();
      const res = await fetch(`${basePath}/config`);
      return { json: () => res.json() as Promise<ConfigResponse> };
    },
  },
  channels: {
    $get: async () => {
      const basePath = getBasePath();
      const res = await fetch(`${basePath}/channels`);
      return { json: () => res.json() as Promise<string[]> };
    },
  },
};

export const useBundlesQuery = (query: Accessor<BundlesQuery>) =>
  useQuery(() => ({
    queryKey: ["bundles", query()],
    queryFn: async () => {
      const res = await api.bundles.$get({ query: query() });
      return res.json();
    },
    placeholderData: (prev) => prev,
    staleTime: Number.POSITIVE_INFINITY,
  }));

export const useBundleQuery = (bundleId: string) =>
  useQuery(() => ({
    queryKey: ["bundle", bundleId],
    queryFn: () => {
      return api.bundle.$get(bundleId).then((res) => res.json());
    },
    placeholderData: (prev) => {
      return prev;
    },
    staleTime: Number.POSITIVE_INFINITY,
  }));

export const useConfigQuery = () =>
  useQuery(() => ({
    queryKey: ["config"],
    queryFn: () => api.config.$get().then((res) => res.json()),
    staleTime: Number.POSITIVE_INFINITY,
    retryOnMount: false,
  }));

export const useChannelsQuery = () =>
  useQuery(() => ({
    queryKey: ["channels"],
    queryFn: () => api.channels.$get().then((res) => res.json()),
    staleTime: Number.POSITIVE_INFINITY,
    retryOnMount: false,
    select: (data) => {
      if (!data || data.length === 0) {
        return null;
      }

      if (data.includes(DEFAULT_CHANNEL)) {
        return [
          DEFAULT_CHANNEL,
          ...data.filter((channel) => channel !== DEFAULT_CHANNEL),
        ];
      }

      return data;
    },
  }));

export const useBundleDeleteMutation = () => {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean }, Error, string>(() => ({
    mutationFn: async (bundleId: string) => {
      const response = await api.bundle.$delete(bundleId);
      if (!response.ok) {
        throw new Error(`Failed to delete bundle: ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bundles"] });
    },
  }));
};

export const useBundleUpdateMutation = () => {
  const queryClient = useQueryClient();

  return useMutation<
    { success: boolean },
    Error,
    { bundleId: string; data: Partial<Bundle> }
  >(() => ({
    mutationFn: async ({ bundleId, data }) => {
      const response = await api.bundle.$patch(bundleId, data);
      if (!response.ok) {
        throw new Error(`Failed to update bundle: ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bundles"] });
      queryClient.invalidateQueries({ queryKey: ["bundle"] });
    },
  }));
};

export const useBundleCreateMutation = () => {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; bundleId: string }, Error, Bundle>(
    () => ({
      mutationFn: async (bundle) => {
        const res = await api.bundles.$post(bundle);
        if (!res.ok) {
          const json = await res.json();
          throw new Error(
            json.error || `Failed to create bundle: ${res.status}`,
          );
        }
        return res.json();
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["bundles"] });
        queryClient.invalidateQueries({ queryKey: ["channels"] });
      },
    }),
  );
};
