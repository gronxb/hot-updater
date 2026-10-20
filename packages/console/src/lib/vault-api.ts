import type {
  VaultSecretKind,
  VaultTokenScope,
} from "@hot-updater/server/plugins";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  getVaultKeysRpc,
  getVaultStatusRpc,
  issueVaultTokenRpc,
  listVaultSecretsRpc,
  listVaultTokensRpc,
  putVaultSecretRpc,
  removeVaultSecretRpc,
  revokeVaultTokenRpc,
  rewrapVaultRpc,
} from "./vault-rpc";

export const vaultQueryKeys = {
  status: ["vault", "status"] as const,
  secrets: ["vault", "secrets"] as const,
  tokens: ["vault", "tokens"] as const,
  keys: ["vault", "keys"] as const,
};

/**
 * Whether the console holds a master key. It changes only with a redeploy,
 * so it reads nothing from the database and is checked again after a while,
 * when asked, and after a refused write.
 */
export const useVaultStatusQuery = () =>
  useQuery({
    queryKey: vaultQueryKeys.status,
    queryFn: () => getVaultStatusRpc(),
    staleTime: 5 * 60_000,
  });

/** The secrets without values, read once a visit unless a write changes them. */
export const useVaultSecretsQuery = () =>
  useQuery({
    queryKey: vaultQueryKeys.secrets,
    queryFn: () => listVaultSecretsRpc(),
    staleTime: 5 * 60_000,
  });

/** Vault tokens, newest first, revoked and expired ones too. */
export const useVaultTokensQuery = ({
  enabled = true,
}: { readonly enabled?: boolean } = {}) =>
  useQuery({
    queryKey: vaultQueryKeys.tokens,
    queryFn: () => listVaultTokensRpc(),
    staleTime: 5 * 60_000,
    enabled,
  });

/** The master keys and the versions under each, read once their tab opens. */
export const useVaultKeysQuery = ({
  enabled = true,
}: { readonly enabled?: boolean } = {}) =>
  useQuery({
    queryKey: vaultQueryKeys.keys,
    queryFn: () => getVaultKeysRpc(),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    enabled,
  });

/**
 * Rewraps batch after batch until no version is left under another key,
 * or the rest are under keys the console does not hold. Each batch's
 * count reaches `onProgress`, so the page counts down.
 */
export const useRewrapVaultMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      onProgress,
    }: {
      readonly onProgress: (remaining: number) => void;
    }) => {
      let rewrapped = 0;
      for (;;) {
        const batch = await rewrapVaultRpc();
        rewrapped += batch.rewrapped;
        onProgress(batch.remaining);
        if (batch.remaining === 0 || batch.rewrapped === 0) {
          return { rewrapped, remaining: batch.remaining };
        }
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: vaultQueryKeys.keys }),
        queryClient.invalidateQueries({ queryKey: vaultQueryKeys.status }),
      ]);
    },
  });
};

export const usePutVaultSecretMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly name: string;
      readonly kind: VaultSecretKind;
      readonly value: unknown;
      readonly expectedVersion: number;
    }) => putVaultSecretRpc({ data: input }),
    // A refused write may mean the list is stale, such as a version
    // conflict, or that a redeploy removed the master key.
    onSettled: async (_data, error) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: vaultQueryKeys.secrets }),
        // A write adds a version under the active key.
        queryClient.invalidateQueries({ queryKey: vaultQueryKeys.keys }),
        error === null
          ? undefined
          : queryClient.invalidateQueries({ queryKey: vaultQueryKeys.status }),
      ]);
    },
  });
};

export const useRemoveVaultSecretMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (secret: { readonly id: string; readonly version: number }) =>
      removeVaultSecretRpc({
        data: { id: secret.id, expectedVersion: secret.version },
      }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: vaultQueryKeys.secrets }),
        queryClient.invalidateQueries({ queryKey: vaultQueryKeys.keys }),
      ]);
    },
  });
};

export const useIssueVaultTokenMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      readonly name: string;
      readonly scope: VaultTokenScope;
      readonly expiresAtMs?: number;
    }) => issueVaultTokenRpc({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vaultQueryKeys.tokens });
    },
  });
};

export const useRevokeVaultTokenMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeVaultTokenRpc({ data: { id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: vaultQueryKeys.tokens });
    },
  });
};
