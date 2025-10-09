import { hc } from "hono/client";
import type { RpcType } from "@/src-server/rpc";

export const api = hc<RpcType>("/rpc");

import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import type { Accessor } from "solid-js";

const DEFAULT_CHANNEL = "production";

export const useBundlesQuery = (
  query: Accessor<Parameters<typeof api.bundles.$get>[0]["query"]>,
) =>
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
      return api.bundles[":bundleId"]
        .$get({ param: { bundleId } })
        .then((res) => res.json());
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
      const response = await api.bundles[":bundleId"].$delete({
        param: { bundleId },
      });
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
