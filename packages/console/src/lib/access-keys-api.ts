import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

import {
  createManagedAccessKeyRpc,
  getManagedAccessKeyCapabilityRpc,
  listManagedAccessKeysRpc,
  revokeManagedAccessKeyRpc,
} from "./access-keys-rpc";

export const managedAccessKeyQueryKeys = {
  capability: ["managed-access-keys", "capability"] as const,
  list: ["managed-access-keys", "list"] as const,
};

export const getManagedAccessKeyCapabilityQueryOptions = () => ({
  queryKey: managedAccessKeyQueryKeys.capability,
  queryFn: () => getManagedAccessKeyCapabilityRpc(),
  staleTime: Infinity,
});

export const useManagedAccessKeyCapabilityQuery = () =>
  useQuery(getManagedAccessKeyCapabilityQueryOptions());

export const ensureManagedAccessKeyRouteAccess = async (
  queryClient: QueryClient,
): Promise<void> => {
  const capability = await queryClient.ensureQueryData(
    getManagedAccessKeyCapabilityQueryOptions(),
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

export const useManagedAccessKeysQuery = () =>
  useQuery({
    queryKey: managedAccessKeyQueryKeys.list,
    queryFn: () => listManagedAccessKeysRpc(),
  });

export const useCreateManagedAccessKeyMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createManagedAccessKeyRpc({ data: { name } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: managedAccessKeyQueryKeys.list,
      });
    },
  });
};

export const useRevokeManagedAccessKeyMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeManagedAccessKeyRpc({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: managedAccessKeyQueryKeys.list,
      });
    },
  });
};
