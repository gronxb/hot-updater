import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import {
  createApiKeyRpc,
  getApiKeyCapabilityRpc,
  listApiKeysRpc,
  revokeApiKeyRpc,
} from "./api-keys-rpc";

export const apiKeyQueryKeys = {
  capability: ["api-keys", "capability"] as const,
  list: ["api-keys", "list"] as const,
};

export const getApiKeyCapabilityQueryOptions = () => ({
  queryKey: apiKeyQueryKeys.capability,
  queryFn: () => getApiKeyCapabilityRpc(),
  staleTime: Infinity,
});

export const useApiKeyCapabilityQuery = () =>
  useQuery(getApiKeyCapabilityQueryOptions());

export const ensureApiKeyRouteAccess = async (
  queryClient: QueryClient,
): Promise<void> => {
  const capability = await queryClient.ensureQueryData(
    getApiKeyCapabilityQueryOptions(),
  );
  if (!capability.apiKeys) {
    throw redirect({
      to: "/",
      search: {},
      replace: true,
    });
  }
};

export const useApiKeysQuery = () =>
  useQuery({
    queryKey: apiKeyQueryKeys.list,
    queryFn: () => listApiKeysRpc(),
  });

export const useCreateApiKeyMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createApiKeyRpc({ data: { name } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: apiKeyQueryKeys.list,
      });
    },
  });
};

export const useRevokeApiKeyMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeApiKeyRpc({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: apiKeyQueryKeys.list,
      });
    },
  });
};
