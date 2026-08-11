import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import {
  createClientAccessKeyRpc,
  getClientAccessKeyCapabilityRpc,
  listClientAccessKeysRpc,
  revokeClientAccessKeyRpc,
} from "./access-keys-rpc";

export const clientAccessKeyQueryKeys = {
  capability: ["client-access-keys", "capability"] as const,
  list: ["client-access-keys", "list"] as const,
};

export const getClientAccessKeyCapabilityQueryOptions = () => ({
  queryKey: clientAccessKeyQueryKeys.capability,
  queryFn: () => getClientAccessKeyCapabilityRpc(),
  staleTime: Infinity,
});

export const useClientAccessKeyCapabilityQuery = () =>
  useQuery(getClientAccessKeyCapabilityQueryOptions());

export const ensureClientAccessKeyRouteAccess = async (
  queryClient: QueryClient,
): Promise<void> => {
  const capability = await queryClient.ensureQueryData(
    getClientAccessKeyCapabilityQueryOptions(),
  );
  if (!capability.accessKeys) {
    throw redirect({
      to: "/",
      search: {
        channel: undefined,
        platform: undefined,
        page: undefined,
        after: undefined,
        before: undefined,
        bundleId: undefined,
        expandedBundleId: undefined,
      },
      replace: true,
    });
  }
};

export const useClientAccessKeysQuery = () =>
  useQuery({
    queryKey: clientAccessKeyQueryKeys.list,
    queryFn: () => listClientAccessKeysRpc(),
  });

export const useCreateClientAccessKeyMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createClientAccessKeyRpc({ data: { name } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: clientAccessKeyQueryKeys.list,
      });
    },
  });
};

export const useRevokeClientAccessKeyMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeClientAccessKeyRpc({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: clientAccessKeyQueryKeys.list,
      });
    },
  });
};
