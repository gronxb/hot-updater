import type { RpcType } from '@/src-server/rpc';
import { hc } from 'hono/client';

export const api = hc<RpcType>('/rpc');

import {
  createMutation,
  createQuery,
  useQueryClient,
} from '@tanstack/solid-query';
import type { Accessor } from 'solid-js';

const DEFAULT_CHANNEL = 'production';

export const createBundlesQuery = (
  query: Accessor<Parameters<typeof api.bundles.$get>[0]['query']>,
) =>
  createQuery(() => ({
    queryKey: ['bundles', query()],
    queryFn: async () => {
      const res = await api.bundles.$get({ query: query() });
      return res.json();
    },
    placeholderData: (prev) => prev,
    staleTime: Number.POSITIVE_INFINITY,
  }));

export const createBundleQuery = (bundleId: string) =>
  createQuery(() => ({
    queryKey: ['bundle', bundleId],
    queryFn: () => {
      return api.bundles[':bundleId']
        .$get({ param: { bundleId } })
        .then((res) => res.json());
    },
    placeholderData: (prev) => {
      return prev;
    },
    staleTime: Number.POSITIVE_INFINITY,
  }));

export const createConfigQuery = () =>
  createQuery(() => ({
    queryKey: ['config'],
    queryFn: () => api.config.$get().then((res) => res.json()),
    staleTime: Number.POSITIVE_INFINITY,
    retryOnMount: false,
  }));

export const createChannelsQuery = () =>
  createQuery(() => ({
    queryKey: ['channels'],
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

export const createBundleDeleteMutation = () => {
  const queryClient = useQueryClient();

  return createMutation<{ success: boolean }, Error, string>(() => ({
    mutationFn: async (bundleId: string) => {
      const response = await api.bundles[':bundleId'].$delete({
        param: { bundleId },
      });
      if (!response.ok) {
        throw new Error(`Failed to delete bundle: ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bundles'] });
    },
  }));
};

// Native builds API functions
export const createNativeBuildsQuery = (
  query: Accessor<Parameters<typeof api['native-builds']['$get']>[0]['query']>,
) =>
  createQuery(() => ({
    queryKey: ['native-builds', query()],
    queryFn: async () => {
      const res = await api['native-builds'].$get({ query: query() });
      const data = await res.json();
      // Parse dates in the response
      if (data && data.data) {
        data.data = data.data.map((item: any) => ({
          ...item,
          createdAt: new Date(item.createdAt),
        }));
      }
      return data;
    },
    placeholderData: (prev) => prev,
    staleTime: Number.POSITIVE_INFINITY,
  }));

export const createNativeBuildQuery = (nativeBuildId: string) =>
  createQuery(() => ({
    queryKey: ['native-build', nativeBuildId],
    queryFn: async () => {
      const res = await api['native-builds'][':nativeBuildId']
        .$get({ param: { nativeBuildId } });
      const data = await res.json();
      // No date parsing needed since createdAt was removed
      return data;
    },
    placeholderData: (prev) => {
      return prev;
    },
    staleTime: Number.POSITIVE_INFINITY,
  }));

export const createNativeBuildDownloadUrlQuery = (nativeBuildId: string) =>
  createQuery(() => ({
    queryKey: ['native-build-download', nativeBuildId],
    queryFn: async () => {
      const res = await api['native-builds'][':nativeBuildId']['download']
        .$get({ param: { nativeBuildId } });
      return res.json();
    },
    enabled: !!nativeBuildId,
    staleTime: 5 * 60 * 1000, // 5 minutes for download URLs
  }));

export const createNativeBuildDeleteMutation = () => {
  const queryClient = useQueryClient();

  return createMutation<{ success: boolean }, Error, string>(() => ({
    mutationFn: async (nativeBuildId: string) => {
      const response = await api['native-builds'][':nativeBuildId'].$delete({
        param: { nativeBuildId },
      });
      if (!response.ok) {
        throw new Error(`Failed to delete native build: ${response.status}`);
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['native-builds'] });
    },
  }));
};
