import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createApiKeyRpc,
  listApiKeysRpc,
  revokeApiKeyRpc,
} from "./api-keys-rpc";

export const apiKeyQueryKeys = {
  list: ["api-keys", "list"] as const,
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
