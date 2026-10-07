import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type { RemoteConfigTemplate } from "./remote-config-draft";
import {
  getRemoteConfigRpc,
  getRemoteConfigVersionRpc,
  listRemoteConfigVersionsRpc,
  previewRemoteConfigRpc,
  publishRemoteConfigRpc,
  rollbackRemoteConfigRpc,
} from "./remote-config-rpc";

export const remoteConfigQueryKeys = {
  all: ["remote-config"] as const,
  active: ["remote-config", "active"] as const,
  versions: ["remote-config", "versions"] as const,
  version: (version: number) => ["remote-config", "version", version] as const,
  preview: (input: unknown) => ["remote-config", "preview", input] as const,
};

/** The published template, read once a visit unless a publish changes it. */
export const useRemoteConfigQuery = () =>
  useQuery({
    queryKey: remoteConfigQueryKeys.active,
    queryFn: () => getRemoteConfigRpc(),
    staleTime: 60_000,
  });

/** Published versions, newest first, a page at a time. */
export const useRemoteConfigVersionsQuery = ({
  enabled,
}: {
  readonly enabled: boolean;
}) =>
  useInfiniteQuery({
    queryKey: remoteConfigQueryKeys.versions,
    queryFn: ({ pageParam }) =>
      listRemoteConfigVersionsRpc({
        data: pageParam === undefined ? {} : { cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next,
    staleTime: 60_000,
    enabled,
  });

/** One version with its template; a version never changes once published. */
export const useRemoteConfigVersionQuery = (version: number | null) =>
  useQuery({
    queryKey: remoteConfigQueryKeys.version(version ?? 0),
    queryFn: () => getRemoteConfigVersionRpc({ data: { version: version! } }),
    enabled: version !== null,
    staleTime: Infinity,
  });

const useRefreshAfterPublish = () => {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: remoteConfigQueryKeys.active }),
      queryClient.invalidateQueries({
        queryKey: remoteConfigQueryKeys.versions,
      }),
    ]);
  };
};

export const usePublishRemoteConfigMutation = () => {
  const refresh = useRefreshAfterPublish();
  return useMutation({
    mutationFn: (input: {
      readonly template: RemoteConfigTemplate;
      readonly baseVersion: number;
      readonly description?: string;
    }) => publishRemoteConfigRpc({ data: input }),
    onSuccess: async (result) => {
      if (result.status === "published" || result.status === "conflict") {
        await refresh();
      }
    },
  });
};

export const useRollbackRemoteConfigMutation = () => {
  const refresh = useRefreshAfterPublish();
  return useMutation({
    mutationFn: (input: {
      readonly version: number;
      readonly baseVersion: number;
    }) => rollbackRemoteConfigRpc({ data: input }),
    onSuccess: refresh,
  });
};

/** A device's view of the draft, kept on screen while the next one loads. */
export const useRemoteConfigPreviewQuery = (input: {
  readonly template: RemoteConfigTemplate;
  /** The device's fields, and `now` to evaluate at a chosen time. */
  readonly context: {
    readonly platform?: string;
    readonly channel?: string;
    readonly appVersion?: string;
    readonly cohort?: string;
    readonly fingerprintHash?: string;
    readonly now?: number;
  };
}) =>
  useQuery({
    queryKey: remoteConfigQueryKeys.preview(input),
    queryFn: () => previewRemoteConfigRpc({ data: input }),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
